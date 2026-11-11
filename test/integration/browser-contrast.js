/**
 * Shared contrast measurement for the browser-driven E2E suites (web `dsh web`
 * and the Electron desktop shell).
 *
 * Why a shared module: both shells must be graded by exactly the same rule, and
 * the rule is subtle enough that two copies would drift. The measurement runs
 * inside the page (puppeteer serializes `measureButtons`), so it must be
 * self-contained — no imports, no closure over module scope.
 */

/** Minimum contrast ratio a button label must reach (WCAG 1.4.11, large text AA). */
export const MIN_CONTRAST = 3

/** The regression target: the primary buttons that were invisible before #10. */
export const PRIMARY_TEST_IDS = ['settings-host-add', 'settings-host-add-empty']

/**
 * Measure every button inside `[data-testid="settings-remote-section"]`:
 *
 * - the painted background (alpha-composited over ancestor `backgroundColor`s),
 * - any `background-image` gradient on the way up (the checker refuses to grade
 *   one: comparing a gradient against the colour underneath it is a false pass),
 * - the button colour and its `.drg-btn-label`, each composited over that
 *   background and faded by the accumulated `opacity` — `.drg-btn:disabled` uses
 *   `opacity: .55`, which would otherwise be graded as a solid label,
 * - the WCAG ratio of the rendered colours, and the section's own background.
 *
 * Serializable: this function is evaluated inside the page.
 */
