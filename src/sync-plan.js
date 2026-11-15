/**
 * Local→remote sync planning: which plugins, config rows and credentials travel, and whether the remote copy is replaced or appended; pure, so every rule is unit-testable without SSH.
 */
import { createHash } from 'node:crypto'
import { isPlainObject } from './util.js'
import { satisfiesRange } from './version.js'

/** Plugins that must never be copied: this plugin itself and Windows-only bridges. */
export const SYNC_DENY_PLUGINS = ['dsh-remote-go', 'dsh-windows-mcp']

/** Credential records that describe this machine's browser session, not the account. */
export const SYNC_DENY_RECORDS = ['client-connection/']

/** Rows that name a provider without spelling a credential reference. */
export const SYNC_CORE_ROW_IDS = ['agent-default-model']

/** DSH's `uname -m` spellings mapped to the architecture a package manifest declares. */
const ARCH_ALIASES = new Map([
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  ['x64', 'x64'],
  ['aarch64', 'arm64'],
  ['arm64', 'arm64'],
  ['armv7l', 'arm'],
])

const ENV_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function normalizeArch(arch) {
  return ARCH_ALIASES.get(String(arch ?? '').toLowerCase()) ?? null
}

/** A dependency spec the remote registry can resolve by exact version. */
export function isRegistrySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return false
  if (/^(?:link|file|workspace|portal|git|github|gitlab|bitbucket|https?):/i.test(text)) return false
  if (/^(?:git\+|npm:)/i.test(text)) return false
  return (
    /^(?:\^|~|>=|<=|>|<|=)?\s*v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(text) || /^(?:\*|latest|x)$/i.test(text)
  )
}

export function rowId(row) {
  return isPlainObject(row) && typeof row.id === 'string' && row.id !== '' ? row.id : null
}

/** Every string in a row config, used for credential-reference and path detection. */
export function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out)
  else if (isPlainObject(value)) for (const item of Object.values(value)) stringsOf(item, out)
  return out
}

/** Names a row spells as `apiKeyEnv`-style references. */
export function credentialNamesOf(row) {
  const out = new Set()
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!isPlainObject(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:apiKeyEnv|apiKeyRef|credentialRef|credentialRefName)$/i.test(key) && typeof item === 'string') {
        out.add(item.trim())
      } else {
        walk(item)
      }
    }
  }
  walk(row)
  return out
}

