/**
 * One activation path for both browser suites.
 *
 * The infra debt this removes: readiness was checked with one locator (often an
 * `*` traversal) while activation used a second one (a tag whitelist, or an
 * `aria-label` fallback), so "the entry is there" and "the entry can be clicked"
 * could disagree — that disagreement produced `found the … entry but could not
 * activate it`. And `element.click()` was trusted, so a click swallowed by a
 * re-render or an overlay only showed up as a downstream timeout.
 *
 * Rules enforced here, for both suites:
 * 1. **One locator.** `activateRowInPage` is used for readiness and activation
 *    (the same `*` traversal), so they cannot disagree.
 * 2. **DOM click, never coordinates.** A coordinate click is silently swallowed by
 *    any overlay; the node click plus the `elementFromPoint` check makes that
 *    visible (and reports it as `covered` instead of pretending success).
 * 3. **Verify the effect.** A click only counts once the caller's predicate
 *    (usually "the section mounted") is true; failures are retried with a fresh
 *    locate, and the error carries every attempt's diagnostic.
 * 4. **Actionability is checked** (`aria-disabled`, `pointer-events`, layout box)
 *    before the click: "element present, no handler yet" fails loudly.
 */

/**
 * Locate a row by its normalised text, verify it is clickable, and activate it.
 * Runs inside the page, so it must stay self-contained.
 *
 * The return value is also the diagnostic: what matched, what would be clicked,
 * what covers it, and how many dialogs exist.
 *
 * `within` narrows the traversal to a container (usually the open settings dialog).
 * A label matched globally is ambiguous once the sidebar and a dialog both show the
 * same text — the plugin's sidebar entry and its Settings row are both "Remote
 * hosts" — and the first match in DOM order is the sidebar one, which the dialog's
 * backdrop then reports as `covered`.
 * @param {string[]} rawLabels
 * @param {string | null} [within]
 */
export function activateRowInPage(rawLabels, within = null) {
  const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
  const labels = rawLabels.map(strip)
  const dialogs = document.querySelectorAll('[role="dialog"]').length
  const root = within ? document.querySelector(within) : document
  if (within && !root) return { clicked: false, reason: 'scope-missing', scope: within, dialogs }
  /** @param {Element | null} node */
  const describeNode = (node) => {
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role'),
      testid: node.getAttribute('data-testid'),
      ariaDisabled: node.getAttribute('aria-disabled'),
      pointerEvents: style.pointerEvents,
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      box: { width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  }
  // The same traversal the readiness wait uses: `*`. A tag whitelist here would let
  // readiness and activation disagree, which is exactly the bug this module removes.
  const matches = []
  for (const node of root.querySelectorAll('*')) {
    if (labels.includes(strip(node.textContent))) matches.push(node)
  }
  if (matches.length === 0) return { clicked: false, reason: 'no-matching-node', scope: within, dialogs }
  // Smallest subtree wins: the label node, not every ancestor containing it.
  const row = matches.sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0]
  const clickable = row.closest('button, [role="menuitem"], [role="button"], [role="tab"], a, li') ?? row
  const info = describeNode(clickable)
  if (info.ariaDisabled === 'true' || info.pointerEvents === 'none') {
    return { clicked: false, reason: 'not-actionable', row: info, dialogs }
  }
  if (info.box.width === 0 || info.box.height === 0) {
    return { clicked: false, reason: 'not-laid-out', row: info, dialogs }
  }
  const rect = clickable.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  // Is the element at the click point a **foreign** overlay, or the surface the
  // target itself belongs to? A dialog's own backdrop/chrome resolves to a different
  // node than a button, so a blanket veto refuses to click the dialog's own close
  // affordance and the dialog never dismisses. A hit inside the same dialog is not
  // foreign occlusion: the click is dispatched and then verified by its effect (which
  // is what actually proves it landed). A hit in another dialog/root is foreign.
  const inSameSurface = (target, hitNode) => {
    if (!hitNode || target.contains(hitNode) || hitNode.contains(target)) return true
    const targetDialog = target.closest('[role="dialog"]')
    return targetDialog !== null && targetDialog === hitNode.closest('[role="dialog"]')
  }
  if (!inSameSurface(clickable, hit)) {
    return { clicked: false, reason: 'covered', row: info, coveredBy: describeNode(hit), dialogs }
  }
  clickable.click()
  return { clicked: true, reason: null, row: info, dialogs }
}

/**
 * Activate an element found by `aria-label` (menu buttons), with the same
 * actionability/overlay checks and a DOM click.
 * @param {string[]} rawLabels
 */
