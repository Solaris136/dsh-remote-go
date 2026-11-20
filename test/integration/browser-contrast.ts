import { applyColorScheme } from './ui-steps.ts'

export const MIN_CONTRAST = 3
export const PRIMARY_TEST_IDS = ['host-add', 'host-add-empty']
export function measureButtons() {
  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value ?? '')
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
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
  function renderedForeground(color, background, opacity) {
    if (!color) return null
    const composited = blend({ ...color, a: color.a * opacity }, background)
    return { r: composited.r, g: composited.g, b: composited.b }
  }
  function channel(value) {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  function luminance(color) {
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  function contrast(one, two) {
    const luminanceOne = luminance(one)
    const luminanceTwo = luminance(two)
    return (Math.max(luminanceOne, luminanceTwo) + 0.05) / (Math.min(luminanceOne, luminanceTwo) + 0.05)
  }
  const round = (value) => Math.round(value * 100) / 100
  const format = (color) => `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
  const section = document.querySelector('[data-testid="manage-window"]')
  if (!section) return { mounted: false, buttons: [] }
  const surface = section.querySelector('[role="dialog"]') ?? section
  const sectionBackground = effectiveBackground(surface)
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
  // 11–12px metadata is normal-size text for WCAG: 4.5:1, not the 3:1 large-text floor. It used to be excluded from
  // this check entirely, so `label-caption` slipped through (review).
  const smallText = [...section.querySelectorAll('.drg-card-meta dt, .drg-card-meta dd')].map((node) => {
    const style = getComputedStyle(node)
    const background = effectiveBackground(node)
    const opacity = accumulatedOpacity(node)
    const color = parseColor(style.color)
    const rendered = renderedForeground(color, background.color, opacity)
    return {
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
      color: style.color,
      background: format(background.color),
      opacity: round(opacity),
      ratio: rendered ? round(contrast(rendered, background.color)) : null,
    }
  })
  return {
    mounted: true,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    sectionBackground: format(sectionBackground.color),
    sectionGradient: sectionBackground.gradient,
    // A dialog mounts with a 160ms fade; measuring while it runs can catch opacity 0 and report a false contrast
    // failure (the desktop shell occasionally re-opened the window right before the measurement). Stability means: no
    // animation is still running.
    animations:
      typeof document.getAnimations === 'function'
        ? document.getAnimations().filter((animation) => animation.playState === 'running').length
        : 0,
    buttons,
    smallText,
  }
}
export async function measureStable(page, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const started = Date.now()
  let previous = null
  while (Date.now() - started <= timeoutMs) {
    const current = await page.evaluate(measureButtons)
    const concrete =
      current.mounted === true &&
      current.scheme === options.scheme &&
      current.buttons.length >= 2 &&
      (current.animations ?? 0) === 0
    const repainted = !options.previousBodyBackground || current.bodyBackground !== options.previousBodyBackground
    const sameAsPrevious = previous !== null && previous === JSON.stringify(current)
    if (concrete && repainted && sameAsPrevious) return current
    previous = JSON.stringify(current)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const running = await page.evaluate(() =>
    typeof document.getAnimations === 'function'
      ? document
          .getAnimations()
          .filter((animation) => animation.playState === 'running')
          .map((animation) => animation.animationName || animation.transitionProperty || animation.constructor.name)
      : [],
  )
  throw new Error(
    `the ${options.scheme} measurement never became stable within ${timeoutMs}ms ` +
      `(expected body background != ${options.previousBodyBackground ?? '(any)'}; running animations: ${JSON.stringify(running)})`,
  )
}
export async function assertMeasured(measured, mode) {
  const { default: assert } = await import('node:assert/strict')
  assert.equal(measured.mounted, true, `${mode}: the host-management window did not mount`)
  assert.equal(
    measured.sectionGradient,
    null,
    `${mode}: the host-management window paints a gradient, which the contrast check cannot evaluate: ${measured.sectionGradient}`,
  )
  assert.ok(
    measured.buttons.length >= 2,
    `${mode}: expected the plugin's action buttons, found ${measured.buttons.length}`,
  )
  // A clean profile has no host cards, so `smallText` would be empty and the 4.5:1 loop below would never run (review
  // nit 4). The fixtures seed one host; require it to be measured.
  assert.ok(
    (measured.smallText?.length ?? 0) > 0,
    `${mode}: no 11-12px host-card metadata was measured; the contrast gate would be vacuous`,
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
  for (const item of measured.smallText ?? []) {
    assert.ok(
      item.ratio !== null && item.ratio >= 4.5,
      `${mode}: small metadata "${item.text}" contrast ratio ${item.ratio} is below 4.5 (${item.color} at opacity ${item.opacity} on ${item.background})`,
    )
  }
  const primary = measured.buttons.filter((button) => PRIMARY_TEST_IDS.includes(button.testId))
  // The fixtures now seed a host, so the empty-state button (`host-add-empty`) is not rendered; the normal `host-add`
  // action must still be present and measured.
  assert.ok(
    primary.length >= 1,
    `${mode}: the primary button under test is missing (found ${JSON.stringify(measured.buttons.map((button) => button.testId))})`,
  )
  const worst = measured.buttons.reduce((low, button) => Math.min(low, button.ratio ?? 0), Number.POSITIVE_INFINITY)
  console.log(
    `[contrast] ${mode}: ${measured.buttons.length} button(s), worst ratio ${worst.toFixed(2)} ` +
      `(min ${MIN_CONTRAST}), shell ${measured.bodyBackground}, section ${measured.sectionBackground}`,
  )
  return measured
}
export async function assertLightAndDark(page, mode) {
  const { default: assert } = await import('node:assert/strict')
  await applyColorScheme(page, 'light', null)
  const light = await assertMeasured(await measureStable(page, { scheme: 'light' }), `${mode} light`)
  assert.equal(light.scheme, 'light', `${mode}: the shell did not report a light scheme`)
  await applyColorScheme(page, 'dark', light.bodyBackground)
  const dark = await assertMeasured(
    await measureStable(page, { scheme: 'dark', previousBodyBackground: light.bodyBackground }),
    `${mode} dark`,
  )
  assert.equal(dark.scheme, 'dark', `${mode}: the shell did not report a dark scheme`)
  assert.notEqual(
    dark.bodyBackground,
    light.bodyBackground,
    `${mode}: the app shell background did not change between light and dark mode`,
  )
  assert.notEqual(
    dark.sectionBackground,
    light.sectionBackground,
    `${mode}: the host-management window background did not change between light and dark mode`,
  )
  return { light, dark }
}
