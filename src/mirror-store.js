/**
 * Durable mirror descriptors under `$DSH_HOME/remote-go/mirrors.json`.
 *
 * Same rules as `./store.js` (design §8): the directory is 0700 on POSIX, the
 * file is 0600, writes are atomic (`tmp` + `rename`) and serialized so a crash
 * cannot interleave two half-written files. Reads are tolerant: unknown fields
 * are dropped, missing fields are defaulted and unusable records are skipped, so
 * a schema change cannot brick the plugin.
 *
 * Two failure modes must never destroy data:
 *
 * - a **corrupt** file is moved aside as `mirrors.json.corrupt-<ts>` before the
 *   next write, so the bad-but-recoverable bytes survive;
 * - a file written by a **newer** store version is moved aside as
 *   `mirrors.json.future-<ts>` and never reinterpreted (this build cannot know
 *   the newer schema), so an older plugin can never overwrite it in place.
 *
 * Writes are safe across **processes**: writers serialize on a `wx` lock file
 * (stale locks from a crashed writer are broken, see `./atomic-json.js`), re-read
 * the file inside the lock before mutating (so two writers cannot lose each
 * other's rows), and use the shared atomic writer (unique temp name, `wx`,
 * fsync, rename retry, temp cleanup). Directories are fsynced where the platform
 * allows it.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  quarantineFile,
  readJsonFile,
  withProcessLock,
  writeJsonAtomic,
} from './atomic-json.js'
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
   *   lockStaleMs?: number,
   *   lockWaitMs?: number,
   *   lockRetryMs?: number,
   * }} options `lock*Ms` exist so tests can exercise the timeout path without
   * waiting the production intervals; they default to the module constants.
   */
  constructor(options) {
    this.dir = options.dir
    this.logger = options.logger ?? console
    this.fs = options.fsImpl ?? fs
    this.file = path.join(this.dir, 'mirrors.json')
    this.lockFile = `${this.file}.lock`
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS
    /** @type {MirrorStoreData} */
    this.data = emptyMirrorData()
    /** Path the last load moved a corrupt/future file to, if any. */
    this.quarantinedFile = null
    this.loaded = false
  }

  /** @returns {Promise<MirrorStoreData>} */
  async load() {
    if (this.loaded) return this.data
    await this.#ensureDir()
    this.data = await this.#readFresh()
    this.loaded = true
    return this.data
  }

  async #ensureDir() {
    try {
      await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] cannot create the mirror directory:', error)
    }
  }

  /**
   * Read the file and return usable data. A corrupt file or one written by a
   * newer store version is quarantined first (never reinterpreted in place),
   * then an empty store is returned.
   * @returns {Promise<MirrorStoreData>}
   */
  async #readFresh() {
    const result = await readJsonFile(this.file, { fs: this.fs, logger: this.logger })
    if (result.status === 'missing') return emptyMirrorData()
    if (result.status === 'corrupt') {
      const target = await quarantineFile(this.file, 'corrupt', { fs: this.fs, logger: this.logger })
      if (target !== null) this.quarantinedFile = target
      return emptyMirrorData()
    }
    const value = result.value
    const version =
      value && typeof value === 'object' && Number.isInteger(/** @type {any} */ (value).version)
        ? /** @type {any} */ (value).version
        : null
    if (version !== null && version > MIRROR_STORE_VERSION) {
      const target = await quarantineFile(this.file, 'future', { fs: this.fs, logger: this.logger })
      if (target !== null) this.quarantinedFile = target
      return emptyMirrorData()
    }
    return sanitizeMirrorStore(value)
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
    const incoming = sanitizeDescriptors(descriptors)
    await this.load()
    if (incoming.length === 0) return this.listMirrors()
    await this.#mutate((data) => {
      /** @type {Map<string, import('./mirror.js').MirrorDescriptor>} */
      const byId = new Map(data.mirrors.map((descriptor) => [descriptor.localSessionId, descriptor]))
      for (const descriptor of incoming) byId.set(descriptor.localSessionId, descriptor)
      data.mirrors = [...byId.values()].sort(compareMirrors)
    })
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
    const host = typeof hostId === 'string' ? hostId.trim() : ''
    await this.load()
    if (host === '') return this.listMirrors()
    const incoming = sanitizeDescriptors(descriptors).filter((descriptor) => descriptor.hostId === host)
    await this.#mutate((data) => {
      data.mirrors = [...data.mirrors.filter((descriptor) => descriptor.hostId !== host), ...incoming].sort(
        compareMirrors,
      )
    })
    return this.listMirrors({ hostId: host })
  }

  /**
   * @param {string} hostId
   * @returns {Promise<boolean>} whether anything was removed
   */
  async removeHostMirrors(hostId) {
    const host = typeof hostId === 'string' ? hostId.trim() : ''
    await this.load()
    if (host === '') return false
    return this.#mutate((data) => {
      const before = data.mirrors.length
      data.mirrors = data.mirrors.filter((descriptor) => descriptor.hostId !== host)
      return data.mirrors.length !== before
    })
  }

  /**
   * @param {string} localSessionId
   * @returns {Promise<boolean>} whether anything was removed
   */
  async removeMirror(localSessionId) {
    const id = typeof localSessionId === 'string' ? localSessionId : ''
    await this.load()
    if (id === '') return false
    return this.#mutate((data) => {
      const before = data.mirrors.length
      data.mirrors = data.mirrors.filter((descriptor) => descriptor.localSessionId !== id)
      return data.mirrors.length !== before
    })
  }

  /**
   * Run one mutation under the shared cross-process lock (plus the in-process
   * chain inside it). The file is re-read inside the lock so concurrent writers
   * merge instead of overwriting each other.
   * @template T
   * @param {(data: MirrorStoreData) => T} apply
   * @returns {Promise<T>}
   */
  async #mutate(apply) {
    return withProcessLock(
      this.lockFile,
      {
        fs: this.fs,
        logger: this.logger,
        staleMs: this.lockStaleMs,
        waitMs: this.lockWaitMs,
        retryMs: this.lockRetryMs,
      },
      async () => {
        this.data = await this.#readFresh()
        const result = apply(this.data)
        await writeJsonAtomic(this.file, this.data, {
          dir: this.dir,
          fs: this.fs,
          logger: this.logger,
        })
        return result
      },
    )
  }
}

/** @returns {MirrorStoreData} */
function emptyMirrorData() {
  return { version: MIRROR_STORE_VERSION, mirrors: [] }
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
  return {
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
    reason:
      descriptor.reason === null || descriptor.reason === undefined
        ? null
        : { code: descriptor.reason.code, message: { ...descriptor.reason.message } },
  }
}
