import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { REPO_ROOT, matchingBracket, stripComments, walkFiles } from '../helpers/source-scan.ts'

const SRC = path.join(REPO_ROOT, 'src')
const INTEGRATION = path.join(REPO_ROOT, 'test', 'integration')
// The composed browser half is build output: `pnpm build` writes `dist/client.js`.
const CLIENT = path.join(REPO_ROOT, 'dist', 'client.js')

const MARKER = /\/\/\s*swallow-ok:\s*(\S[^\n]*)/
const REASON_FIELD = /\breason\s*:/

function catchBlocks(text, file) {
  const stripped = stripComments(text)
  const blocks = []
  for (const match of stripped.matchAll(/\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g)) {
    const open = match.index + match[0].length - 1
    const close = matchingBracket(stripped, open)
    if (close < 0) continue
    blocks.push({
      file,
      line: stripped.slice(0, match.index).split('\n').length,
      body: stripped.slice(open, close + 1),
      rawBody: text.slice(open, close + 1),
      before: text.slice(Math.max(0, match.index - 300), match.index),
    })
  }
  return blocks
}

function violation(block) {
  if (!REASON_FIELD.test(block.body)) return null
  const distinguished =
    block.body.includes('internal-error') ||
    block.body.includes('internalHistoryFault(') ||
    /#log\s*\([^;]*?['"]error['"]/.test(block.body) ||
    /\b(?:logger|console|this\.logger)\s*\.\s*error\s*\(/.test(block.body) ||
    /\bthrow\b/.test(block.body)
  if (distinguished) return null
  const marker = block.rawBody.match(MARKER) ?? block.before.match(MARKER)
  if (marker && marker[1].trim().split(/\s+/).length >= 2) return null
  return { file: block.file, line: block.line, marked: Boolean(marker) }
}

const scanCatch = (code) => catchBlocks(code, 'fixture.js').map(violation).filter(Boolean)

const catchFixture = (body) =>
  [
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch (error) {',
    body,
    '  }',
    '}',
  ].join('\n')

describe('swallow-guard', () => {
  test('no catch turns an unknown failure into a typed reason without saying so', async () => {
    // The sources are TypeScript: the emitted `.js` now lives in `dist/` and would be the same
    // text, so scanning the `.ts` files is both the source of truth and the only non-duplicate.
    const files = await walkFiles(SRC, { extensions: /\.ts$/ })
    assert.ok(files.length > 0, 'no source files found to guard')
    const failures = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const block of catchBlocks(text, path.relative(SRC, file))) {
        const found = violation(block)
        if (found) failures.push(found)
      }
    }
    assert.deepEqual(
      failures.map(
        (entry) =>
          `${entry.file}:${entry.line} — returns a typed reason without internal-error, an error-level log, or // swallow-ok: <reason>`,
      ),
      [],
      'a catch swallows an unknown failure into a normal-looking typed reason',
    )
  })
  test('planted regression: a reason of any shape is flagged (no denylist)', () => {
    const fixtures = [
      catchFixture('    return { ok: false, reason: REASON }'),
      catchFixture('    return { ok: false, reason: remoteReasonFor(error) }'),
      catchFixture("    return { ok: false, reason: 'ssh-unreachable' }"),
      catchFixture("    const errorLine = String(error)\n    return { ok: false, reason: 'read-failed' }"),
    ]
    for (const fixture of fixtures) assert.equal(scanCatch(fixture).length, 1)
  })
  test('planted regression: prose containing "throw"/"error" does not count as distinguished', () => {
    const fixture = catchFixture(
      "    // we could throw here, or log the error, but we do not\n    return { ok: false, reason: 'read-failed' }",
    )
    assert.equal(scanCatch(fixture).length, 1, 'a comment must not silence the guard')
  })
  test('the documented escape hatches are accepted, and only those', () => {
    const accepted = [
      catchFixture(
        '    logger.error("[dsh-remote-go] history read failed:", error)\n    return { ok: false, reason: \'read-failed\' }',
      ),
      catchFixture(
        "    this.#log(runtime, 'error', 'history read failed')\n    return { ok: false, reason: 'read-failed' }",
      ),
      catchFixture("    return { ok: false, reason: 'internal-error' }"),
      catchFixture('    throw error'),
      catchFixture(
        "    // swallow-ok: the try body is only ssh.exec, a rejection is transport\n    return { ok: false, reason: 'read-failed' }",
      ),
      ['try {', '  await close()', '} catch {', '  return null', '}'].join('\n'),
      ['try {', '  await close()', '} catch {', "  return { status: 'corrupt', value: null }", '}'].join('\n'),
    ]
    for (const fixture of accepted) assert.deepEqual(scanCatch(fixture), [])
    const bare = catchFixture("    // swallow-ok\n    return { ok: false, reason: 'read-failed' }")
    assert.equal(scanCatch(bare).length, 1, 'a marker without a stated reason must not silence the guard')
  })
  test('the scanner covers src recursively, not just the top level', async () => {
    const files = (await walkFiles(SRC, { extensions: /\.ts$/ })).map((file) => path.relative(SRC, file))
    assert.ok(files.length > 0)
    assert.deepEqual(
      files.filter((file) => !file.endsWith('.ts')),
      [],
    )
    assert.ok(files.includes('service.ts'), 'top-level sources are still scanned')
  })
})