/** A row whose values point at a machine-local executable or Windows path cannot travel. */
export function isPortableRow(row) {
  const values = stringsOf(row)
  if (values.some((value) => /^[A-Za-z]:[\\/]/.test(value))) return false
  if (values.some((value) => /\\\\wsl|\/mnt\/[a-z]\//i.test(value))) return false
  if (values.some((value) => /\.(?:exe|cmd|bat|ps1)$/i.test(value))) return false
  if (values.some((value) => /(?:^|[^A-Za-z])pythonw?(?:\.exe)?\b/i.test(value))) return false
  return true
}

function hasBuildScript(manifest) {
  const scripts = isPlainObject(manifest?.scripts) ? manifest.scripts : {}
  return ['preinstall', 'install', 'postinstall'].some((key) => typeof scripts[key] === 'string')
}

function platformAllowed(manifest, options) {
  const os = Array.isArray(manifest?.os) ? manifest.os : null
  if (os && !os.includes('linux') && !os.includes('!win32')) return false
  const cpu = Array.isArray(manifest?.cpu) ? manifest.cpu : null
  const arch = normalizeArch(options.remoteArch)
  if (cpu && arch && !cpu.includes(arch)) return false
  return true
}

function enginesAllowed(manifest, options) {
  const dsh = manifest?.engines?.dsh
  if (typeof dsh === 'string' && dsh.trim() !== '' && options.remoteVersion) {
    if (!satisfiesRange(dsh, options.remoteVersion)) return false
  }
  const node = manifest?.engines?.node
  if (typeof node === 'string' && node.trim() !== '' && options.nodeVersion) {
    if (!satisfiesRange(node, options.nodeVersion)) return false
  }
  return true
}

function rowReferences(row, names) {
  if (names.size === 0) return false
  return stringsOf(row).some((value) => names.has(value.trim()))
}

/**
 * Plan one sync. `local` and `remote` are plain snapshots (see sync-local/sync-run);
 * `options` carries the two toggles plus the remote platform/version facts.
 */
export function planSync(local, remote, options = {}) {
  const credentials = planCredentials(local, options)
  const refNames = new Set(credentials.refs.map((entry) => entry.name))
  const plugins = planPlugins(local, remote, options)
  const syncedNames = new Set(plugins.filter((entry) => entry.action !== 'skip').map((entry) => entry.name))
  const rows = planRows(local, remote, options, { refNames, syncedNames })
  const counts = {
    pluginsAdd: plugins.filter((entry) => entry.action === 'add').length,
    pluginsKeep: plugins.filter((entry) => entry.action === 'keep').length,
    pluginsSkip: plugins.filter((entry) => entry.action === 'skip').length,
    rowsApply: rows.entries.filter((entry) => entry.action !== 'skip').length,
    rowsSkip: rows.entries.filter((entry) => entry.action === 'skip').length,
    refs: credentials.refs.length,
    records: credentials.records.length,
  }
  return {
    enabled: { credentials: options.credentials === true, plugins: options.plugins === true },
    plugins,
    rows,
    credentials,
    counts,
    notes: [...rows.notes, ...credentials.notes],
  }
}

function planPlugins(local, remote, options) {
  const list = []
  if (options.plugins !== true) return list
  const deps = isPlainObject(local.packageJson?.dependencies) ? local.packageJson.dependencies : {}
  const remoteDeps = isPlainObject(remote.packageJson?.dependencies) ? remote.packageJson.dependencies : {}
  for (const name of Object.keys(deps).sort()) {
    const spec = deps[name]
    const manifest = local.manifests?.[name] ?? null
    const entry = {
      name,
      spec: String(spec ?? ''),
      version: manifest?.version ?? null,
      action: 'skip',
      reason: null,
      warning: null,
    }
    if (name.startsWith('@deepseek-ai/')) entry.reason = 'built-in'
    else if (SYNC_DENY_PLUGINS.includes(name)) entry.reason = 'denied'
    else if (!manifest || !entry.version) entry.reason = 'not-installed'
    else if (!isRegistrySpec(spec)) entry.reason = 'not-registry'
    else if (!platformAllowed(manifest, options)) entry.reason = 'platform'
    else if (!enginesAllowed(manifest, options)) entry.reason = 'engines'
    else {
      entry.action = 'add'
      if (hasBuildScript(manifest)) entry.warning = 'build-scripts'
      const remoteSpec = remoteDeps[name]
      if (typeof remoteSpec === 'string' && remoteSpec === entry.version) {
        entry.action = 'keep'
        entry.reason = null
      }
    }
    list.push(entry)
  }
  return list
}

function planRows(local, remote, options, context) {
  const entries = []
  const notes = []
  if (options.credentials !== true && options.plugins !== true) return { entries, notes }
  if (local.rowsError) {
    notes.push({ code: 'local-rows', reason: local.rowsError })
    return { entries, notes }
  }
  if (!Array.isArray(local.rows)) {
    notes.push({ code: 'local-rows', reason: 'missing' })
    return { entries, notes }
  }
  if (remote.rowsError) {
    notes.push({ code: 'remote-rows', reason: remote.rowsError })
    return { entries, notes }
  }
  const remoteRows = Array.isArray(remote.rows) ? remote.rows : []
  const remoteIds = new Map()
  remoteRows.forEach((row) => {
    const id = rowId(row)
    if (id) remoteIds.set(id, row)
  })
  for (const row of local.rows) {
    if (!isPlainObject(row)) continue
    // An `insert` row adds a module (an MCP server, a provider) and is never portable.
    if (Array.isArray(row.insert) || isPlainObject(row.insert)) {
      entries.push({ id: null, name: null, action: 'skip', reason: 'insert', row })
      continue
    }
    const id = rowId(row)
    const name = typeof row.name === 'string' && row.name !== '' ? row.name : null
    const entry = { id, name, action: 'skip', reason: null, row }
    const ownedByPlugin = options.plugins === true && name !== null && context.syncedNames.has(name)
    const referencesCredential = options.credentials === true && rowReferences(row, context.refNames)
    const coreRow = options.credentials === true && id !== null && SYNC_CORE_ROW_IDS.includes(id)
    if (!ownedByPlugin && !referencesCredential && !coreRow) entry.reason = 'not-selected'
    else if (!isPortableRow(row)) entry.reason = 'local-path'
    else if (id !== null && remoteIds.has(id)) entry.action = 'replace'
    else entry.action = 'append'
    entries.push(entry)
  }
  return { entries, notes }
}

function planCredentials(local, options) {
  const refs = []
  const records = []
  const notes = []
  if (options.credentials !== true) return { refs, records, notes, skipped: [] }
  const skipped = []
  if (local.credentialsError) {
    notes.push({ code: 'local-credentials', reason: local.credentialsError })
    return { refs, records, notes, skipped }
  }
  const sourceRefs = isPlainObject(local.credentials?.refs) ? local.credentials.refs : {}
  const names = new Set(Object.keys(sourceRefs).filter((name) => ENV_REF_RE.test(name)))
  for (const row of Array.isArray(local.rows) ? local.rows : []) {
    for (const name of credentialNamesOf(row)) if (ENV_REF_RE.test(name)) names.add(name)
  }
  for (const name of [...names].sort()) {
    const stored = typeof sourceRefs[name] === 'string' ? sourceRefs[name] : ''
    const ambient = typeof local.env?.[name] === 'string' ? local.env[name] : ''
    const value = stored !== '' ? stored : ambient
    if (value === '') {
      skipped.push({ name, reason: 'empty' })
      continue
    }
    refs.push({ name, value })
  }
  const sourceRecords = isPlainObject(local.credentials?.records) ? local.credentials.records : {}
  for (const key of Object.keys(sourceRecords).sort()) {
    if (SYNC_DENY_RECORDS.some((prefix) => key.startsWith(prefix))) {
      skipped.push({ name: key, reason: 'local-only' })
      continue
    }
    const record = sourceRecords[key]
    if (!isPlainObject(record) || typeof record.kind !== 'string' || !isPlainObject(record.payload)) {
      skipped.push({ name: key, reason: 'invalid' })
      continue
    }
    records.push({ key, kind: record.kind, payload: record.payload })
  }
  return { refs, records, notes, skipped }
}

/** Stable identity of a plan: equal hashes mean the remote already carries it. */
export function planHash(plan) {
  const digest = createHash('sha256')
  digest.update(
    stableStringify({
      enabled: plan.enabled,
      plugins: plan.plugins
        .filter((entry) => entry.action === 'add' || entry.action === 'keep')
        .map((entry) => [entry.name, entry.version, entry.action]),
      rows: plan.rows.entries
        .filter((entry) => entry.action !== 'skip')
        .map((entry) => [entry.id, entry.name, entry.row]),
      refs: plan.credentials.refs.map((entry) => [entry.name, entry.value]),
      records: plan.credentials.records.map((entry) => [entry.key, entry.kind, entry.payload]),
    }),
  )
  return digest.digest('hex')
}

/** True when the plan has nothing left to write. */
export function planHasWork(plan) {
  if (plan.plugins.some((entry) => entry.action === 'add')) return true
  if (plan.rows.entries.some((entry) => entry.action !== 'skip')) return true
  return plan.credentials.refs.length > 0 || plan.credentials.records.length > 0
}

/**
 * Apply the planned rows to the remote array: a row whose id already exists is
 * replaced in place, everything else is appended at the end (later rows win in a
 * loader patch, so the local copy keeps precedence).
 */
export function mergePatchRows(remoteRows, entries) {
  const rows = Array.isArray(remoteRows) ? remoteRows.slice() : []
  let replaced = 0
  let appended = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.action === 'skip' || !isPlainObject(entry.row)) continue
    if (entry.action === 'replace' && entry.id) {
      const index = rows.findIndex((row) => rowId(row) === entry.id)
      if (index >= 0) {
        rows[index] = entry.row
        replaced += 1
        continue
      }
    }
    rows.push(entry.row)
    appended += 1
  }
  return { rows, replaced, appended }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}
