const SELECTOR_TIMEOUT_MS = 60_000

export async function waitForSelector(page, selector, timeout = SELECTOR_TIMEOUT_MS) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

export function clickInDialogInPage(target) {
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) return { clicked: false, reason: 'no-dialog' }
  const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
  let node = null
  if (typeof target.selector === 'string' && target.selector !== '') {
    node = dialog.querySelector(target.selector)
  } else if (Array.isArray(target.labels) && target.labels.length > 0) {
    const wanted = target.labels.map(strip)
    node = [...dialog.querySelectorAll('button, [role="button"], a')].find((candidate) =>
      wanted.includes(strip(candidate.textContent)),
    )
  }
  if (!node) return { clicked: false, reason: 'no-matching-node' }
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return { clicked: false, reason: 'not-laid-out' }
  node.click()
  return { clicked: true, reason: null, text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) }
}

export async function clickInDialog(page, target) {
  return await page.evaluate(clickInDialogInPage, target)
}

export async function dismissOpenDialog(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const dialogGone = async () =>
    await page
      .waitForFunction(() => document.querySelector('[role="dialog"]') === null, { timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
  if (!(await page.$('[role="dialog"]'))) return true
  const closed = await clickInDialog(page, {
    selector: '[aria-label="关闭"], [aria-label="Close"]',
  })
  if (closed.clicked && (await dialogGone())) return true
  if (Array.isArray(options.labels) && options.labels.length > 0) {
    const labelled = await clickInDialog(page, { labels: options.labels })
    if (labelled.clicked && (await dialogGone())) return true
  }
  await page.keyboard.press('Escape').catch(() => {})
  return await dialogGone()
}

export async function openManageWindow(page) {
  await waitForSelector(page, '#drg-host-row', 120_000)
  const opened = await page.evaluate(() => {
    const row = document.getElementById('drg-host-row')
    if (!row) return { error: 'the switcher row is missing' }
    row.click()
    const item = row.querySelector('.drg-hr-item[data-action="manage"]')
    if (!item) return { error: 'the switcher menu has no manage row' }
    item.click()
    return { ok: true }
  })
  if (!opened.ok) throw new Error(`could not open host management: ${opened.error}`)
  await waitForSelector(page, '[data-testid="manage-window"] [role="dialog"]')
  await waitForSelector(page, '[data-testid="host-list-empty"], [data-testid="host-list"]')
}

export async function closeManageWindow(page) {
  await page.evaluate(() => {
    const win = document.querySelector('[data-testid="manage-window"]')
    const close = win ? win.querySelector('.drg-modal-head button') : null
    if (close) close.click()
  })
  await page.waitForFunction(() => !document.querySelector('[data-testid="manage-window"]'), { timeout: 20_000 })
}

export async function applyColorScheme(page, scheme, previousBodyBackground) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
  await page.waitForFunction(
    (value) => matchMedia(`(prefers-color-scheme: ${value})`).matches,
    { timeout: 20_000 },
    scheme,
  )
  if (previousBodyBackground) {
    await page
      .waitForFunction(
        (previous) => getComputedStyle(document.body).backgroundColor !== previous,
        { timeout: 20_000 },
        previousBodyBackground,
      )
      .catch(() => {})
  }
}