const NON_STATE_FIELDS = new Set([
  'map',
  'filter',
  'every',
  'some',
  'find',
  'length',
  'json',
  'slice',
  'join',
  'sort',
  'includes',
  'textContent',
  'hostId',
  'forEach',
  'then',
  'catch',
])

function fieldsOf(source, receivers) {
  const fields = new Set()
  for (const receiver of receivers) {
    const re = new RegExp(`\\b${receiver}\\??\\.([A-Za-z_$][\\w$]*)`, 'g')
    for (const match of source.matchAll(re)) {
      if (!NON_STATE_FIELDS.has(match[1])) fields.add(match[1])
    }
  }
  return fields
}

function assertionArguments(source) {
  const parts = []
  for (const match of source.matchAll(/\bassert\.[A-Za-z]+(?:\.[A-Za-z]+)?\s*\(/g)) {
    const open = match.index + match[0].length - 1
    const close = matchingBracket(source, open)
    if (close > open) parts.push(source.slice(open, close + 1))
  }
  return parts.join('\n')
}

function assertionWindow(rest) {
  const lines = rest.split('\n').slice(0, 40)
  const kept = []
  for (const line of lines) {
    if (/^\s*await t\.test\(/.test(line) || /^\s*test\(/.test(line)) break
    if (/^\s*\/\/ ----/.test(line)) break
    kept.push(line)
    if (kept.length > 0 && /^\s{0,4}\}$/.test(line)) break
  }
  return kept.join('\n')
}

function predicateViolations(text, file) {
  const found = []
  const waitCall = /\b(waitForMirrors|pollUntil)\s*\(/g
  for (const match of text.matchAll(waitCall)) {
    const open = match.index + match[0].length - 1
    const close = matchingBracket(text, open)
    if (close < 0) continue
    const call = text.slice(match.index, close + 1)
    const predicate = (() => {
      const arrow = call.indexOf('=>')
      return arrow < 0 ? call : call.slice(arrow)
    })()
    const receivers = new Set(['list'])
    for (const param of predicate.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*=>/g)) receivers.add(param[1])
    for (const param of predicate.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) receivers.add(param[1])
    const predicateFields = fieldsOf(predicate, [...receivers])
    if (predicateFields.size === 0) continue
    const before = text.slice(Math.max(0, match.index - 160), match.index)
    const binding = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*$/.exec(before)
    if (!binding) continue
    const result = binding[1]
    const line = text.slice(0, match.index).split('\n').length
    const window = assertionWindow(text.slice(close + 1))
    const loopParams = [
      ...window.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${result}\\b`, 'g')),
    ].map((loop) => loop[1])
    const after = assertionArguments(window)
    const asserted = new Set()
    for (const use of after.matchAll(new RegExp(`\\b${result}(?:\\[[^\\]]*\\])?\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      if (!NON_STATE_FIELDS.has(use[1])) asserted.add(use[1])
    }
    for (const use of after.matchAll(
      new RegExp(`\\b${result}\\.(?:every|some|map|filter)\\(\\s*\\(?([A-Za-z_$][\\w$]*)`, 'g'),
    )) {
      asserted.add(`__callback:${use[1]}`)
    }
    for (const param of loopParams) asserted.add(`__callback:${param}`)
    const callbackFields = new Set()
    for (const entry of asserted) {
      if (!entry.startsWith('__callback:')) continue
      const param = entry.slice('__callback:'.length)
      for (const field of fieldsOf(after, [param])) callbackFields.add(field)
    }
    for (const entry of asserted) if (!entry.startsWith('__callback:')) callbackFields.add(entry)
    const missing = [...callbackFields].filter((field) => !predicateFields.has(field))
    if (missing.length > 0) {
      const key = `${file}|${predicate.replace(/\s+/g, ' ').trim()}`
      found.push({ file, line, key, missing: missing.sort(), predicate: [...predicateFields].sort() })
    }
  }
  return found
}

const TRANSIENT_SNAPSHOT_WAITS = new Map([])

describe('predicate-guard', () => {
  test('every e2e wait predicate covers the fields its following assertions read', async () => {
    const names = (await walkFiles(INTEGRATION, { extensions: /\.ts$/ }))
      .map((file) => path.basename(file))
      .filter((name) => name.endsWith('.e2e.ts') || name === 'ui-steps.ts')
    assert.ok(names.length > 0, 'no e2e suites found to guard')
    const failures = []
    for (const name of names) {
      const text = await readFile(path.join(INTEGRATION, name), 'utf8')
      failures.push(...predicateViolations(text, name))
    }
    const unaccepted = failures.filter((entry) => !TRANSIENT_SNAPSHOT_WAITS.has(entry.key))
    assert.deepEqual(
      unaccepted.map((entry) => `${entry.file}:${entry.line} — missing ${entry.missing.join(', ')}`),
      [],
      'a wait predicate is narrower than the assertions that follow it (add the field to the ' +
        'predicate, or document it in TRANSIENT_SNAPSHOT_WAITS with a reason)',
    )
    const keys = new Set(failures.map((entry) => entry.key))
    const stale = [...TRANSIENT_SNAPSHOT_WAITS.keys()].filter((key) => !keys.has(key))
    assert.deepEqual(stale, [], 'TRANSIENT_SNAPSHOT_WAITS lists a wait that no longer violates the rule — remove it')
  })
  test('the guard detects the documented proxy predicate', () => {
    const fixture = [
      'const mirrors = await waitForMirrors(service, host.id, (list) =>',
      '  list.every((mirror) => mirror.cursor === 5),',
      ')',
      'assert.equal(',
      '  mirrors.every((mirror) => mirror.cursor === 5 && mirror.reason === null),',
      '  true,',
      ')',
    ].join('\n')
    const found = predicateViolations(fixture, 'fixture.e2e.js')
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].missing, ['reason'])
    assert.equal(found[0].line, 1)
  })
  test('the guard accepts the widened predicate history.e2e uses as its model', () => {
    const fixture = [
      'const settled = async () => {',
      '  const mirrors = await mirrorsOf(service, host.id)',
      '  return (',
      '    mirrors.length === 2 &&',
      "    mirrors.every((mirror) => mirror.cursor === 2 && mirror.level === 'L1' && mirror.reason?.code === 'gap-unfilled')",
      '  )',
      '}',
      'const mirrors = await waitForMirrors(service, host.id, (list) =>',
      '  list.every(',
      "    (mirror) => mirror.cursor === 2 && mirror.level === 'L1' && mirror.reason?.code === 'gap-unfilled',",
      '  ),',
      ')',
      'assert.equal(mirrors.every((mirror) => mirror.cursor === 2 && mirror.level === L1), true)',
    ].join('\n')
    assert.deepEqual(predicateViolations(fixture, 'fixture.e2e.js'), [])
  })
})

