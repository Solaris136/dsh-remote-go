import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../../client.js', import.meta.url)

/** The CSS the client half injects, extracted from its template literal. */
async function clientCss() {
  const source = await readFile(CLIENT, 'utf8')
  const match = source.match(/const\s+CSS\s*=\s*`([\s\S]*?)`/)
  assert.ok(match, 'the client half must keep its stylesheet in a `const CSS = ` template literal')
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
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
  const css = await clientCss()

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
    /(?:^|;)\s*color\s*:\s*var\(--drg-on-primary\)/,
    'the two-class rule must paint the label with --drg-on-primary',
  )

  const labelRules = blocksFor(css, '.drg-btn.drg-btn-primary .drg-btn-label')
  assert.equal(labelRules.length, 1, 'the label span needs the same two-class specificity')
  assert.match(
    labelRules[0],
    /(?:^|;)\s*color\s*:\s*var\(--drg-on-primary\)/,
    'the label span must paint itself with --drg-on-primary',
  )
})

test('the on-primary colour actually contrasts with the primary fill', async () => {
  const css = await clientCss()
  const primary = css.match(/--drg-primary:\s*([^;]+);/)
  const onPrimary = css.match(/--drg-on-primary:\s*([^;]+);/)
  assert.ok(primary, 'the primary fill token must be declared')
  assert.ok(onPrimary, 'the on-primary token must be declared')

  // The two tokens must not resolve through the same alias, or they can end up identical.
  assert.notEqual(primary[1].trim(), onPrimary[1].trim(), 'the fill and its label colour must not share one alias')
  assert.match(
    onPrimary[1],
    /label-primary-inverted|#fff|white/,
    'the label colour must come from an inverted/white alias',
  )
})
