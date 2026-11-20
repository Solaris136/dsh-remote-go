/* Shared bootstrap for the integration suites that drive the built client in a real browser: the Chromium launch
 * options every suite records, the React bundle and built artifact their harness pages load, page-error collection,
 * and the ephemeral loopback server that serves them. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT_PATH = path.join(REPO_ROOT, 'dist', 'client.js')
// Hosted Ubuntu runners restrict unprivileged user namespaces; other platforms keep Chromium's own sandbox.
const SANDBOX_ARGS = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
const BASE_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-gpu']

/** The built client artifact every browser suite serves from `dist/client.js`. */
export function readClientArtifact() {
  return readFileSync(CLIENT_PATH)
}

/** Launch the E2E Chromium with the recorded arguments and open its first page; `close` tears it down in a `finally`. */
export async function openBrowserPage(browserPath, options = {}) {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: options.headless ?? 'new',
    ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
    args: [...BASE_ARGS, ...(options.args ?? []), ...SANDBOX_ARGS],
  })
  const page = await browser.newPage()
  return { browser, page, close: () => browser.close() }
}

/** Bundle the real React runtime as an IIFE so a harness page uses hooks the way the shell does. */
export async function buildReactBundle() {
  const esbuild = await import('esbuild')
  return (
    await esbuild.build({
      stdin: {
        contents: `import React from 'react'
import { createRoot } from 'react-dom/client'
window.React = React
window.ReactDOM = { createRoot }`,
        resolveDir: REPO_ROOT,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      logLevel: 'silent',
    })
  ).outputFiles[0].text
}

/** Answer `/react.js` (the React IIFE) or `/client.js` (the built artifact); false leaves the request to the caller. */
export function serveClientAsset(pathname, res, reactBundle) {
  if (pathname !== '/react.js' && pathname !== '/client.js') return false
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
  res.end(pathname === '/react.js' ? reactBundle : readClientArtifact())
  return true
}

/** Serve `pathname -> HTML` harness pages plus the shared assets on an ephemeral loopback port. */
export async function serveHarness(pages, options = {}) {
  const reactBundle = await buildReactBundle()
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (serveClientAsset(pathname, res, reactBundle)) return
    // Not every path is a page: proxy routes and a request a test deliberately leaves hanging go through `onRequest`.
    if (options.onRequest?.(req, res, pathname) === true) return
    if (!Object.hasOwn(pages, pathname)) {
      res.writeHead(404)
      res.end()
      return
    }
    const page = pages[pathname]
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(typeof page === 'function' ? page() : page)
  })
  const port = await listenOnFreePort(server)
  return { port, close: () => closeServer(server) }
}

/** Listen on an ephemeral loopback port; resolves with the port it got. */
export function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

/** Close a harness server; resolves after the listener has released its port. */
export function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

/** Record this page's console errors and uncaught exceptions; the returned array is what the suite asserts on. */
export function collectPageErrors(page, prefixes = {}) {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${prefixes.console ?? ''}${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`${prefixes.pageError ?? ''}${String(error?.message ?? error)}`))
  return errors
}

/** Assert the page logged nothing; Chromium's own `Failed to load resource` noise is dropped unless asked to keep it. */
export function assertNoPageErrors(errors, options = {}) {
  const kept =
    options.includeResourceErrors === true ? errors : errors.filter((text) => !/Failed to load resource/.test(text))
  assert.deepEqual(kept, [], `${options.label ?? 'page errors'}: ${kept.join(' | ')}`)
}