const INCLUDE_DIRS = ['src', 'scripts', 'test', 'e2e']
// The published entry points are build output: `pnpm build` writes them into `dist/`.
const INCLUDE_FILES = ['dist/index.js', 'dist/client.js']
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'artifacts',
  'home',
  'home-published',
  'logs',
  '_research',
  '_tools',
])

const SPAWN_RE = /(?<![\w$])(?:[A-Za-z_$][\w$]*\.)?(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/g
const EXEC_RE = /(?<![\w.$])exec\s*\(/g
const OPT_OUT = 'windowsHide-ignore'

function callArguments(source, start) {
  const begin = source.indexOf('(', start)
  if (begin === -1) return { text: '', closeIndex: -1 }
  const closeIndex = matchingBracket(source, begin)
  return closeIndex === -1
    ? { text: source.slice(begin), closeIndex }
    : { text: source.slice(begin, closeIndex + 1), closeIndex }
}

function looksLikeDefinition(source, start, closeIndex) {
  let cursor = closeIndex + 1
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  if (source[cursor] === '{') return true
  // An interface member has no body: it ends in a return type annotation
  // (`exec(command: string): Promise<X>`). The emitted `.js` this scanner used to read had no
  // interfaces, so the annotation form only appeared once the sources became TypeScript. A
  // ternary's `: ` is ruled out by requiring the name to be the first token on its line, which
  // is where a member declaration starts.
  if (source[cursor] !== ':') return false
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  return /^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*$/.test(
    source.slice(lineStart, start),
  )
}

async function findCallSites() {
  const files = []
  for (const dir of INCLUDE_DIRS) {
    files.push(
      // `.ts` is the source of truth since the test/script migration; the emitted `.js` in
      // `dist/` is not scanned, so a finding is never reported twice for one call site.
      ...(await walkFiles(path.join(REPO_ROOT, dir), { extensions: /\.(?:js|mjs|cjs|ts)$/, skipDirs: SKIP_DIRS })),
    )
  }
  for (const name of INCLUDE_FILES) files.push(path.join(REPO_ROOT, name))
  const sites = []
  for (const file of files) {
    if (file.endsWith('.bundle.cjs')) continue
    const raw = await readFile(file, 'utf8')
    const source = stripComments(raw)
    const rawLines = raw.split('\n')
    const scan = (regex) => {
      for (const match of source.matchAll(regex)) {
        const index = match.index ?? 0
        const args = callArguments(source, index)
        if (args.closeIndex !== -1 && looksLikeDefinition(source, index, args.closeIndex)) continue
        const line = source.slice(0, index).split('\n').length
        const context = `${rawLines[line - 2] ?? ''}\n${rawLines[line - 1] ?? ''}`
        sites.push({
          file: path.relative(REPO_ROOT, file),
          name: match[1] ?? 'exec',
          arguments: args.text,
          line,
          optedOut: context.includes(OPT_OUT),
        })
      }
    }
    scan(SPAWN_RE)
    scan(EXEC_RE)
  }
  return sites
}

describe('e2e-child-process-guard', () => {
  test('every child-process call site sets windowsHide', async () => {
    const sites = await findCallSites()
    assert.ok(
      sites.length >= 10,
      `expected to find the repository's child-process call sites, found ${sites.length} — the scanner is broken`,
    )
    const missing = sites
      .filter((site) => !site.optedOut && !site.arguments.includes('windowsHide'))
      .map((site) => `${site.file}:${site.line} ${site.name}(…) has no windowsHide`)
    assert.deepEqual(missing, [], `these child processes would flash a console on Windows:\n${missing.join('\n')}`)
  })
  test('no child-process call routes its main invocation through cmd.exe', async () => {
    const sites = await findCallSites()
    const offenders = sites
      .filter((site) => /cmd(?:\.exe)?['"\s,]/.test(site.arguments) || site.arguments.includes("'/c'"))
      .map((site) => `${site.file}:${site.line} ${site.name}(…) still routes through cmd.exe`)
    assert.deepEqual(offenders, [], `invoke the real binary or process.execPath instead:\n${offenders.join('\n')}`)
  })
  test('the scanner ignores remote, regex and comment call sites', async () => {
    const sites = await findCallSites()
    const dotted = sites.filter((site) => site.name === 'exec')
    assert.deepEqual(
      dotted.map((site) => `${site.file}:${site.line}`),
      [],
      'a `.exec(` call was treated as a local child process',
    )
    assert.equal(
      sites.some((site) => site.file.includes('vendor')),
      false,
      'the vendored bundle must stay out of scope',
    )
  })
})

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

const clientSource = () => readFile(CLIENT, 'utf8')

async function clientCss() {
  const source = await clientSource()
  const match = source.match(/const\s+CSS\s*=\s*`([\s\S]*?)`/)
  assert.ok(match, 'the client half must keep its stylesheet in a `const CSS = ` template literal')
  return match[1]
}

async function rowCss() {
  const source = await clientSource()
  const match = source.match(/style\.textContent = \[([\s\S]*?)\]\.join\(''\)/)
  assert.ok(match, 'the switcher row must keep its styles in the style.textContent array')
  const withoutComments = match[1].replace(/^\s*\/\/.*$/gm, '')
  const literals = [...withoutComments.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((found) => found[1])
  assert.ok(literals.length > 10, `expected the row stylesheet string array, found ${literals.length} literals`)
  return literals.join('')
}

const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

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

describe('client-styles', () => {
  test('the primary button paints its label with the host on-primary colour', async () => {
    const source = await clientSource()
    const css = stripAtRule(stripCssComments(await clientCss()), '(forced-colors: active)')
    for (const block of blocksFor(css, '.drg-btn-primary')) {
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
    const primary = source.match(/background:\s*var\(--dsw-alias-button-primary-fill\)/)
    const onPrimary = source.match(/color:\s*var\(--dsw-alias-label-primary-foreground\)/)
    assert.ok(primary, 'the primary fill must come from the host’s button alias')
    assert.ok(onPrimary, 'the on-primary label must come from the host’s foreground alias')
  })
  test('every rule that styles a surface survives comment stripping', async () => {
    const css = await clientCss()
    assert.equal(
      (css.match(/\/\*/g) ?? []).length,
      (css.match(/\*\//g) ?? []).length,
      'the stylesheet has an unbalanced block comment',
    )
    const stripped = stripCssComments(css)
    const styled = [
      '.drg-check',
      '.drg-form-grid',
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
    const css = stripCssComments(await clientCss())
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
    const row = await rowCss()
    assert.match(row, /background:var\(--dsw-specific-menu\)/, 'the switcher menu must use the host menu surface')
    assert.match(row, /backdrop-filter:var\(--dsw-menu-backdrop-filter\)/, 'the switcher menu must blur like the host')
    assert.match(row, /box-shadow:var\(--dsw-elevation-panel\)/, 'the switcher menu must use the host menu elevation')
    assert.equal(row.includes('background:#fff'), false, 'the switcher menu must not paint its own surface')
  })
  test('the plugin adds no design tokens or colour literals of its own', async () => {
    const source = await clientSource()
    const code = stripCssComments(source)
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
    const source = await clientSource()
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
})

describe('client-compat', () => {
  test('the client half only requires react', async () => {
    const source = await clientSource()
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
    assert.deepEqual(
      [...new Set(required)].sort(),
      ['react'],
      'a dynamic client half may only require react; anything else breaks the web build',
    )
  })
  test('the client half uses no desktop-only (Electron) capability', async () => {
    const source = await clientSource()
    const forbidden = [
      /\brequire\(\s*['"]electron['"]\s*\)/,
      /\bwindow\.dsh\b/,
      /\bglobalThis\.dsh\b/,
      /\bprocess\.(\s*)binding\b/,
      /\bipcRenderer\b/,
      /\bshell\.openExternal\b/,
      /\bnodeIntegration\b/,
    ]
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `the client half must not use ${pattern}`)
    }
  })
  test('clipboard access is feature detected', async () => {
    const source = await clientSource()
    const uses = source.match(/navigator\.clipboard\s*\.\s*writeText/g) ?? []
    assert.ok(uses.length > 0, 'expected a clipboard write path')
    assert.match(
      source,
      /navigator\.clipboard\s*&&\s*typeof navigator\.clipboard\.writeText === 'function'/,
      'clipboard writes must be guarded by a capability check',
    )
  })
  test('the client opens an external window only through the capability bridge', async () => {
    const source = await clientSource()
    // An external window is a user-visible action the user asked for inside the framed page, so
    // exactly one call site exists and it is the bridge's — never the global `window.open`.
    assert.doesNotMatch(source, /window\.open\s*\(/, 'the global window.open must never be called')
    assert.equal((source.match(/_blank/g) ?? []).length, 1, 'exactly one new-window call site')
    assert.match(source, /win\.open\(url, '_blank', 'noopener,noreferrer'\)/)
    const start = source.indexOf('function openExternalUrl(')
    const gate = source.indexOf("if (url === null) return 'blocked'", start)
    const call = source.indexOf("win.open(url, '_blank'", start)
    assert.ok(start > 0, 'the bridge must be a named function')
    assert.ok(gate > start && call > gate, 'the bridge must reduce the URL before it opens one')
  })
  test('the capability bridge only forwards http(s)', async () => {
    const source = await clientSource()
    assert.match(source, /url\.protocol !== 'http:' && url\.protocol !== 'https:'/)
    assert.match(source, /url\.username !== '' \|\| url\.password !== ''/)
    // The guest copy applies the same rule before it asks the top-level document for anything.
    assert.match(source, /var externalUrl = function \(value\)/)
  })
  test('the client half ships no host-only import', async () => {
    const source = await clientSource()
    const hostOnly = [...source.matchAll(/from\s+['"]\.\/src\/[^'"]+['"]/g)]
    assert.equal(hostOnly.length, 0, 'the client bundle must not import the host half at runtime')
  })
})

/* ── runtime-writer-guard (design-arch §2.3 / PLAN review item 2) ─────────────────────────────
 *
 * The session block of `HostRuntime` has exactly one writer: `runtime/fsm.ts`, through
 * `writeBack()`. P2 step 4 moved the 16 direct + 7 indirect `status` writes onto `dispatch`, and
 * this guard is what keeps a later catch from writing the block again ("a catch sets
 * `runtime.status = 'error'` directly and the SSE frame sequence forks from the state machine").
 *
 * The allowlist is deliberately explicit per field, with the reason the staging still names a
 * second writer. A field whose only owner is `fsm.ts` must never grow one:
 *
 *   status                  — fsm.ts only. The whole point of the step.
 *   desired                 — fsm.ts only.
 *   connectCancelled        — fsm.ts only.
 *   transportLost           — fsm.ts only.
 *   reconnectAttempts       — fsm.ts only (`reconnect.scheduled` adopted the budget).
 *   error                   — fsm.ts only.
 *   phase / progress        — the connect-progress line is pure UI (it never changes `status`);
 *                             it keeps writing the two presentation fields until P2 step 7 moves
 *                             `step.entered` into the pipeline.
 *   warning / warningSource — two action-scoped facts have no event of their own: the `alongside`
 *                             decision and the "managed stop was not confirmed" restart branch.
 *                             `connect.succeeded` still owns clearing the stale restart warning.
 *   closing                 — the teardown path marks the link dead before it releases the
 *                             transport; shutdown is not an event the FSM owns yet.
 *   linkBusy / linkToken    — the one-shot token API (`beginLinkWork`/`endLinkWork`/
 *                             `cancelLinkWork`) is the token plumbing P2 step 7 moves onto
 *                             `dispatch(activity.begin)`/`link.cancelled`; until then it is the
 *                             storage form of `activity`/`epoch`.
 *   remoteFailures / remoteEpisode / episodeSource / episodeCooldownUntil
 *                           — the watchdog's liveness counters. P2 step 9 moved the liveness
 *                             machine out of `host-lifecycle.ts` into `watchdog.ts`, which now
 *                             owns every policy write; `host-lifecycle.ts` keeps only the timer
 *                             primitive `stopRemoteHeartbeat` (it owns the timer block) and its
 *                             counter reset.
 *   connectPromise / restartPromise / reattachPromise
 *                           — executor-held by design (§2.4.5); the pipeline owns the promises,
 *                             the FSM owns `activity`.
 */
const SESSION_WRITERS = {
  status: ['runtime/fsm.ts', 'host-runtime.ts'],
  desired: ['runtime/fsm.ts', 'host-runtime.ts'],
  connectCancelled: ['runtime/fsm.ts', 'host-runtime.ts'],
  transportLost: ['runtime/fsm.ts', 'host-runtime.ts'],
  reconnectAttempts: ['runtime/fsm.ts', 'host-runtime.ts'],
  error: ['runtime/fsm.ts', 'host-runtime.ts'],
  phase: ['runtime/fsm.ts', 'host-runtime.ts', 'connect-progress.ts'],
  progress: ['runtime/fsm.ts', 'host-runtime.ts', 'connect-progress.ts'],
  warning: ['runtime/fsm.ts', 'host-runtime.ts', 'connect/launch.ts', 'connect/restart.ts'],
  warningSource: ['runtime/fsm.ts', 'host-runtime.ts', 'connect/launch.ts', 'connect/restart.ts'],
  closing: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts'],
  linkBusy: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts'],
  linkToken: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts'],
  remoteFailures: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts', 'watchdog.ts'],
  remoteEpisode: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts', 'watchdog.ts'],
  episodeSource: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts', 'watchdog.ts'],
  episodeCooldownUntil: ['runtime/fsm.ts', 'host-runtime.ts', 'host-lifecycle.ts', 'watchdog.ts'],
  connectPromise: ['connect/pipeline.ts'],
  restartPromise: ['connect/restart.ts'],
  reattachPromise: ['connect/reattach.ts'],
}

const SESSION_FIELDS = Object.keys(SESSION_WRITERS)

/**
 * One assignment to a session field of a runtime variable. Comparisons (`===`, `==`, `!==`) and
 * arrow functions are excluded by the lookahead; `+=`/`-=` count as writes.
 */
const sessionWrite = (field) => new RegExp(`\\b(?:runtime|rt)\\.${field}\\s*(?:\\+=|-=|=(?!=))`, 'g')

/** Every `runtime.<session field> = …` in one source text, as `[{ field, line }]`. */
function sessionWrites(text) {
  const stripped = stripComments(text)
  const found = []
  for (const field of SESSION_FIELDS) {
    for (const match of stripped.matchAll(sessionWrite(field))) {
      found.push({ field, line: stripped.slice(0, match.index).split('\n').length })
    }
  }
  return found
}

describe('runtime-writer-guard', () => {
  test('the session block has exactly one writer per field', async () => {
    // Sources only: the emitted `.js` twins are the same text and would double every finding.
    const files = await walkFiles(SRC, { extensions: /\.ts$/ })
    assert.ok(files.includes(path.join(SRC, 'service.ts')), 'the scanner must cover src recursively')
    const failures = []
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      const text = await readFile(file, 'utf8')
      for (const write of sessionWrites(text)) {
        const owners = SESSION_WRITERS[write.field]
        if (!owners.includes(relative)) {
          failures.push(`${relative}:${write.line} — runtime.${write.field} is written outside ${owners.join(', ')}`)
        }
      }
    }
    assert.deepEqual(failures, [], 'a module writes the session block the FSM owns')
  })

  test('planted regression: a status write in a non-owner module is flagged', () => {
    const fixture = ['export function mark(runtime) {', "  runtime.status = 'error'", '}'].join('\n')
    assert.deepEqual(sessionWrites(fixture), [{ field: 'status', line: 2 }])
    // Comparisons, arrow properties and other blocks stay clean.
    assert.deepEqual(sessionWrites("if (runtime.status === 'error') return"), [])
    assert.deepEqual(sessionWrites('const view = { status: runtime.status }'), [])
    assert.deepEqual(sessionWrites("job.phase = 'ready'"), [])
  })

  test('the non-FFSM modules no longer write the status at all', async () => {
    const files = await walkFiles(SRC, { extensions: /\.ts$/ })
    const offenders = []
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      if (SESSION_WRITERS.status.includes(relative)) continue
      const text = stripComments(await readFile(file, 'utf8'))
      const bare = [...text.matchAll(/\.status\s*=(?!=)/g)]
      for (const match of bare) {
        offenders.push(`${relative}:${text.slice(0, match.index).split('\n').length}`)
      }
    }
    assert.deepEqual(offenders, [], 'a `status` assignment exists outside the FSM/factory')
  })

  test('the Reporter no longer assigns a whole patch onto the runtime', async () => {
    // `Object.assign(runtime, { status, error, warning })` was the indirect writer `progress.set`
    // used. The method is gone; a reintroduced whole-object write must fail this guard too.
    const files = await walkFiles(SRC, { extensions: /\.ts$/ })
    const offenders = []
    for (const file of files) {
      const text = stripComments(await readFile(file, 'utf8'))
      if (/Object\.assign\(\s*(?:runtime|rt)\b/.test(text)) {
        offenders.push(path.relative(SRC, file).split(path.sep).join('/'))
      }
      if (/\bprogress\.set\s*\(/.test(text)) {
        offenders.push(`${path.relative(SRC, file).split(path.sep).join('/')} (progress.set)`)
      }
    }
    assert.deepEqual(offenders, [], 'a whole-runtime patch writer came back')
  })

  test('warningSource is still declared on the runtime type', async () => {
    // §2.3 item 4: the field that three modules wrote while it was undeclared must stay declared.
    const source = await readFile(path.join(SRC, 'host-runtime.ts'), 'utf8')
    assert.match(source, /warningSource:\s*WarningSource \| null/)
  })
})

/* ── watchdog-bus-guard (design-arch §1.7 / P2 step 9) ────────────────────────────────────────
 *
 * The watchdog used to reach its two one-shot actions back through `ctx` (`requestReattach`,
 * `repairTunnel`). P2 step 9 replaced them with a synchronous bus whose subscriber is a single
 * module, so "who reacts to a confirmed/recovered episode" has exactly one answer. These scans keep
 * that property from silently growing a second wiring point:
 *
 *   - `ctx.bus.subscribe(` exists only in `connect/watchdog.ts`;
 *   - the two retired reverse callbacks are gone from `src/`;
 *   - the liveness machine lives in `watchdog.ts`, and `host-lifecycle.ts` (which may not import
 *     `connect/*` except `connect/ownership`) does not import it.
 */
describe('watchdog-bus-guard', () => {
  test('the bus has exactly one subscriber', async () => {
    const subscribers = []
    for (const file of await walkFiles(SRC, { extensions: /\.ts$/ })) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      const text = stripComments(await readFile(file, 'utf8'))
      if (/\bbus\s*\.\s*subscribe\s*\(/.test(text)) subscribers.push(relative)
    }
    assert.deepEqual(subscribers, ['connect/watchdog.ts'], 'a second module subscribed to the watchdog bus')
  })

  test('the two reverse callbacks are gone from the sources', async () => {
    const offenders = []
    for (const file of await walkFiles(SRC, { extensions: /\.ts$/ })) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      const text = stripComments(await readFile(file, 'utf8'))
      // `requestReattach` is retired entirely. `repairTunnel` stays as the action's own name, but
      // it must never be reached again as a member of the context (`ctx.repairTunnel?.(…)`).
      if (/\brequestReattach\b/.test(text)) offenders.push(`${relative} names requestReattach`)
      if (/\.\s*repairTunnel\s*\??\.?\s*\(/.test(text)) offenders.push(`${relative} calls ctx.repairTunnel`)
    }
    assert.deepEqual(offenders, [], 'a retired reverse callback came back')
  })

  test('host-lifecycle does not import the watchdog it used to contain', async () => {
    const source = await readFile(path.join(SRC, 'host-lifecycle.ts'), 'utf8')
    assert.doesNotMatch(source, /from '\.\/watchdog\.js'/)
    assert.doesNotMatch(source, /noteRemoteUnreachable|remoteHeartbeatTick/)
    // The module that owns the timer block keeps only the two primitives.
    assert.match(source, /export function stopRemoteHeartbeat/)
  })
})

/* ── ssh-port-guard (design-ssh §7 S4 / decision D4) ───────────────────────────────────────────
 *
 * `SshPort` is the only surface the host half may depend on (P5). Two imports stay inside the
 * adapter layer: the ssh2 adapter module itself (`src/ssh.ts`, reached only by the assembly root
 * that builds the default factory) and the vendored ssh2 bundle (the adapter plus its SFTP
 * capability module). A third module reaching over either edge would re-couple the host half to
 * ssh2 — the exact debt P5 retires — so both are machine-checked.
 */
describe('ssh-port-guard', () => {
  const ADAPTER_MODULE = new Set(['ssh.ts'])
  const ASSEMBLY_ROOTS = new Set(['context.ts'])
  const SSH2_CONSUMERS = new Set(['ssh.ts', 'ssh-sftp.ts'])
  const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g

  async function importsOf(file) {
    const text = stripComments(await readFile(file, 'utf8'))
    return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1])
  }

  test('only the assembly root imports the ssh2 adapter module', async () => {
    const offenders = []
    for (const file of await walkFiles(SRC, { extensions: /\.ts$/ })) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      if (ADAPTER_MODULE.has(relative) || ASSEMBLY_ROOTS.has(relative)) continue
      for (const specifier of await importsOf(file)) {
        if (/(?:^|\/)ssh\.js$/.test(specifier)) offenders.push(`${relative} imports ${specifier}`)
      }
    }
    assert.deepEqual(offenders, [], 'a module outside the assembly root depends on the ssh2 adapter class')
  })

  test('only the adapter layer imports the vendored ssh2 bundle', async () => {
    const offenders = []
    for (const file of await walkFiles(SRC, { extensions: /\.ts$/ })) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      if (SSH2_CONSUMERS.has(relative)) continue
      for (const specifier of await importsOf(file)) {
        if (specifier.includes('vendor/ssh2')) offenders.push(`${relative} imports ${specifier}`)
      }
    }
    assert.deepEqual(offenders, [], 'a module outside the ssh2 adapter imports the vendored bundle')
  })

  test('the port declaration stays transport-agnostic', async () => {
    const source = await readFile(path.join(SRC, 'ssh-port.ts'), 'utf8')
    assert.doesNotMatch(source, /vendor\/ssh2/, 'the port must not name the ssh2 implementation')
    assert.doesNotMatch(source, /from '\.\/ssh\.js'/, 'the port must not import its adapter')
    // The EventEmitter shape is structural, so the port does not extend the node EventEmitter.
    assert.doesNotMatch(source, /extends EventEmitter/)
  })
})
