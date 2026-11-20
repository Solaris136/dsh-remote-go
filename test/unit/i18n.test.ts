/**
 * Dictionary parity for the browser half. The dictionary is the single source of the client's visible copy, so the two
 * languages are checked against each other, against the source literal, and against the ids the code derives keys from.
 * The two fallbacks `t()` owns are driven through the real factory with a deliberately incomplete pack: the shipped
 * dictionary has no gaps, which is exactly what the other assertions here keep true. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { REPO_ROOT } from '../helpers/source-scan.ts'

const requireFromHere = createRequire(import.meta.url)
const React = requireFromHere('react')
// `pnpm test` builds first (`pretest`), and `dist/client.js` is the one artifact the unit suite loads by absolute path.
const CLIENT_PATH = path.join(REPO_ROOT, 'dist', 'client.js')
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const read = (...parts) => readFileSync(path.join(REPO_ROOT, 'client', 'src', ...parts), 'utf8')
const DICT_SOURCE = read('i18n-dict.ts')
const CONSTANTS_SOURCE = read('constants.ts')
const CONNECT_WINDOW_SOURCE = read('connect-window.ts')
/** The dictionary literal as written, from `const STRINGS = {` up to its `} as const satisfies`. */
function stringsLiteral() {
  const start = DICT_SOURCE.indexOf('const STRINGS = {')
  assert.ok(start >= 0, 'i18n-dict.ts must open `const STRINGS = {`')
  const end = DICT_SOURCE.indexOf('\n} as const satisfies', start)
  assert.ok(end > start, 'the dictionary literal must be followed by its `as const satisfies` clause')
  return DICT_SOURCE.slice(start, end)
}
// One top-level entry of the literal: an identifier or a quoted key, then its pair.
const KEY_LINE = /^ {2}(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*\[/gm
const sourceKeys = () => [...stringsLiteral().matchAll(KEY_LINE)].map((match) => match[1] ?? match[2])
/** Load the built plugin and return its test seam plus the lines it warned about. */
function loadClientSeam() {
  const warnings = []
  const sandbox = {
    console: {
      warn(message) {
        warnings.push(String(message))
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    EventSource: undefined,
    fetch: undefined,
    document: undefined,
    getComputedStyle: undefined,
  }
  sandbox.window = {
    innerHeight: 800,
    __ModuleLoader__: {
      load(declaration) {
        sandbox.declaration = declaration
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH })
  const declaration = sandbox.declaration
  assert.ok(declaration, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(declaration.id, 'dsh-remote-go')
  const plugin = declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'client.js may only require react')
    return React
  })
  assert.ok(plugin && plugin.__test, 'the plugin must expose its __test seam')
  return { seam: plugin.__test, warnings }
}
const client = loadClientSeam()
/** `{name}` occurrences, sorted, so a localization may reorder them but not drop or rename one. */
function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',')
}
const zhKeys = Object.keys(client.seam.zh)
const enKeys = Object.keys(client.seam.en)

test('zh and en define exactly the same keys, in both directions', () => {
  const declared = sourceKeys()
  const zhSet = new Set(zhKeys)
  const enSet = new Set(enKeys)
  assert.deepEqual(
    { onlyInZh: zhKeys.filter((key) => !enSet.has(key)), onlyInEn: enKeys.filter((key) => !zhSet.has(key)) },
    { onlyInZh: [], onlyInEn: [] },
    'the two languages must define the same key set',
  )
  const declaredSet = new Set(declared)
  assert.deepEqual(
    {
      missingFromSource: zhKeys.filter((key) => !declaredSet.has(key)),
      missingFromRuntime: [...declaredSet].filter((key) => !zhSet.has(key)),
    },
    { missingFromSource: [], missingFromRuntime: [] },
    'the runtime dictionary and the source literal must agree',
  )
})

test('every dictionary entry is a non-empty string on both sides', () => {
  for (const key of zhKeys) {
    assert.equal(typeof client.seam.zh[key], 'string', 'zh.' + key + ' must be a string')
    assert.equal(typeof client.seam.en[key], 'string', 'en.' + key + ' must be a string')
    assert.notEqual(client.seam.zh[key].trim(), '', 'zh.' + key + ' must not be blank')
    assert.notEqual(client.seam.en[key].trim(), '', 'en.' + key + ' must not be blank')
  }
})

test('both sides of an entry use the same placeholders', () => {
  for (const key of zhKeys) {
    assert.equal(
      placeholders(client.seam.en[key]),
      placeholders(client.seam.zh[key]),
      'placeholder mismatch at ' +
        key +
        ': zh=' +
        placeholders(client.seam.zh[key]) +
        ' en=' +
        placeholders(client.seam.en[key]),
    )
  }
})

test('the dictionary source defines no duplicate keys', () => {
  const keys = sourceKeys()
  const seen = new Set()
  const duplicates = keys.filter((key) => {
    if (seen.has(key)) return true
    seen.add(key)
    return false
  })
  // A duplicate is invisible at runtime: the object literal keeps the last pair and nothing reports a redeclaration, so
  // only a source scan can catch it.
  assert.deepEqual(duplicates, [], 'duplicate dictionary keys are silently overwritten: ' + duplicates.join(', '))
  assert.equal(seen.size, keys.length)
})

test('the dictionary still carries every string', () => {
  assert.ok(zhKeys.length >= 270, 'expected at least 270 entries, found ' + zhKeys.length)
  assert.equal(zhKeys.length, sourceKeys().length, 'runtime keys and source keys must stay one-to-one')
})

test('a key missing from both languages renders as the key itself and warns once', () => {
  client.warnings.length = 0
  const translate = client.seam.makeFallbackT('zh', { zh: {}, en: {} })
  const missing = 'zz.missing.key'
  assert.equal(translate(missing), missing)
  assert.equal(translate(missing), missing)
  assert.deepEqual(client.warnings, ['[dsh-remote-go] no dictionary entry for "' + missing + '"; showing the key'])
})

test('a gap in the requested language falls back to the other one and warns once', () => {
  client.warnings.length = 0
  const translate = client.seam.makeFallbackT('zh', { zh: {}, en: { addHost: 'Add host' } })
  assert.equal(translate('addHost'), 'Add host')
  assert.equal(translate('addHost'), 'Add host')
  assert.deepEqual(client.warnings, ['[dsh-remote-go] the zh dictionary has no "addHost"; showing en'])
})

test('the shipped translator interpolates parameters instead of dropping them', () => {
  const translate = client.seam.makeFallbackT('zh')
  assert.equal(translate('summary', { connected: 1, total: 3 }), '已连接 1 / 共 3')
  assert.equal(translate('summary', { connected: 1 }), '已连接 1 / 共 {total}')
})

test('every connect phase has its step label and its log label', () => {
  const phases = [...(/const PHASES = \[([^\]]*)\]/.exec(CONSTANTS_SOURCE)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(phases.length >= 7, 'expected the connect phases, found ' + phases.length)
  for (const phase of phases) {
    for (const prefix of ['phase.', 'connectLogPhase.']) {
      assert.equal(typeof client.seam.zh[prefix + phase], 'string', 'missing zh label for ' + prefix + phase)
      assert.equal(typeof client.seam.en[prefix + phase], 'string', 'missing en label for ' + prefix + phase)
    }
  }
  const logPhases = [
    ...(/const CONNECT_LOG_PHASES = new Set\(\[([^\]]*)\]\)/.exec(CONNECT_WINDOW_SOURCE)?.[1] ?? '').matchAll(
      /'([^']+)'/g,
    ),
  ].map((match) => match[1])
  assert.deepEqual(logPhases, phases, 'the log phases and the step phases must stay the same contract list')
})

