/**
 * Shared atomic JSON persistence for the plugin's own state files.
 *
 * Both `HostStore` (hosts/settings/secrets) and `MirrorStore` (mirrors) use this
 * module, so every file the plugin writes gets the same protections (design §8):
 *
 * - directory created 0700, file written 0600;
 * - unique `crypto.randomUUID()` temp file opened with `wx` (a temp name can
 *   never be reused or shared), fsynced, then renamed;
 * - the rename is retried on `EPERM`/`EBUSY`/`EACCES` (Windows throws these when
 *   another process briefly holds or replaces the target), and any failure
 *   removes the temp file so no `.tmp` is ever left behind;
 * - the containing directory is fsynced where the platform allows it;
 * - writers serialize across processes on a `wx` lock file (stale locks from a
 *   crashed writer are broken after `LOCK_STALE_MS`), plus an in-process chain
 *   keyed by the lock path so two store instances cannot interleave.
 *
 * Reads are tolerant and never throw: a missing file is `missing`, unparseable
 * content is `corrupt`; each store decides what that means for it (fallback vs.
 * quarantine), which keeps their error/typing behaviour their own.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Rename attempts when another process holds/replaces the target (Windows). */
export const RENAME_RETRY_ATTEMPTS = 5

/** Base backoff for a busy rename; multiplied by the attempt number. */
export const RENAME_RETRY_BASE_MS = 20

/** A lock file older than this is stale (the writer crashed). */
export const LOCK_STALE_MS = 10_000

/** How long to wait for another process to release the lock before failing. */
export const LOCK_WAIT_MS = 20_000

/** Poll interval while waiting for the cross-process lock. */
export const LOCK_RETRY_MS = 10

/** @param {number} ms @returns {Promise<void>} */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * In-process chains, keyed by lock path. The value is the tail of the chain
 * (always settled), so a rejected write never poisons the next waiter.
 * @type {Map<string, Promise<unknown>>}
 */
const LOCAL_CHAINS = new Map()

/**
 * Run `task` while holding the cross-process lock, serialized with every other
 * in-process holder of the same lock path.
 * @template T
 * @param {string} lockFile
 * @param {{
 *   fs?: typeof fs,
 *   logger?: { warn?: (...args: any[]) => void },
 *   staleMs?: number,
 *   waitMs?: number,
 *   retryMs?: number,
 * }} [options]
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withProcessLock(lockFile, options, task) {
  const previous = LOCAL_CHAINS.get(lockFile) ?? Promise.resolve()
  const run = previous.then(
    () => runExclusive(lockFile, options ?? {}, task),
    () => runExclusive(lockFile, options ?? {}, task),
  )
  LOCAL_CHAINS.set(
    lockFile,
    run.catch(() => undefined),
  )
  return run
}

/**
 * @template T
 * @param {string} lockFile
 * @param {{ fs?: typeof fs, logger?: { warn?: (...args: any[]) => void }, staleMs?: number, waitMs?: number, retryMs?: number }} options
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function runExclusive(lockFile, options, task) {
  const release = await acquireLock(lockFile, options)
  try {
    return await task()
  } finally {
    await release()
  }
}

/**
 * Create the exclusive lock file and return its release function.
 * @param {string} lockFile
 * @param {{ fs?: typeof fs, logger?: { warn?: (...args: any[]) => void }, staleMs?: number, waitMs?: number, retryMs?: number }} options
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireLock(lockFile, options) {
  const fsImpl = options.fs ?? fs
  const logger = options.logger ?? console
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = await fsImpl.open(lockFile, 'wx', 0o600)
      return async () => {
        try {
          await handle.close()
        } catch {
          /* already closed */
        }
        await removeQuietly(fsImpl, lockFile)
      }
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
      await breakStaleLock(fsImpl, lockFile, staleMs)
      if (Date.now() - started > waitMs) {
        const timeout = new Error('timed out waiting for another process to release the store lock')
        timeout.code = 'ELOCKTIMEOUT'
        throw timeout
      }
      await sleep(retryMs)
    }
  }
}

/**
 * @param {typeof fs} fsImpl
 * @param {string} lockFile
 * @param {number} staleMs
 */
