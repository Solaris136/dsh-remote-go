import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import puppeteer from 'puppeteer-core'
import { resolveBrowser, skipOrFail } from './harness-support.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const requireFromHere = createRequire(import.meta.url)
const React = requireFromHere('react')

/** Load the built client just far enough to read the scripts it injects into a guest. */
function loadScripts() {
  const source = readFileSync(path.join(REPO_ROOT, 'dist', 'client.js'), 'utf8')
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  sandbox.window = {
    innerHeight: 800,
    __ModuleLoader__: {
      load(declaration) {
        sandbox.__declaration = declaration
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(sandbox.__declaration, 'client.js must call window.__ModuleLoader__.load')
  const plugin = sandbox.__declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'client.js may only require react')
    return React
  })
  return plugin.carrier
}

test('the guest download bridge queues one intent and closes the menu', async (t) => {
  const browserPath = resolveBrowser()
  if (!browserPath) {
    skipOrFail(t, 'no Chrome/Edge found: set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH')
    return
  }
  const scripts = loadScripts()
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--disable-gpu',
      // Hosted Ubuntu runners restrict unprivileged user namespaces; other platforms
      // keep the sandbox (same policy as web.e2e / browser-carrier).
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(`<!doctype html><html lang="en"><body>
      <ul role="tree">
        <li data-files-entry="file" data-files-path="/home/ubuntu/report.md">
          <button type="button">report.md</button>
        </li>
        <li data-files-entry="directory" data-files-path="/home/ubuntu/project">
          <button type="button">project</button>
        </li>
      </ul>
      <div role="menu" data-context-menu>
        <button type="button" role="menuitem" id="download">
          <svg data-icon="dsw-icon-download-outline-regular"></svg>
          <span>Download</span>
        </button>
      </div>
    </body></html>`)
    const installed = await page.evaluate(scripts.guestTools())
    assert.equal(installed, 'installed')
    const result = await page.evaluate(() => {
      let pageHandlerCalls = 0
      document.getElementById('download').addEventListener('click', () => {
        pageHandlerCalls += 1
      })
      const row = document.querySelector('li[data-files-path]')
      row
        .querySelector('button')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      const item = document.getElementById('download')
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      item.dispatchEvent(click)
      const menu = document.querySelector('[role="menu"]')
      return {
        queue: window.__drgBridgeQueue || [],
        pageHandlerCalls,
        prevented: click.defaultPrevented,
        menuHidden: menu !== null && menu.style.display === 'none',
      }
    })
    assert.deepEqual(result.queue, [
      { action: 'download-file', kind: 'file', path: '/home/ubuntu/report.md', name: 'report.md' },
    ])
    assert.equal(result.pageHandlerCalls, 0, 'the page’s own Blob download must not run')
    assert.equal(result.prevented, true)
    assert.equal(result.menuHidden, true, 'the menu must not stay on screen after the interception')

    // The next context menu restores the hidden surface before the page reopens it.
    const restored = await page.evaluate(() => {
      document
        .querySelector('li[data-files-path] button')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      return document.querySelector('[role="menu"]').style.display === ''
    })
    assert.equal(restored, true)

    // Keyboard users get the same interception: ContextMenu opens, Enter downloads.
    const keyboard = await page.evaluate(() => {
      const button = document.querySelector('li[data-files-path] button')
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      document.getElementById('download').dispatchEvent(enter)
      return {
        queue: window.__drgBridgeQueue || [],
        prevented: enter.defaultPrevented,
        menuHidden: document.querySelector('[role="menu"]').style.display === 'none',
      }
    })
    assert.equal(keyboard.queue.length, 2)
    assert.equal(keyboard.prevented, true)
    assert.equal(keyboard.menuHidden, true)

    // A directory has no native download item; the injected one queues a folder job.
    const directory = await page.evaluate(async () => {
      const row = document.querySelector('li[data-files-entry="directory"]')
      row
        .querySelector('button')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const injected = document.querySelector('[data-drg-dir-download]')
        if (injected) {
          injected.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          return {
            label: (injected.textContent ?? '').trim(),
            queue: window.__drgBridgeQueue || [],
            menuHidden: document.querySelector('[role="menu"]').style.display === 'none',
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return { missing: true, queue: window.__drgBridgeQueue || [] }
    })
    assert.equal(directory.missing, undefined)
    assert.equal(directory.label, 'Download to this computer')
    assert.deepEqual(directory.queue.at(-1), {
      action: 'download-file',
      kind: 'directory',
      path: '/home/ubuntu/project',
      name: 'project',
    })
    assert.equal(directory.queue.length, 3)
    assert.equal(directory.menuHidden, true)
  } finally {
    await browser.close()
  }
})
