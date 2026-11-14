/**
 * Read-only `~/.ssh/config` parsing and alias discovery (design §15.1).
 *
 * Implements the subset of `ssh_config(5)` that matters for host discovery:
 * Host blocks with several patterns and `!` negation, global options before the
 * first Host, first-obtained-value-wins option resolution, and the `~` / `%h` /
 * `%r` / `%p` / `%d` tokens. `Include`, `Match` and `ProxyCommand` are reported
 * as unsupported rather than guessed at.
 */

const KNOWN_OPTIONS = new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'certificatefile',
  'proxyjump',
  'proxycommand',
  'serveraliveinterval',
  'serveralivecountmax',
  'connecttimeout',
  'identitiesonly',
  'preferredauthentications',
])

function parseLine(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  const space = trimmed.search(/\s/)
  let keyword
  let value
  if (eq >= 0 && (space < 0 || eq < space)) {
    keyword = trimmed.slice(0, eq)
    value = trimmed.slice(eq + 1)
  } else if (space >= 0) {
    keyword = trimmed.slice(0, space)
    value = trimmed.slice(space + 1)
  } else {
    keyword = trimmed
    value = ''
  }
  value = value.trim()
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1)
  }
  return { keyword: keyword.trim(), value }
}

function splitPatterns(value) {
  const patterns = []
  const negated = []
  for (const token of value.split(/\s+/)) {
    if (token === '') continue
    if (token.startsWith('!')) negated.push(token.slice(1))
    else patterns.push(token)
  }
  return { patterns, negated }
}

export function parseSshConfig(text) {
  const entries = []
  const globals = {}
  const unsupported = []
  const malformed = []
  let current = null

  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const parsed = parseLine(lines[index])
    if (!parsed) continue
    const keyword = parsed.keyword.toLowerCase()
    if (keyword === 'host') {
      const { patterns, negated } = splitPatterns(parsed.value)
      current = { patterns, negated, options: {}, line: lineNo }
      if (patterns.length === 0) malformed.push({ line: lineNo, text: lines[index] })
      else entries.push(current)
      continue
    }
    if (keyword === 'match') {
      unsupported.push({ line: lineNo, keyword: 'Match' })
      // Options inside a Match block only apply under conditions we cannot
      // evaluate; skip them until the next Host block.
      current = { patterns: ['__dsh_remote_go_match_block__'], negated: [], options: {}, line: lineNo }
      entries.push(current)
      continue
    }
    if (keyword === 'include') {
      unsupported.push({ line: lineNo, keyword: 'Include' })
      continue
    }
    if (!KNOWN_OPTIONS.has(keyword)) {
      // Unknown-but-harmless options are ignored; only flag keywords that would
      // change meaning if misread.
      if (keyword === 'proxycommand' || keyword === 'certificatefile')
        unsupported.push({ line: lineNo, keyword: parsed.keyword })
      continue
    }
    if (parsed.value === '') {
      malformed.push({ line: lineNo, text: lines[index] })
      continue
    }
    if (current) {
      current.options[keyword] = current.options[keyword] ?? []
      current.options[keyword].push(parsed.value)
    } else {
      globals[keyword] = globals[keyword] ?? []
      globals[keyword].push(parsed.value)
    }
  }
  return { entries, globals, unsupported, malformed }
}

