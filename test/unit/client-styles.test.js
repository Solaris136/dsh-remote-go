import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../../client.js', import.meta.url)

/**
 * The `--dsw-*` vocabulary this plugin is allowed to read.
 *
 * These are the host's published aliases (the theme palette plus the radius,
 * elevation, focus, menu and font variables), mirrored here on purpose: a typo like
 * `--dsw-alias-state-success` silently paints nothing, which is exactly the drift
 * that makes a plugin ignore a third-party theme. Adding a token to the client
 * therefore means adding it here — an explicit contract review instead of an
 * invisible fallback.
 */
const APP_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-toast-bg',
  '--dsw-alias-toast-label',
  '--dsw-elevation-panel',
  '--dsw-elevation-prominent',
  '--dsw-focus-ring-color',
  '--dsw-focus-ring-width',
  '--dsw-font-family',
  '--dsw-font-markdown-code-font-family',
  '--dsw-mask-blur',
  '--dsw-menu-backdrop-filter',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-panel',
  '--dsw-radius-sm',
  '--dsw-radius-xs',
  '--dsw-specific-menu',
  '--dsw-static-violet-400',
]

/** The client half's stylesheet, extracted from its template literal. */
async function clientCss() {
  const source = await readFile(CLIENT, 'utf8')
  const match = source.match(/const\s+CSS\s*=\s*`([\s\S]*?)`/)
  assert.ok(match, 'the client half must keep its stylesheet in a `const CSS = ` template literal')
  return match[1]
}

/** The switcher row's stylesheet, built from the string array `mountHostRow` joins. */
async function rowCss() {
  const source = await readFile(CLIENT, 'utf8')
  const match = source.match(/style\.textContent = \[([\s\S]*?)\]\.join\(''\)/)
  assert.ok(match, 'the switcher row must keep its styles in the style.textContent array')
  // Strip the full-line comments first: one of them contains an apostrophe ("page's"),
  // which would otherwise open a bogus string literal for the scan below.
  const withoutComments = match[1].replace(/^\s*\/\/.*$/gm, '')
  const literals = [...withoutComments.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((found) => found[1])
  assert.ok(literals.length > 10, `expected the row stylesheet string array, found ${literals.length} literals`)
  return literals.join('')
}

/** Remove block comments so a selector test cannot match commented-out copy. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Drop one `@media <header> { … }` block (nesting aware). @param {string} css @param {string} header */
function stripAtRule(css, header) {
  const marker = '@media ' + header
  let rest = ''
  let index = 0
  while (index < css.length) {
    const start = css.indexOf(marker, index)
    if (start < 0) {
      rest += css.slice(index)
      break
    }
    rest += css.slice(index, start)
    const open = css.indexOf('{', start)
    let depth = 1
    let cursor = open + 1
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') depth -= 1
      cursor += 1
    }
    index = cursor
  }
  return rest
}

/** All declaration blocks whose selector list contains `selector`. @param {string} css @param {string} selector */
function blocksFor(css, selector) {
  const blocks = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (selectors.includes(selector)) blocks.push(match[2])
  }
  return blocks
}

test('the primary button paints its label with the on-primary colour', async () => {
  const css = stripAtRule(stripComments(await clientCss()), '(forced-colors: active)')

  // Regression: a single-class `.drg-btn-primary { color: … }` declaration loses the cascade
  // against the app's own `button { color: … }` rule, so the label rendered in the same colour
  // as the fill — an invisible (solid black) primary button in both the web and desktop shells.
  const singleClass = blocksFor(css, '.drg-btn-primary')
  for (const block of singleClass) {
    assert.equal(
      /(?:^|;)\s*color\s*:/.test(block),
      false,
      '.drg-btn-primary must not set its own colour; the two-class rule below must win the cascade',
    )
  }

  const colourRules = blocksFor(css, '.drg-btn.drg-btn-primary')
  assert.equal(colourRules.length, 1, 'expected exactly one two-class primary button rule')
  assert.match(
    colourRules[0],
    /(?:^|;)\s*color\s*:\s*var\(--dsw-alias-label-primary-foreground\)/,
    'the two-class rule must paint the label with the host’s on-primary alias',
  )

  const labelRules = blocksFor(css, '.drg-btn.drg-btn-primary .drg-btn-label')
  assert.equal(labelRules.length, 1, 'the label span needs the same two-class specificity')
  assert.match(
    labelRules[0],
    /(?:^|;)\s*color\s*:\s*var\(--dsw-alias-label-primary-foreground\)/,
    'the label span must paint itself with the host’s on-primary alias',
  )
})