test('every host status has its label, its hint and its action', () => {
  const statusBlock = /const STATUS = \{([\s\S]*?)\n\}/.exec(CONSTANTS_SOURCE)?.[1]
  assert.ok(statusBlock, 'constants.ts must define the STATUS table')
  const ids = [...statusBlock.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z][\w]*)):\s*\{/gm)].map(
    (match) => match[1] ?? match[2],
  )
  assert.ok(ids.length >= 8, 'expected every HostStatus, found ' + ids.length)
  for (const id of ids) {
    // `statusOf` builds the two names from the contract id; the transform is repeated so a rename on either side fails.
    const name = id.replace(/(?:^|-)([a-z])/g, (_all, letter) => letter.toUpperCase())
    assert.equal(typeof client.seam.zh['status' + name], 'string', 'missing status label for ' + id)
    assert.equal(typeof client.seam.en['statusHint' + name], 'string', 'missing status hint for ' + id)
  }
  const actions = [...statusBlock.matchAll(/action:\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(actions.length >= ids.length, 'every status must name a primary action')
  for (const action of actions)
    assert.equal(typeof client.seam.zh[action], 'string', 'missing action label for ' + action)
})

test('every local error view is a complete bilingual pair', () => {
  // `LOCAL_ERRORS` is the client's second bilingual table; it is not dictionary copy, so the same shape check applies.
  const table = client.seam.LOCAL_ERRORS
  const codes = Object.keys(table)
  assert.ok(codes.length >= 5, 'expected the local ErrorView codes, found ' + codes.length)
  const check = (label, pair) => {
    assert.equal(typeof pair?.zh, 'string', label + '.zh must be a string')
    assert.equal(typeof pair?.en, 'string', label + '.en must be a string')
    assert.notEqual(pair.zh.trim(), '', label + '.zh must not be blank')
    assert.notEqual(pair.en.trim(), '', label + '.en must not be blank')
    assert.equal(placeholders(pair.en), placeholders(pair.zh), 'placeholder mismatch at ' + label)
  }
  for (const code of codes) {
    const view = table[code]
    assert.equal(view.code, code, 'the table key and the view code must agree at ' + code)
    check(code + '.title', view.title)
    check(code + '.detail', view.detail)
    assert.ok(Array.isArray(view.nextSteps) && view.nextSteps.length > 0, code + '.nextSteps must not be empty')
    view.nextSteps.forEach((step, index) => check(code + '.nextSteps[' + index + ']', step))
  }
})
