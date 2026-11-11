/**
 * Durable local state under `$DSH_HOME/remote-go/`:
 *  - hosts.json    — host registry (never contains passwords; pinned host keys only)
 *  - settings.json — plugin settings
 *  - secrets.json  — only when `saveTokens` is enabled; 0600, holds launch tokens
 *
 * Writes are atomic (tmp + rename) and the directory is 0700 on POSIX platforms.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { nowIso, randomId } from './util.js'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from './settings.js'

/** @typedef {{ hosts: Record<string, any>[], settings: import('./settings.js').Settings }} StoreData */

export class HostStore {
  /**
   * @param {{ dir: string, logger?: { warn: (...args: any[]) => void }, fsImpl?: typeof fs }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.logger = options.logger ?? console
    this.fs = options.fsImpl ?? fs
    this.hostsFile = path.join(this.dir, 'hosts.json')
    this.settingsFile = path.join(this.dir, 'settings.json')
    this.secretsFile = path.join(this.dir, 'secrets.json')
    /** @type {StoreData} */
    this.data = { hosts: [], settings: defaultSettings() }
    /** @type {Record<string, string>} */
    this.secrets = {}
    this.loaded = false
    /** @type {Promise<void>} */
    this.writeChain = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.data
    try {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] cannot create state directory:', error)
    }
    this.data.hosts = await this.#readJson(this.hostsFile, [])
    this.data.hosts = Array.isArray(this.data.hosts)
      ? this.data.hosts.filter((item) => item && typeof item === 'object')
      : []
    this.data.settings = sanitizeSettings(await this.#readJson(this.settingsFile, null))
    const secrets = await this.#readJson(this.secretsFile, null)
    this.secrets = secrets && typeof secrets === 'object' ? secrets : {}
    this.loaded = true
    return this.data
  }

  /**
   * @param {string} file
   * @param {any} fallback
   */
  async #readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback
      const text = await this.fs.readFile(file, 'utf8')
      return JSON.parse(text)
    } catch (error) {
      this.logger.warn?.(`[dsh-remote-go] cannot read ${path.basename(file)}:`, error)
      return fallback
    }
  }

  /**
   * @param {string} file
   * @param {unknown} value
   * @param {number} mode
   */
  #writeJson(file, value, mode = 0o600) {
    const run = async () => {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await this.fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
      await this.fs.rename(tmp, file)
    }
    // Serialize writes so a crash cannot interleave two half-written files.
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }

  async #persistHosts() {
    await this.#writeJson(this.hostsFile, this.data.hosts)
  }

  async #persistSettings() {
    await this.#writeJson(this.settingsFile, this.data.settings)
  }

  async #persistSecrets() {
    await this.#writeJson(this.secretsFile, this.secrets)
  }

  /** @returns {Record<string, any>[]} */
  listHosts() {
    return this.data.hosts.map((host) => ({ ...host }))
  }

  /** @param {string} id */
  getHost(id) {
    const host = this.data.hosts.find((item) => item.id === id)
    return host ? { ...host } : null
  }

  /**
   * Create or update one host.
   * @param {unknown} rawEntry
   * @param {{ settings?: import('./settings.js').Settings }} [options]
   */
  async upsertHost(rawEntry, options = {}) {
    await this.load()
    const existing =
      rawEntry && typeof rawEntry === 'object' && typeof rawEntry.id === 'string' ? this.getHost(rawEntry.id) : null
    const entry = sanitizeHostEntry(rawEntry, { settings: options.settings ?? this.data.settings, existing })
    if (!entry.id) entry.id = randomId('h')
    const index = this.data.hosts.findIndex((item) => item.id === entry.id)
    if (index >= 0) this.data.hosts[index] = { ...this.data.hosts[index], ...entry }
    else this.data.hosts.push(entry)
    await this.#persistHosts()
    return this.getHost(entry.id)
  }

  /** @param {string} id */
  async removeHost(id) {
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

  /**
   * @param {string} id
   * @param {Record<string, any>} patch
   */
  async patchHost(id, patch) {
    await this.load()
    const host = this.data.hosts.find((item) => item.id === id)
    if (!host) return null
    Object.assign(host, patch, { updatedAt: nowIso() })
    await this.#persistHosts()
    return { ...host }
  }

  /** @returns {import('./settings.js').Settings} */
  getSettings() {
    return this.data.settings
  }

  /**
   * @param {unknown} raw
   * @returns {Promise<import('./settings.js').Settings>}
   */
  async saveSettings(raw) {
    await this.load()
    this.data.settings = sanitizeSettings({ ...this.data.settings, ...(raw && typeof raw === 'object' ? raw : {}) })
    await this.#persistSettings()
    if (!this.data.settings.saveTokens) {
      this.secrets = {}
      await this.#persistSecrets()
    }
    return this.data.settings
  }

  /** @param {string} hostId @param {string} token */
  async saveToken(hostId, token) {
    if (!this.data.settings.saveTokens) return
    this.secrets[hostId] = token
    await this.#persistSecrets()
  }

  /** @param {string} hostId */
  getToken(hostId) {
    return this.data.settings.saveTokens ? (this.secrets[hostId] ?? null) : null
  }
}

/**
 * Resolve the DSH home directory in the host plugin process.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDshHome(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null
  if (home) return home
  const userHome = env.USERPROFILE || env.HOME || process.cwd()
  return path.join(userHome, '.dsh')
}

/**
 * @param {string} home
 */
export function resolveStateDir(home) {
  return path.join(home, 'remote-go')
}
