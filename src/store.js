/**
 * Durable local state under `$DSH_HOME/remote-go/`:
 *  - hosts.json    — host registry (never contains passwords; pinned host keys only)
 *  - settings.json — plugin settings
 *  - secrets.json  — only when `saveTokens` is enabled; 0600, holds launch tokens
 *
 * Writes go through the shared atomic writer (`./atomic-json.js`): 0700 directory,
 * 0600 file, unique fsynced temp file, rename retry on Windows, cleanup on
 * failure, and a cross-process lock. Reads stay tolerant (a corrupt file falls
 * back to defaults instead of throwing).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readJsonFile, withProcessLock, writeJsonAtomic } from './atomic-json.js'
import { nowIso, randomId } from './util.js'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from './settings.js'

export class HostStore {
  constructor(options) {
    this.dir = options.dir
    this.logger = options.logger ?? console
    this.fs = options.fsImpl ?? fs
    this.hostsFile = path.join(this.dir, 'hosts.json')
    this.settingsFile = path.join(this.dir, 'settings.json')
    this.secretsFile = path.join(this.dir, 'secrets.json')
    this.data = { hosts: [], settings: defaultSettings() }
    this.secrets = {}
    this.loaded = false
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

  async #readJson(file, fallback) {
    const result = await readJsonFile(file, { fs: this.fs, logger: this.logger })
    return result.status === 'ok' ? result.value : fallback
  }

  #writeJson(file, value, mode = 0o600) {
    return withProcessLock(`${file}.lock`, { fs: this.fs, logger: this.logger }, () =>
      writeJsonAtomic(file, value, {
        dir: this.dir,
        fs: this.fs,
        logger: this.logger,
        fileMode: mode,
      }),
    )
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

  listHosts() {
    return this.data.hosts.map((host) => ({ ...host }))
  }

  getHost(id) {
    const host = this.data.hosts.find((item) => item.id === id)
    return host ? { ...host } : null
  }

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

  async patchHost(id, patch) {
    await this.load()
    const host = this.data.hosts.find((item) => item.id === id)
    if (!host) return null
    Object.assign(host, patch, { updatedAt: nowIso() })
    await this.#persistHosts()
    return { ...host }
  }

  getSettings() {
    return this.data.settings
  }

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

  async saveToken(hostId, token) {
    if (!this.data.settings.saveTokens) return
    this.secrets[hostId] = token
    await this.#persistSecrets()
  }

  getToken(hostId) {
    return this.data.settings.saveTokens ? (this.secrets[hostId] ?? null) : null
  }
}

export function resolveDshHome(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null
  if (home) return home
  const userHome = env.USERPROFILE || env.HOME || process.cwd()
  return path.join(userHome, '.dsh')
}

export function resolveStateDir(home) {
  return path.join(home, 'remote-go')
}
