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
 * Writes are safe for several `MirrorStore` instances in one process: they share
 * a per-file lock, re-read the file inside the lock before mutating (so two
 * instances cannot lose each other's rows), and use a `crypto.randomUUID()` temp
 * name opened with `wx`, fsynced, then renamed. Directories are fsynced where the
 * platform allows it.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { compareMirrors, normalizeMirrorDescriptor } from './mirror.js'

/** On-disk envelope version; bump only when an older file cannot be sanitized. */
export const MIRROR_STORE_VERSION = 1

/** @typedef {{ version: number, mirrors: import('./mirror.js').MirrorDescriptor[] }} MirrorStoreData */

/**
 * Per-file write locks shared by every store instance in this process. The value
 * is the tail of the chain (always settled), so a rejected write never poisons
 * the next waiter.
 * @type {Map<string, Promise<unknown>>}
 */
const WRITE_LOCKS = new Map()

/**
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withFileLock(file, task) {
  const previous = WRITE_LOCKS.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  WRITE_LOCKS.set(
    file,
    run.catch(() => undefined),
  )
  return run
}

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
   * Read the current envelope without interpreting it.
   * @returns {Promise<{ status: 'missing' | 'ok' | 'corrupt' | 'future', value: unknown }>}
   */
  async #readEnvelope() {
    try {
      if (!existsSync(this.file)) return { status: 'missing', value: null }
      const text = await this.fs.readFile(this.file, 'utf8')
      const value = JSON.parse(text)
      const version =
        value && typeof value === 'object' && Number.isInteger(/** @type {any} */ (value).version)
          ? /** @type {any} */ (value).version
          : null
      if (version !== null && version > MIRROR_STORE_VERSION) return { status: 'future', value }
      return { status: 'ok', value }
    } catch (error) {
      this.logger.warn?.(`[dsh-remote-go] cannot read ${path.basename(this.file)}:`, error)
      return { status: 'corrupt', value: null }
    }
  }

  /**
   * Move an uninterpretable file aside so it is never overwritten in place.
   * @param {'corrupt' | 'future'} kind
   * @returns {Promise<string | null>}
   */
  async #quarantine(kind) {
    const target = `${this.file}.${kind}-${Date.now()}`
    try {
      await this.fs.rename(this.file, target)
      this.quarantinedFile = target
      this.logger.warn?.(`[dsh-remote-go] kept ${path.basename(this.file)} aside as ${path.basename(target)} (${kind})`)
      return target
    } catch (error) {
      this.logger.warn?.(`[dsh-remote-go] cannot keep ${path.basename(this.file)} aside:`, error)
      return null
    }
  }

  /**
   * Read the file and return usable data; quarantine corrupt/future files first.
   * @returns {Promise<MirrorStoreData>}
   */
  async #readFresh() {
    const envelope = await this.#readEnvelope()
    if (envelope.status === 'corrupt' || envelope.status === 'future') {
      await this.#quarantine(envelope.status)
      return emptyMirrorData()
    }
    return sanitizeMirrorStore(envelope.value)
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
   * Run one mutation under the shared per-file lock. Inside the lock the file is
   * re-read so concurrent instances merge instead of overwriting each other.
   * @template T
   * @param {(data: MirrorStoreData) => T} apply
   * @returns {Promise<T>}
   */
  async #mutate(apply) {
    return withFileLock(this.file, async () => {
      this.data = await this.#readFresh()
      const result = apply(this.data)
      await this.#writeAtomic(this.data)
      return result
    })
  }

  /**
   * Atomic write: unique temp file opened exclusively, fsynced, renamed, then the
   * directory is fsynced where supported. A unique suffix plus `wx` means two
   * writers can never share (or silently reuse) a temp path.
   * @param {MirrorStoreData} data
   */
  async #writeAtomic(data) {
    await this.#ensureDir()
    const tmp = `${this.file}.${randomUUID()}.tmp`
    const text = `${JSON.stringify(data, null, 2)}\n`
    const handle = await this.fs.open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.fs.rename(tmp, this.file)
    await this.#syncDir()
  }

  /** Best effort: some platforms (Windows) cannot fsync a directory. */
  async #syncDir() {
    let handle = null
    try {
      handle = await this.fs.open(this.dir, 'r')
      await handle.sync()
    } catch {
      /* not supported on this platform/filesystem */
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          /* ignore */
        }
      }
    }
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
  return { ...descriptor, capabilities: { ...descriptor.capabilities } }
}