async function breakStaleLock(fsImpl, lockFile, staleMs) {
  try {
    const info = await fsImpl.stat(lockFile)
    if (Date.now() - info.mtimeMs > staleMs) await removeQuietly(fsImpl, lockFile)
  } catch {
    /* the lock disappeared or cannot be inspected: just retry the create */
  }
}

/**
 * Write `value` as pretty JSON through a fsynced temp file and an atomic rename.
 * The caller is responsible for holding the lock (see `withProcessLock`) when the
 * write is part of a read-modify-write cycle.
 * @param {string} file
 * @param {unknown} value
 * @param {{
 *   dir?: string,
 *   fs?: typeof fs,
 *   logger?: { warn?: (...args: any[]) => void },
 *   dirMode?: number,
 *   fileMode?: number,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(file, value, options = {}) {
  const fsImpl = options.fs ?? fs
  const logger = options.logger ?? console
  const dir = options.dir ?? path.dirname(file)
  const dirMode = options.dirMode ?? 0o700
  const fileMode = options.fileMode ?? 0o600
  try {
    await fsImpl.mkdir(dir, { recursive: true, mode: dirMode })
  } catch (error) {
    logger.warn?.(`[dsh-remote-go] cannot create ${dir}:`, error)
  }
  const tmp = `${file}.${randomUUID()}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  let handle = null
  try {
    handle = await fsImpl.open(tmp, 'wx', fileMode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* ignore */
      }
    }
    await removeQuietly(fsImpl, tmp)
    throw error
  }
  await renameWithRetry(fsImpl, tmp, file)
  await syncDir(fsImpl, dir)
}

/**
 * @param {typeof fs} fsImpl
 * @param {string} tmp
 * @param {string} file
 */
async function renameWithRetry(fsImpl, tmp, file) {
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsImpl.rename(tmp, file)
      return
    } catch (error) {
      const code = /** @type {any} */ (error)?.code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (retryable && attempt < RENAME_RETRY_ATTEMPTS) {
        await sleep(RENAME_RETRY_BASE_MS * attempt)
        continue
      }
      await removeQuietly(fsImpl, tmp)
      throw error
    }
  }
}

/** Best effort: some platforms (Windows) cannot fsync a directory. */
async function syncDir(fsImpl, dir) {
  let handle = null
  try {
    handle = await fsImpl.open(dir, 'r')
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

/**
 * Read and parse a JSON file without throwing. A missing file is `missing`, a
 * read/parse failure is `corrupt` (the caller decides fallback vs quarantine).
 * @param {string} file
 * @param {{ fs?: typeof fs, logger?: { warn?: (...args: any[]) => void } }} [options]
 * @returns {Promise<{ status: 'missing' | 'ok' | 'corrupt', value: unknown }>}
 */
export async function readJsonFile(file, options = {}) {
  const fsImpl = options.fs ?? fs
  const logger = options.logger ?? console
  try {
    if (!existsSync(file)) return { status: 'missing', value: null }
    const text = await fsImpl.readFile(file, 'utf8')
    return { status: 'ok', value: JSON.parse(text) }
  } catch (error) {
    logger.warn?.(`[dsh-remote-go] cannot read ${path.basename(file)}:`, error)
    return { status: 'corrupt', value: null }
  }
}

/**
 * Move an uninterpretable file aside as `<file>.<kind>-<timestamp>` so it is never
 * overwritten in place. Returns the new path, or `null` when the rename failed.
 * @param {string} file
 * @param {string} kind
 * @param {{ fs?: typeof fs, logger?: { warn?: (...args: any[]) => void } }} [options]
 * @returns {Promise<string | null>}
 */
export async function quarantineFile(file, kind, options = {}) {
  const fsImpl = options.fs ?? fs
  const logger = options.logger ?? console
  const target = `${file}.${kind}-${Date.now()}`
  try {
    await fsImpl.rename(file, target)
    logger.warn?.(`[dsh-remote-go] kept ${path.basename(file)} aside as ${path.basename(target)} (${kind})`)
    return target
  } catch (error) {
    logger.warn?.(`[dsh-remote-go] cannot keep ${path.basename(file)} aside:`, error)
    return null
  }
}

/**
 * @param {typeof fs} fsImpl
 * @param {string} target
 */
async function removeQuietly(fsImpl, target) {
  try {
    await fsImpl.unlink(target)
  } catch {
    /* already gone */
  }
}
