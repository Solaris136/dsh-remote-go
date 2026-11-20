/** Read-only `~/.ssh/config` parsing and alias discovery for the `ssh_config(5)` subset; `Include`, `Match` and
 * `ProxyCommand` are reported, never guessed. */

/** One `Host` (or `Match`) block and the options that follow it. */
export type SshConfigEntry = { patterns: string[]; negated: string[]; options: Record<string, string[]>; line: number }
/** One keyword the parser deliberately does not act on. */
export type UnsupportedLine = { line: number; keyword: string }
/** One line the parser could not use. */
export type MalformedLine = { line: number; text: string }

export interface SshConfigParseResult {
  entries: SshConfigEntry[]
  globals: Record<string, string[]>
  unsupported: UnsupportedLine[]
  malformed: MalformedLine[]
}

/** One concrete alias listed for the host picker. */
export type DiscoveredAlias = { alias: string; host: string; user: string | null; port: number; source: 'config' }
/** A fully resolved destination, whether it came from an alias or was typed literally. */
export interface ResolvedDestination {
  input: string
  alias: string | null
  host: string
  user: string | null
  port: number
  identityFiles: string[]
  proxyJump: string | null
  source: 'config' | 'manual'
}

/** One alias resolved through the config blocks that match it. */
export interface ResolvedSshAlias {
  alias: string
  host: string
  user: string | null
  port: number
  identityFiles: string[]
  proxyJump: string | null
  source: 'config'
}

/** One parsed `keyword value` line. */
type ConfigLine = { keyword: string; value: string }
/** Options accepted by the resolution helpers. */
export type SshResolveOptions = { home?: string }
/** Options accepted by `resolveDestination`. */
export type SshDestinationOptions = SshResolveOptions & { configText?: string }

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

// `Host = x` keeps `= x` as its value: the first whitespace wins unless `=` comes before it.
function parseLine(line: string): ConfigLine | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  const space = trimmed.search(/\s/)
  let keyword: string
  let value: string
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

function splitPatterns(value: string): { patterns: string[]; negated: string[] } {
  const patterns: string[] = []
  const negated: string[] = []
  for (const token of value.split(/\s+/)) {
    if (token === '') continue
    if (token.startsWith('!')) negated.push(token.slice(1))
    else patterns.push(token)
  }
  return { patterns, negated }
}

export function parseSshConfig(text: unknown): SshConfigParseResult {
  const entries: SshConfigEntry[] = []
  const globals: Record<string, string[]> = {}
  const unsupported: UnsupportedLine[] = []
  const malformed: MalformedLine[] = []
  // A repeated keyword appends: `IdentityFile` may legitimately appear several times in one block.
  const appendOption = (target: Record<string, string[]>, key: string, value: string) => {
    target[key] ??= []
    target[key].push(value)
  }
  let current: SshConfigEntry | null = null

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
      // Options inside a Match block only apply under conditions we cannot evaluate; skip to the next Host.
      current = { patterns: ['__dsh_remote_go_match_block__'], negated: [], options: {}, line: lineNo }
      entries.push(current)
      continue
    }
    if (keyword === 'include') {
      unsupported.push({ line: lineNo, keyword: 'Include' })
      continue
    }
    if (!KNOWN_OPTIONS.has(keyword)) {
      // Unknown-but-harmless options are ignored; only flag keywords that would change meaning if misread.
      if (keyword === 'proxycommand' || keyword === 'certificatefile')
        unsupported.push({ line: lineNo, keyword: parsed.keyword })
      continue
    }
    if (parsed.value === '') {
      malformed.push({ line: lineNo, text: lines[index] })
      continue
    }
    appendOption(current ? current.options : globals, keyword, parsed.value)
  }
  return { entries, globals, unsupported, malformed }
}

export function matchHostPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

export function entryMatches(entry: SshConfigEntry, alias: string): boolean {
  if (entry.patterns.includes('__dsh_remote_go_match_block__')) return false
  if (!entry.patterns.some((pattern) => matchHostPattern(pattern, alias))) return false
  return !entry.negated.some((pattern) => matchHostPattern(pattern, alias))
}

const ADDITIVE_OPTIONS = new Set(['identityfile', 'certificatefile'])

function effectiveOptions(
  globals: Record<string, string[]>,
  entries: SshConfigEntry[],
  alias: string,
  tokens: Record<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const apply = (options: Record<string, string[]>) => {
    for (const [key, values] of Object.entries(options)) {
      const expanded = values.map((value) => expandTokens(value, tokens))
      if (ADDITIVE_OPTIONS.has(key)) out[key] = [...(out[key] ?? []), ...expanded]
      else if (out[key] === undefined) out[key] = expanded
    }
  }
  apply(globals)
  for (const entry of entries) {
    if (entryMatches(entry, alias)) apply(entry.options)
  }
  return out
}

export function expandTokens(value: unknown, tokens: Record<string, string>): string {
  return String(value).replace(/%([hprd%])/g, (match, token) => {
    if (token === '%') return '%'
    return tokens[token] ?? match
  })
}

function expandTilde(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return `${home.replace(/[\\/]+$/, '')}/${value.slice(2)}`
  return value
}

export function resolveSshAlias(
  parsed: SshConfigParseResult,
  alias: string,
  options: SshResolveOptions = {},
): ResolvedSshAlias {
  const home = options.home ?? '~'
  const baseTokens = { h: alias, r: '~', p: '22', d: home }
  const firstPass = effectiveOptions(parsed.globals, parsed.entries, alias, baseTokens)
  const host = firstPass.hostname?.[0] ?? alias
  const user = firstPass.user?.[0] ?? null
  const rawPort = firstPass.port?.[0] ?? '22'
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : 22
  // Second pass: `%h`/`%p` now resolve to the values the first pass found.
  const tokens = { h: host, r: user ?? '~', p: String(port), d: home }
  const resolved = effectiveOptions(parsed.globals, parsed.entries, alias, tokens)
  const identityFiles = (resolved.identityfile ?? []).map((value) => expandTilde(value, home))
  const proxyJump = resolved.proxyjump?.[0] ?? null
  return { alias, host, user, port, identityFiles, proxyJump, source: 'config' }
}

/** List concrete, manually-dialable aliases: a wildcard or negated pattern cannot resolve without a real target. */
export function discoverSshAliases(parsed: SshConfigParseResult, options: SshResolveOptions = {}): DiscoveredAlias[] {
  const out: DiscoveredAlias[] = []
  const seen = new Set<string>()
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

export function resolveDestination(destination: unknown, options: SshDestinationOptions = {}): ResolvedDestination {
  const text = String(destination ?? '').trim()
  const literal = parseDestinationLiteral(text)
  const parsed = parseSshConfig(options.configText ?? '')
  const home = options.home ?? '~'
  const alias = discoverSshAliases(parsed, { home }).find((item) => item.alias === text)
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
  // Literal destination: inherit globals (e.g. a global IdentityFile) but not Host blocks that do not match
  // the literal text, which is why the entries list passed below is empty.
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

function parseDestinationLiteral(text: string): { user: string | null; host: string; port: number | null } {
  let user: string | null = null
  let rest = text
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let host = rest
  let port: number | null = null
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close > 0) {
      host = rest.slice(1, close)
      const tail = rest.slice(close + 1)
      if (/^:\d+$/.test(tail)) port = Number(tail.slice(1))
    }
  } else {
    const colon = rest.lastIndexOf(':')
    // Only an unbracketed `host:port`: a bare IPv6 literal keeps every colon.
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