export function measureButtons() {
  /** @param {string} value */
  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value ?? '')
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  /** @param {any} top @param {any} bottom */
  function blend(top, bottom) {
    const alpha = top.a + bottom.a * (1 - top.a)
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
      a: alpha,
    }
  }
  /**
   * The painted background behind `node`, plus any gradient encountered.
   * @param {Element} node
   * @returns {{ color: { r: number, g: number, b: number, a: number }, gradient: string | null }}
   */
  function effectiveBackground(node) {
    const layers = []
    let gradient = null
    let current = node
    while (current) {
      const style = getComputedStyle(current)
      if (!gradient && style.backgroundImage && style.backgroundImage !== 'none') {
        const label = `${current.tagName}.${String(current.className || '').slice(0, 40)}`
        gradient = `${label}: ${style.backgroundImage.slice(0, 80)}`
      }
      const parsed = parseColor(style.backgroundColor)
      if (parsed && parsed.a > 0) layers.push(parsed)
      if (parsed && parsed.a >= 1) break
      current = current.parentElement
    }
    let base = layers.pop() ?? { r: 255, g: 255, b: 255, a: 1 }
    while (layers.length > 0) base = blend(layers.pop(), base)
    return { color: base, gradient }
  }
  /** Product of `opacity` from `node` to the root — what actually paints. */
  /** @param {Element} node */
  function accumulatedOpacity(node) {
    let opacity = 1
    let current = node
    while (current) {
      const value = Number.parseFloat(getComputedStyle(current).opacity)
      if (Number.isFinite(value)) opacity *= value
      current = current.parentElement
    }
    return opacity
  }
  /**
   * A text colour as actually seen: its own alpha over the background, faded by
   * the element opacity into that same background.
   * @param {{ r: number, g: number, b: number, a: number } | null} color
   * @param {{ r: number, g: number, b: number, a: number }} background
   * @param {number} opacity
   */
  function renderedForeground(color, background, opacity) {
    if (!color) return null
    const composited = blend({ ...color, a: color.a * opacity }, background)
    return { r: composited.r, g: composited.g, b: composited.b }
  }
  /** @param {number} value */
  function channel(value) {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  /** @param {{ r: number, g: number, b: number }} color */
  function luminance(color) {
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  /** @param {{ r: number, g: number, b: number }} one @param {{ r: number, g: number, b: number }} two */
  function contrast(one, two) {
    const luminanceOne = luminance(one)
    const luminanceTwo = luminance(two)
    return (Math.max(luminanceOne, luminanceTwo) + 0.05) / (Math.min(luminanceOne, luminanceTwo) + 0.05)
  }
  const round = (value) => Math.round(value * 100) / 100
  const format = (color) => `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
  const section = document.querySelector('[data-testid="settings-remote-section"]')
  if (!section) return { mounted: false, buttons: [] }
  const sectionBackground = effectiveBackground(section)
  const buttons = [...section.querySelectorAll('button')].map((node) => {
    const style = getComputedStyle(node)
    const background = effectiveBackground(node)
    const opacity = accumulatedOpacity(node)
    const color = parseColor(style.color)
    const label = node.querySelector('.drg-btn-label')
    const labelColor = label ? parseColor(getComputedStyle(label).color) : null
    const labelOpacity = label ? accumulatedOpacity(label) : opacity
    const renderedColor = renderedForeground(color, background.color, opacity)
    const renderedLabel = renderedForeground(labelColor, background.color, labelOpacity)
    return {
      testId: node.getAttribute('data-testid'),
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
      color: style.color,
      labelColor: labelColor ? getComputedStyle(label).color : null,
      background: format(background.color),
      gradient: background.gradient,
      opacity: round(opacity),
      ratio: renderedColor ? round(contrast(renderedColor, background.color)) : null,
      labelRatio: renderedLabel ? round(contrast(renderedLabel, background.color)) : null,
    }
  })
  return {
    mounted: true,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    sectionBackground: format(sectionBackground.color),
    sectionGradient: sectionBackground.gradient,
    buttons,
  }
}

/**
 * Poll the page until the measurement is **stable** — two identical consecutive
 * samples after the colour scheme flipped.
 *
 * Sampling once right after `emulateMediaFeatures` catches the shell mid-repaint
 * (observed: a dark-mode sample still carrying the light section background,
 * ratio 1.56). Stability, not a sleep, is the deterministic signal.
 * @param {import('puppeteer-core').Page} page
 * @param {{ scheme: 'light' | 'dark', previousBodyBackground?: string | null, timeoutMs?: number }} options
 */
export async function measureStable(page, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const started = Date.now()
  /** @type {string | null} */
  let previous = null
  while (Date.now() - started <= timeoutMs) {
    const current = await page.evaluate(measureButtons)
    const concrete = current.mounted === true && current.scheme === options.scheme && current.buttons.length >= 2
    const repainted = !options.previousBodyBackground || current.bodyBackground !== options.previousBodyBackground
    const sameAsPrevious = previous !== null && previous === JSON.stringify(current)
    if (concrete && repainted && sameAsPrevious) return current
    previous = JSON.stringify(current)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `the ${options.scheme} measurement never became stable within ${timeoutMs}ms ` +
      `(expected body background != ${options.previousBodyBackground ?? '(any)'})`,
  )
}

/**
 * Assert a measurement: section mounted, no gradient, every button label legible.
 * @param {any} measured result of `measureButtons`/`measureStable`
 * @param {string} mode label used in failure messages
 */
export async function assertMeasured(measured, mode) {
  const { default: assert } = await import('node:assert/strict')
  assert.equal(measured.mounted, true, `${mode}: the Remote-hosts settings section did not mount`)
  assert.equal(
    measured.sectionGradient,
    null,
    `${mode}: the settings section paints a gradient, which the contrast check cannot evaluate: ${measured.sectionGradient}`,
  )
  assert.ok(
    measured.buttons.length >= 2,
    `${mode}: expected the plugin's action buttons, found ${measured.buttons.length}`,
  )
  for (const button of measured.buttons) {
    const name = `${button.testId ?? button.text ?? 'button'}`
    assert.equal(
      button.gradient,
      null,
      `${mode}: ${name} paints a gradient, which this check cannot evaluate: ${button.gradient}`,
    )
    assert.ok(
      button.ratio !== null && button.ratio >= MIN_CONTRAST,
      `${mode}: ${name} contrast ratio ${button.ratio} is below ${MIN_CONTRAST} (${button.color} at opacity ${button.opacity} on ${button.background})`,
    )
    if (button.labelRatio !== null) {
      assert.ok(
        button.labelRatio >= MIN_CONTRAST,
        `${mode}: ${name} label contrast ratio ${button.labelRatio} is below ${MIN_CONTRAST} (${button.labelColor} at opacity ${button.opacity} on ${button.background})`,
      )
    }
  }
  const primary = measured.buttons.filter((button) => PRIMARY_TEST_IDS.includes(button.testId))
  assert.equal(primary.length, PRIMARY_TEST_IDS.length, `${mode}: the primary buttons under test are missing`)
  const worst = measured.buttons.reduce((low, button) => Math.min(low, button.ratio ?? 0), Number.POSITIVE_INFINITY)
  console.log(
    `[contrast] ${mode}: ${measured.buttons.length} button(s), worst ratio ${worst.toFixed(2)} ` +
      `(min ${MIN_CONTRAST}), shell ${measured.bodyBackground}, section ${measured.sectionBackground}`,
  )
  return measured
}
