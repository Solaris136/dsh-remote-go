/**
 * Durable local state under `$DSH_HOME/remote-go/`: hosts.json, settings.json and secrets.json; writes are atomic, a corrupt file is kept aside before the next write replaces it.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readJsonFile, withProcessLock, writeJsonAtomic } from './atomic-json.js'
import type { JsonFileSystem } from './atomic-json.js'
import type { Logger } from './util.js'
import { deepMerge, isPlainObject, nowIso, randomId } from './util.js'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from './settings.js'
import type { HostEntry, Settings } from './settings.js'

/** The in-memory snapshot `load()` returns and every accessor reads. */
export interface StoreData {
  hosts: HostEntry[]
  settings: Settings
}

/** Constructor input: the state directory plus the injectable fs / logger. */
export interface HostStoreOptions {
  dir: string
  logger?: Logger
  fsImpl?: JsonFileSystem
}

/** A JSON array or no entries: a state file that is not an array contributes nothing. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * A JSON object or nothing. Deliberately looser than `isPlainObject`: an array *is* an
 * object to `typeof`, and the secrets file has always been adopted as-is in that case, so
 * the type must not quietly tighten a persisted shape.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export class HostStore {
  declare dir: string
  declare logger: Logger
  declare fs: JsonFileSystem
  declare hostsFile: string
  declare settingsFile: string
  declare secretsFile: string
  declare data: StoreData
  declare secrets: Record<string, unknown>
  declare corrupt: Set<string>
  declare loaded: boolean

  constructor(options: HostStoreOptions) {
    this.dir = options.dir
    this.logger = options.logger ?? console
    this.fs = options.fsImpl ?? fs
    this.hostsFile = path.join(this.dir, 'hosts.json')
    this.settingsFile = path.join(this.dir, 'settings.json')
    this.secretsFile = path.join(this.dir, 'secrets.json')
    this.data = { hosts: [], settings: defaultSettings() }
    this.secrets = {}
    /** Basenames of state files that were unreadable and moved aside on this load. */
    this.corrupt = new Set()
    this.loaded = false
  }

  /** Whether `hosts.json` had to be quarantined, i.e. the host list is the empty fallback. */
  get hostsCorrupt(): boolean {
    return this.corrupt.has('hosts.json')
  }

  async load(): Promise<StoreData> {
    if (this.loaded) return this.data
    try {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] cannot create state directory:', error)
    }
    this.data.hosts = asArray(await this.#readJson(this.hostsFile, [])).filter(
      (item): item is HostEntry => item !== null && typeof item === 'object',
    )
    this.data.settings = sanitizeSettings(await this.#readJson(this.settingsFile, null))
    const secrets = await this.#readJson(this.secretsFile, null)
    this.secrets = asRecord(secrets) ?? {}
    this.loaded = true
    return this.data
  }

  async #readJson(file: string, fallback: unknown): Promise<unknown> {
    const result = await readJsonFile(file, { fs: this.fs, logger: this.logger })
    if (result.status === 'ok') return result.value
    // Only bytes that are not JSON are quarantined. A file that merely could not be read right
    // now (EACCES, a transient IO error) falls back for this run and is left in place: renaming
    // it would turn a permission problem into a silently emptied host list.
    // A corrupt file used to fall back to `[]` / defaults silently, and the next write then
    // replaced it for good — losing every host, including the pinned fingerprints that make a
    // host-key change detectable. Keep the bytes aside first, then recover.
    if (result.status === 'corrupt') await this.#quarantine(file)
    return fallback
  }

  /**
   * Rename one unreadable state file to `<name>.corrupt-<iso>` so it survives the recovery
   * write. A failure here is logged and swallowed: recovery must not be blocked by it.
   */
  async #quarantine(file: string): Promise<void> {
    const name = path.basename(file)
    // The flag means "this file was unreadable", whether or not a copy could be made.
    this.corrupt.add(name)
    // Colons and dots are invalid (Windows) or noisy in a file name, so the ISO stamp is flattened.
    const target = `${file}.corrupt-${nowIso().replace(/[:.]/g, '-')}`
    try {
      await this.fs.rename(file, target)
      this.logger.warn?.(`[dsh-remote-go] ${name} was unreadable; kept a copy as ${path.basename(target)}`)
    } catch (error) {
      this.logger.warn?.(`[dsh-remote-go] cannot keep a copy of the unreadable ${name}:`, error)
    }
  }

  #writeJson(file: string, value: unknown, mode = 0o600): Promise<void> {
    return withProcessLock(`${file}.lock`, { fs: this.fs, logger: this.logger }, () =>
      writeJsonAtomic(file, value, {
        dir: this.dir,
        fs: this.fs,
        logger: this.logger,
        fileMode: mode,
      }),
    ).then((result) => {
      // The recovered file is the authority again: the next successful write clears the flag,
      // so a user who rebuilds the list is not warned forever about a file that is now valid.
      this.corrupt.delete(path.basename(file))
      return result
    })
  }

  async #persistHosts(): Promise<void> {
    await this.#writeJson(this.hostsFile, this.data.hosts)
  }

  async #persistSettings(): Promise<void> {
    await this.#writeJson(this.settingsFile, this.data.settings)
  }

  async #persistSecrets(): Promise<void> {
    await this.#writeJson(this.secretsFile, this.secrets)
  }

  listHosts(): HostEntry[] {
    return this.data.hosts.map((host) => ({ ...host }))
  }

  getHost(id: string): HostEntry | null {
    const host = this.data.hosts.find((item) => item.id === id)
    return host ? { ...host } : null
  }

  async upsertHost(rawEntry: unknown, options: { settings?: Settings } = {}): Promise<HostEntry | null> {
    await this.load()
    // A caller may name an id only if this store already issued it: the id keys the secrets
    // file, the proxy's per-host routes and the client's host links, so a client-chosen id
    // (malformed, too long, or a duplicate of another host) is not something to adopt. A new
    // host always gets a fresh `h_…` and learns it from the returned HostView.
    const rawId = isPlainObject(rawEntry) && typeof rawEntry.id === 'string' ? rawEntry.id : ''
    const existing = rawId === '' ? null : this.getHost(rawId)
    const entry = sanitizeHostEntry(rawEntry, { settings: options.settings ?? this.data.settings, existing })
    entry.id = existing ? existing.id : randomId('h')
    const index = this.data.hosts.findIndex((item) => item.id === entry.id)
    if (index >= 0) this.data.hosts[index] = { ...this.data.hosts[index], ...entry }
    else this.data.hosts.push(entry)
    await this.#persistHosts()
    return this.getHost(entry.id)
  }

  async removeHost(id: string): Promise<boolean> {
    await this.load()
    const before = this.data.hosts.length
    this.data.hosts = this.data.hosts.filter((item) => item.id !== id)
    if (this.data.hosts.length !== before) await this.#persistHosts()
    if (this.secrets[id]) {
      delete this.secrets[id]
      await this.#persistSecrets()
    }
    return before !== this.data.hosts.length
  }

  async patchHost(id: string, patch: Record<string, unknown>): Promise<HostEntry | null> {
    await this.load()
    const host = this.data.hosts.find((item) => item.id === id)
    if (!host) return null
    Object.assign(host, patch, { updatedAt: nowIso() })
    await this.#persistHosts()
    return { ...host }
  }

  getSettings(): Settings {
    return this.data.settings
  }

  async saveSettings(raw: unknown): Promise<Settings> {
    await this.load()
    const patch = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    // Merge the patch onto the *current* settings. Spreading it over the defaults reset every
    // field the patch did not name — a patch of `autoReconnect.maxAttempts` also rewound
    // `baseDelayMs` from a configured 5000 back to 800 — which silently undid sibling settings.
    this.data.settings = sanitizeSettings(deepMerge(this.data.settings, patch))
    await this.#persistSettings()
    if (!this.data.settings.saveTokens) {
      this.secrets = {}
      await this.#persistSecrets()
    }
    return this.data.settings
  }

  async saveToken(hostId: string, token: string): Promise<void> {
    // Without this the first token save on a fresh process wrote `{}` over a secrets file that
    // still held other hosts' tokens.
    await this.load()
    if (!this.data.settings.saveTokens) return
    this.secrets[hostId] = token
    await this.#persistSecrets()
  }
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null
  if (home) return home
  const userHome = env.USERPROFILE || env.HOME || process.cwd()
  return path.join(userHome, '.dsh')
}

export function resolveStateDir(home: string): string {
  return path.join(home, 'remote-go')
}