export function activateByAriaLabelInPage(rawLabels) {
  const dialogs = document.querySelectorAll('[role="dialog"]').length
  const inSameSurface = (target, hitNode) => {
    if (!hitNode || target.contains(hitNode) || hitNode.contains(target)) return true
    const targetDialog = target.closest('[role="dialog"]')
    return targetDialog !== null && targetDialog === hitNode.closest('[role="dialog"]')
  }
  for (const label of rawLabels) {
    const node = document.querySelector(`[aria-label="${label}"]`)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (node.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') {
      return { clicked: false, reason: 'not-actionable', label, dialogs }
    }
    if (rect.width === 0 || rect.height === 0) return { clicked: false, reason: 'not-laid-out', label, dialogs }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (!inSameSurface(node, hit)) {
      return {
        clicked: false,
        reason: 'covered',
        label,
        coveredBy: { tag: hit.tagName.toLowerCase(), testid: hit.getAttribute('data-testid') },
        dialogs,
      }
    }
    node.click()
    return { clicked: true, reason: null, label, dialogs }
  }
  return { clicked: false, reason: 'no-matching-node', dialogs }
}

/**
 * DOM-click one selector (no coordinates), after the same actionability/overlay
 * checks. Used for controls that have a stable `data-testid`.
 * @param {string} selector
 */
export function clickSelectorInPage(selector) {
  const node = document.querySelector(selector)
  if (!node) return { clicked: false, reason: 'no-matching-node' }
  const rect = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  if (style.pointerEvents === 'none' || node.getAttribute('aria-disabled') === 'true') {
    return { clicked: false, reason: 'not-actionable', selector }
  }
  if (rect.width === 0 || rect.height === 0) return { clicked: false, reason: 'not-laid-out', selector }
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  const sameSurface =
    !hit ||
    node.contains(hit) ||
    hit.contains(node) ||
    (node.closest('[role="dialog"]') !== null && node.closest('[role="dialog"]') === hit.closest('[role="dialog"]'))
  if (!sameSurface) {
    return { clicked: false, reason: 'covered', selector, coveredBy: { tag: hit.tagName.toLowerCase() } }
  }
  node.click()
  return { clicked: true, reason: null, selector }
}

/**
 * Click a control **inside the open dialog** by selector or by its visible text, and
 * let the caller verify the effect (the dialog disappearing). Dialog-local clicks are
 * how a first-run overlay is dismissed without a coordinate click: the node is
 * located, the click is dispatched on it, and the caller waits for the dialog to go.
 * @param {{ selector?: string, labels?: string[] }} target
 */
export function clickInDialogInPage(target) {
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) return { clicked: false, reason: 'no-dialog' }
  const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
  /** @type {Element | null} */
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

/**
 * DOM-click a button inside an open dialog whose visible text is one of `labels`.
 * @param {string[]} rawLabels
 */
export function clickDialogButtonInPage(rawLabels) {
  const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
  const labels = rawLabels.map(strip)
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) return { clicked: false, reason: 'no-dialog' }
  const button = [...dialog.querySelectorAll('button, [role="button"], a')].find((node) =>
    labels.includes(strip(node.textContent)),
  )
  if (!button) return { clicked: false, reason: 'no-matching-button' }
  const rect = button.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return { clicked: false, reason: 'not-laid-out' }
  button.click()
  return { clicked: true, reason: null }
}

/**
 * Is a row with one of these labels present right now?
 *
 * `within` has the same meaning as in `activateRowInPage`: without it, a sidebar
 * entry that happens to share the row's label makes this answer `true` for a surface
 * that is not open.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} labels
 * @param {{ within?: string }} [options]
 */
export async function rowPresent(page, labels, options = {}) {
  const within = options.within ?? null
  return await page
    .evaluate(
      ({ rawLabels, scope }) => {
        const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
        const wanted = rawLabels.map(strip)
        const root = scope ? document.querySelector(scope) : document
        if (!root) return false
        return [...root.querySelectorAll('*')].some((node) => wanted.includes(strip(node.textContent)))
      },
      { rawLabels: labels, scope: within },
    )
    .catch(() => false)
}

/**
 * Wait, bounded, until a row with one of these labels exists (presence only; use
 * `activateRowAndWaitFor` to also verify an activation).
 *
 * With `within`, the wait also covers the container appearing: the poll returns
 * `false` until the scope exists **and** contains the row.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} labels
 * @param {{ timeoutMs?: number, label?: string, within?: string }} [options]
 * @returns {Promise<boolean>} whether it appeared in time.
 */
