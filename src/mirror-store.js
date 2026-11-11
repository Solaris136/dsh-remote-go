/**
 * Durable mirror descriptors under `$DSH_HOME/remote-go/mirrors.json`.
 *
 * Same rules as `./store.js` (design §8): the directory is 0700 on POSIX, the
 * file is 0600, writes are atomic (`tmp` + `rename`) and serialized so a crash
 * cannot interleave two half-written files. Reads are tolerant: unknown fields
 * are dropped, missing fields are defaulted and unusable records are skipped, so
 * a schema change cannot brick the plugin.
 *
 * The stored order is canonical (`compareMirrors`), which makes the file diff
 * stable and the API response deterministic.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { compareMirrors, normalizeMirrorDescriptor } from './mirror.js'

/** On-disk envelope version; bump only when an older file cannot be sanitized. */
export const MIRROR_STORE_VERSION = 1

/** @typedef {{ version: number, mirrors: import('./mirror.js').MirrorDescriptor[] }} MirrorStoreData */

export class MirrorStore {
  /**
   * @param {{
   *   dir: string,
   *   logger?: { warn?: (...args: any[]) => void },
   *   fsImpl?: typeof fs,
   * }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.logger = options.logger ?? console
    this.fs = options.fsImpl ?? fs
    this.file = path.join(this.dir, 'mirrors.json')
    /** @type {MirrorStoreData} */
    this.data = { version: MIRROR_STORE_VERSION, mirrors: [] }
    this.loaded = false
    /** @type {Promise<void>} */
    this.writeChain = Promise.resolve()
  }

  /** @returns {Promise<MirrorStoreData>} */
  async load() {
    if (this.loaded) return this.data
    try {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] cannot create the mirror directory:', error)
    }
    this.data = sanitizeMirrorStore(await this.#readJson(this.file))
    this.loaded = true
    return this.data
  }

  /**
   * @param {string} file
   * @returns {Promise<unknown>}
   */
  async #readJson(file) {
    try {
      if (!existsSync(file)) return null
      const text = await this.fs.readFile(file, 'utf8')
      return JSON.parse(text)
    } catch (error) {
      this.logger.warn?.(`[dsh-remote-go] cannot read ${path.basename(file)}:`, error)
      return null
    }
  }

  #persist() {
    const run = async () => {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
      await this.fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await this.fs.rename(tmp, this.file)
    }
    // Serialize writes so a crash cannot interleave two half-written files.
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }

  /**
   * @param {{ hostId?: string }} [options]
   * @returns {import('./mirror.js').MirrorDescriptor[]}
   */
  listMirrors(options = {}) {
    const hostId = typeof options.hostId === 'string' ? options.hostId : null
    return this.data.mirrors
      .filter((descriptor) => hostId === null || descriptor.hostId === hostId)
      .map((descriptor) => cloneDescriptor(descriptor))
  }

  /**
   * @param {string} localSessionId
   * @returns {import('./mirror.js').MirrorDescriptor | null}
   */
  getMirror(localSessionId) {
    const descriptor = this.data.mirrors.find((item) => item.localSessionId === localSessionId)
    return descriptor ? cloneDescriptor(descriptor) : null
  }

  /**
   * Insert or replace descriptors, keyed by `localSessionId`.
   * @param {readonly unknown[]} descriptors
   * @returns {Promise<import('./mirror.js').MirrorDescriptor[]>}
   */
  async upsertMirrors(descriptors) {
    await this.load()
    const incoming = sanitizeDescriptors(descriptors)
    if (incoming.length === 0) return this.listMirrors()
    /** @type {Map<string, import('./mirror.js').MirrorDescriptor>} */
    const byId = new Map(this.data.mirrors.map((descriptor) => [descriptor.localSessionId, descriptor]))
    for (const descriptor of incoming) byId.set(descriptor.localSessionId, descriptor)
    this.data.mirrors = [...byId.values()].sort(compareMirrors)
    await this.#persist()
    return this.listMirrors()
  }

  /**
   * Replace every descriptor of one host (the directory sync is authoritative for
   * that host) and keep other hosts untouched.
   * @param {string} hostId
   * @param {readonly unknown[]} descriptors
   * @returns {Promise<import('./mirror.js').MirrorDescriptor[]>}
   */
  async replaceHostMirrors(hostId, descriptors) {
    await this.load()
    const host = typeof hostId === 'string' ? hostId.trim() : ''
    if (host === '') return this.listMirrors()
    const incoming = sanitizeDescriptors(descriptors).filter((descriptor) => descriptor.hostId === host)
    this.data.mirrors = [...this.data.mirrors.filter((descriptor) => descriptor.hostId !== host), ...incoming].sort(
      compareMirrors,
    )
    await this.#persist()
    return this.listMirrors({ hostId: host })
  }

  /**
   * @param {string} hostId
   * @returns {Promise<boolean>} whether anything was removed
   */
  async removeHostMirrors(hostId) {
    await this.load()
    const host = typeof hostId === 'string' ? hostId.trim() : ''
    if (host === '') return false
    const before = this.data.mirrors.length
    this.data.mirrors = this.data.mirrors.filter((descriptor) => descriptor.hostId !== host)
    if (this.data.mirrors.length === before) return false
    await this.#persist()
    return true
  }

  /**
   * @param {string} localSessionId
   * @returns {Promise<boolean>} whether anything was removed
   */
  async removeMirror(localSessionId) {
    await this.load()
    const id = typeof localSessionId === 'string' ? localSessionId : ''
    const before = this.data.mirrors.length
    this.data.mirrors = this.data.mirrors.filter((descriptor) => descriptor.localSessionId !== id)
    if (this.data.mirrors.length === before) return false
    await this.#persist()
    return true
  }
}

/**
 * Tolerant read: accepts the current envelope, a legacy bare array, or garbage.
 * Unknown fields are dropped and unusable records are skipped, never thrown.
 * @param {unknown} raw
 * @returns {MirrorStoreData}
 */
export function sanitizeMirrorStore(raw) {
  /** @type {unknown[]} */
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).mirrors)) {
    list = /** @type {any} */ (raw).mirrors
  }
  return { version: MIRROR_STORE_VERSION, mirrors: sanitizeDescriptors(list) }
}

/**
 * Normalize a descriptor list: drop unusable records and duplicate ids, then
 * sort into the canonical order.
 * @param {readonly unknown[]} descriptors
 * @returns {import('./mirror.js').MirrorDescriptor[]}
 */
function sanitizeDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) return []
  /** @type {Map<string, import('./mirror.js').MirrorDescriptor>} */
  const byId = new Map()
  for (const raw of descriptors) {
    const descriptor = normalizeMirrorDescriptor(raw)
    if (descriptor === null || byId.has(descriptor.localSessionId)) continue
    byId.set(descriptor.localSessionId, descriptor)
  }
  return [...byId.values()].sort(compareMirrors)
}

/**
 * @param {import('./mirror.js').MirrorDescriptor} descriptor
 * @returns {import('./mirror.js').MirrorDescriptor}
 */
function cloneDescriptor(descriptor) {
  return { ...descriptor, capabilities: { ...descriptor.capabilities } }
}