export function matchHostPattern(pattern, value) {
  if (pattern === '*') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

export function entryMatches(entry, alias) {
  if (entry.patterns.includes('__dsh_remote_go_match_block__')) return false
  const positive = entry.patterns.some((pattern) => matchHostPattern(pattern, alias))
  if (!positive) return false
  return !entry.negated.some((pattern) => matchHostPattern(pattern, alias))
}

const ADDITIVE_OPTIONS = new Set(['identityfile', 'certificatefile'])

function effectiveOptions(globals, entries, alias, tokens) {
  const out = {}
  const apply = (/** @type {Record<string, string[]>} */ options) => {
    for (const [key, values] of Object.entries(options)) {
      const expanded = values.map((value) => expandTokens(value, tokens))
      if (ADDITIVE_OPTIONS.has(key)) {
        out[key] = [...(out[key] ?? []), ...expanded]
        continue
      }
      if (out[key] !== undefined) continue
      out[key] = expanded
    }
  }
  apply(globals)
  for (const entry of entries) {
    if (entryMatches(entry, alias)) apply(entry.options)
  }
  return out
}

export function expandTokens(value, tokens) {
  return String(value).replace(/%([hprd%])/g, (match, token) => {
    if (token === '%') return '%'
    return tokens[token] ?? match
  })
}

function expandTilde(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/')) return `${home.replace(/[\\/]+$/, '')}/${value.slice(2)}`
  return value
}

export function resolveSshAlias(parsed, alias, options = {}) {
  const home = options.home ?? '~'
  const baseTokens = { h: alias, r: '~', p: '22', d: home }
  const firstPass = effectiveOptions(parsed.globals, parsed.entries, alias, baseTokens)
  const host = firstPass.hostname?.[0] ?? alias
  const user = firstPass.user?.[0] ?? null
  const rawPort = firstPass.port?.[0] ?? '22'
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : 22
  const tokens = { h: host, r: user ?? '~', p: String(port), d: home }
  const resolved = effectiveOptions(parsed.globals, parsed.entries, alias, tokens)
  const identityFiles = (resolved.identityfile ?? []).map((value) => expandTilde(value, home))
  const proxyJump = resolved.proxyjump?.[0] ?? null
  return {
    alias,
    host,
    user,
    port,
    identityFiles,
    proxyJump,
    source: 'config',
  }
}

/**
 * List concrete, manually-dialable aliases from the config. Wildcard patterns
 * (`*`, `?`) and negations are skipped because they cannot be resolved without
 * a concrete target.
 * @param {ReturnType<typeof parseSshConfig>} parsed
 * @param {{ home?: string }} [options]
 */
export function discoverSshAliases(parsed, options = {}) {
  const out = []
  const seen = new Set()
  for (const entry of parsed.entries) {
    for (const pattern of entry.patterns) {
      if (pattern.includes('*') || pattern.includes('?') || pattern.startsWith('__dsh_remote_go_')) continue
      if (seen.has(pattern)) continue
      seen.add(pattern)
      const resolved = resolveSshAlias(parsed, pattern, options)
      out.push({ alias: pattern, host: resolved.host, user: resolved.user, port: resolved.port, source: 'config' })
    }
  }
  return out
}

export function resolveDestination(destination, options = {}) {
  const text = String(destination ?? '').trim()
  /** @type {import('./util.js').parseSshDestination extends never ? never : { user: string | null, host: string, port: number | null }} */
  const literal = parseDestinationLiteral(text)
  const parsed = parseSshConfig(options.configText ?? '')
  const home = options.home ?? '~'
  const aliases = discoverSshAliases(parsed, { home })
  const alias = aliases.find((item) => item.alias === text)
  if (alias) {
    const resolved = resolveSshAlias(parsed, text, { home })
    return {
      input: text,
      alias: text,
      host: resolved.host,
      user: literal.user ?? resolved.user,
      port: literal.port ?? resolved.port,
      identityFiles: resolved.identityFiles,
      proxyJump: resolved.proxyJump,
      source: 'config',
    }
  }
  // Literal destination: inherit globals (e.g. a global IdentityFile) but not
  // Host blocks that do not match the literal text.
  const tokens = { h: literal.host, r: literal.user ?? '~', p: String(literal.port ?? 22), d: home }
  const globals = effectiveOptions(parsed.globals, [], text, tokens)
  const identityFiles = (globals.identityfile ?? []).map((value) => expandTilde(value, home))
  return {
    input: text,
    alias: null,
    host: literal.host,
    user: literal.user,
    port: literal.port ?? 22,
    identityFiles,
    proxyJump: globals.proxyjump?.[0] ?? null,
    source: 'manual',
  }
}

function parseDestinationLiteral(text) {
  let user = null
  let rest = text
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let host = rest
  let port = null
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close > 0) {
      host = rest.slice(1, close)
      const tail = rest.slice(close + 1)
      if (/^:\d+$/.test(tail)) port = Number(tail.slice(1))
    }
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon > 0 && rest.indexOf(':') === colon) {
      const maybePort = rest.slice(colon + 1)
      if (/^\d{1,5}$/.test(maybePort)) {
        host = rest.slice(0, colon)
        port = Number(maybePort)
      }
    }
  }
  return { user: user || null, host, port }
}