export async function waitForRow(page, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const within = options.within ?? null
  return await page
    .waitForFunction(
      ({ rawLabels, scope }) => {
        const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
        const wanted = rawLabels.map(strip)
        const root = scope ? document.querySelector(scope) : document
        if (!root) return false
        return [...root.querySelectorAll('*')].some((node) => wanted.includes(strip(node.textContent)))
      },
      { timeout: timeoutMs, polling: 150 },
      { rawLabels: labels, scope: within },
    )
    .then(() => true)
    .catch(() => false)
}

/**
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} labels
 * @param {{ within?: string }} [options]
 */
export async function activateRow(page, labels, options = {}) {
  return await page.evaluate(activateRowInPage, labels, options.within ?? null)
}

/** @param {import('puppeteer-core').Page} page @param {string[]} labels */
export async function activateByAriaLabel(page, labels) {
  return await page.evaluate(activateByAriaLabelInPage, labels)
}

/** @param {import('puppeteer-core').Page} page @param {string} selector */
export async function clickSelector(page, selector) {
  return await page.evaluate(clickSelectorInPage, selector)
}

/** @param {import('puppeteer-core').Page} page @param {string[]} labels */
export async function clickDialogButton(page, labels) {
  return await page.evaluate(clickDialogButtonInPage, labels)
}

/** @param {import('puppeteer-core').Page} page @param {{ selector?: string, labels?: string[] }} target */
export async function clickInDialog(page, target) {
  return await page.evaluate(clickInDialogInPage, target)
}

/**
 * Dismiss the open dialog and **verify the effect**: the click only counts once the
 * dialog is gone. Tries the dialog's own close affordance, then its labelled
 * buttons, then Escape; returns whether the dialog actually closed.
 *
 * This is why a dialog-local click is not "trusting an unverified click": the effect
 * check is right here, and a control that is inside the dialog is not treated as
 * occluded by that same dialog (see the same-surface rule in the page functions).
 * @param {import('puppeteer-core').Page} page
 * @param {{ labels?: string[], timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} whether the dialog is gone.
 */
export async function dismissOpenDialog(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const dialogGone = async () =>
    await page
      .waitForFunction(() => document.querySelector('[role="dialog"]') === null, { timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
  if (!(await page.$('[role="dialog"]'))) return true
  // 1. The dialog's own close affordance.
  const closed = await clickInDialog(page, {
    selector: '[aria-label="关闭"], [aria-label="Close"]',
  })
  if (closed.clicked && (await dialogGone())) return true
  // 2. A labelled dismissal button (localised).
  if (Array.isArray(options.labels) && options.labels.length > 0) {
    const labelled = await clickInDialog(page, { labels: options.labels })
    if (labelled.clicked && (await dialogGone())) return true
  }
  // 3. Escape, then re-check the effect.
  await page.keyboard.press('Escape').catch(() => {})
  return await dialogGone()
}

/**
 * Activate a row and verify the effect: `selector` must be on screen with a layout
 * box. Each bounded attempt re-locates (a handle from before a re-render is
 * useless), and a click only counts once the effect is observed.
 * @param {import('puppeteer-core').Page} page
 * @param {{
 *   labels: string[],
 *   selector: string,
 *   label: string,
 *   describe: () => Promise<unknown>,
 *   attempts?: number,
 *   appearTimeoutMs?: number,
 *   mountTimeoutMs?: number,
 *   within?: string,
 * }} options
 */
export async function activateRowAndWaitFor(page, options) {
  const {
    labels,
    selector,
    label,
    describe,
    attempts = 4,
    appearTimeoutMs = 60_000,
    mountTimeoutMs = 20_000,
    within = null,
  } = options
  const appeared = await waitForRow(page, labels, { timeoutMs: appearTimeoutMs, within })
  /** @type {any[]} */
  const log = [{ step: 'row-appeared', ok: appeared }]
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await activateRow(page, labels, { within })
    log.push({ attempt, result })
    if (result.clicked) {
      const mounted = await page
        .waitForFunction(
          (selector_) => {
            const node = document.querySelector(selector_)
            return node !== null && node.getBoundingClientRect().width > 0
          },
          { timeout: mountTimeoutMs, polling: 150 },
          selector,
        )
        .then(() => true)
        .catch(() => false)
      log.push({ attempt, mounted })
      if (mounted) return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `${label} did not take effect after ${attempts} attempt(s): ${JSON.stringify({ attempts: log, page: await describe() })}`,
  )
}