test('the on-primary colour actually contrasts with the primary fill', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const primary = source.match(/background:\s*var\(--dsw-alias-button-primary-fill\)/)
  const onPrimary = source.match(/color:\s*var\(--dsw-alias-label-primary-foreground\)/)
  assert.ok(primary, 'the primary fill must come from the host’s button alias')
  assert.ok(onPrimary, 'the on-primary label must come from the host’s foreground alias')
  // The host ships these two as a pair for its own primary buttons; reusing the pair is what
  // keeps the plugin’s buttons legible under any registered theme.
  assert.notEqual(primary[0], onPrimary[0], 'the fill and its label colour must not share one alias')
})

test('every rule that styles a surface survives comment stripping', async () => {
  // Commit 453b59c deleted the sidebar-foot rule but left its opening `/*`: every rule
  // between it and the next `*/` (forms, wizard steps, chips, the drawer, diagnostics and
  // the settings sections) was swallowed, so those views rendered unstyled. The block-comment
  // balance and the per-selector checks below are the regression guard.
  const css = await clientCss()
  assert.equal(
    (css.match(/\/\*/g) ?? []).length,
    (css.match(/\*\//g) ?? []).length,
    'the stylesheet has an unbalanced block comment',
  )

  const stripped = stripComments(css)
  const styled = [
    '.drg-check',
    '.drg-form-grid',
    '.drg-wizard-step',
    '.drg-wizard-step-index',
    '.drg-chip',
    '.drg-drawer',
    '.drg-drawer-head',
    '.drg-drawer-body',
    '.drg-diag-check',
    '.drg-settings-section',
    '.drg-section-title',
    '.drg-conflict-processes',
    '.drg-keyfile-row',
  ]
  for (const selector of styled) {
    assert.ok(blocksFor(stripped, selector).length > 0, `${selector} has no live declaration block`)
  }
})

test('surfaces use the host’s own dialog, menu and field primitives', async () => {
  const css = stripComments(await clientCss())

  // The dialog copies the host Dialog: layer-2 surface, panel radius, prominent elevation,
  // no border. Using --dsw-alias-bg-overlay here was the bug that made the management
  // window and wizard look grey next to DSH’s own white dialogs.
  const modal = blocksFor(css, '.drg-modal')[0]
  assert.ok(modal, 'expected the dialog rule')
  assert.match(modal, /border-radius:\s*var\(--dsw-radius-panel\)/, 'dialogs use the host panel radius')
  assert.match(modal, /background:\s*var\(--dsw-alias-bg-layer-2\)/, 'dialogs use the host layer-2 surface')
  assert.match(modal, /box-shadow:\s*var\(--dsw-elevation-prominent\)/, 'dialogs use the host prominent elevation')

  const backdrop = blocksFor(css, '.drg-modal-backdrop')[0]
  assert.ok(backdrop, 'expected the dialog scrim rule')
  assert.match(backdrop, /background:\s*var\(--dsw-alias-bg-mask-1\)/)
  assert.match(backdrop, /backdrop-filter:\s*var\(--dsw-mask-blur\)/)

  const input = blocksFor(css, '.drg-select')[0]
  assert.ok(input, 'expected the field rule')
  assert.match(input, /background:\s*var\(--dsw-alias-bg-layer-3\)/, 'fields use the host layer-3 fill')
  assert.match(input, /border:\s*0\.5px solid var\(--dsw-alias-border-l4\)/, 'fields use the host hairline stroke')

  // The switcher menu copies the host MenuSurface: specific-menu fill + blur + panel shadow.
  const row = await rowCss()
  assert.match(row, /background:var\(--dsw-specific-menu\)/, 'the switcher menu must use the host menu surface')
  assert.match(row, /backdrop-filter:var\(--dsw-menu-backdrop-filter\)/, 'the switcher menu must blur like the host')
  assert.match(row, /box-shadow:var\(--dsw-elevation-panel\)/, 'the switcher menu must use the host menu elevation')
  assert.equal(row.includes('background:#fff'), false, 'the switcher menu must not paint its own surface')
})

test('the plugin adds no design tokens of its own', async () => {
  // Option A: the CSS reads --dsw-* directly, with no local --drg-* layer. Every colour and
  // surface is therefore owned by DSH, and a theme change cannot leave a cached copy behind.
  const source = await readFile(CLIENT, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(
    /--drg-[a-z0-9-]+\s*:/.test(code),
    false,
    'client.js declares its own design token; use the host --dsw-* aliases directly',
  )
  assert.equal(
    /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i.test(code),
    false,
    'client.js contains a colour literal; every colour must come from a --dsw-* variable',
  )

  // JavaScript-side colour strings (the status dots) are variables too.
  const tone = source.match(/const TONE_VARS = \{([\s\S]*?)\n\s*\}/)
  assert.ok(tone, 'expected the TONE_VARS table')
  assert.match(tone[1], /var\(--dsw-alias-state-success-primary\)/, 'status tones must read the host aliases')
  for (const value of tone[1].matchAll(/:\s*'([^']+)'/g)) {
    assert.match(value[1], /^var\(--dsw-[a-z0-9-]+\)$/, `status tone ${value[1]} must be one host token`)
  }
})

test('the plugin reads only published theme tokens', async () => {
  const allowed = new Set(APP_TOKENS)
  const css = await clientCss()
  const row = await rowCss()
  const referenced = new Set([...(css + row).matchAll(/--dsw-[a-z0-9-]+/g)].map((found) => found[0]))
  const unknown = [...referenced].filter((name) => !allowed.has(name)).sort()
  assert.deepEqual(unknown, [], `unknown --dsw-* token(s): ${unknown.join(', ')} (see APP_TOKENS)`)

  // The switcher row is stringified into the remote guest, so its palette must come from
  // that page's tokens too — and its older aliases (`state-success`, `state-warn`, …) did
  // not exist, which left the dots and the exit action on hard-coded fallbacks.
  for (const stale of [
    '--dsw-alias-state-success,',
    '--dsw-alias-state-warn,',
    '--dsw-alias-state-error,',
    '--dsw-specific-sidebar-nav-item-active',
  ]) {
    assert.equal(row.includes(stale), false, `the switcher row still reads the retired token ${stale}`)
  }
  assert.match(row, /var\(--dsw-font-family/, 'the switcher row must inherit the page font')
  assert.match(row, /--dsw-focus-ring-width/, 'the switcher row needs the theme focus ring')
})

test('no surface pins a colour scheme or paints a gradient', async () => {
  const source = await readFile(CLIENT, 'utf8')
  // The E2E contrast measurement refuses gradients outright, and a prefers-color-scheme
  // query would keep the old palette when a theme plugin switches the app instead.
  assert.equal(/prefers-color-scheme/.test(source), false, 'the client must not decide the colour scheme itself')
  for (const [name, css] of [
    ['panel', await clientCss()],
    ['switcher row', await rowCss()],
  ]) {
    assert.equal(
      /(?:linear|radial|conic)-gradient|background-image/i.test(css),
      false,
      `${name} stylesheet paints a gradient, which the contrast check cannot grade`,
    )
  }
})
