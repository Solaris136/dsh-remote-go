/** Atomic JSON persistence: 0700 dir, 0600 file, fsynced temp, rename retry and a cross-process lock; a bad file is reported, never thrown. */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { sleep } from './util.js'
import type { Logger } from './util.js'

/** The `fs.promises` calls this module makes; the store injects a fake with the same shape. */
export interface JsonFileSystem {
  open(file: string, flags: string, mode?: number): Promise<JsonFileHandle>
  readFile(file: string, encoding: 'utf8'): Promise<string>
  rename(from: string, to: string): Promise<void>
  stat(file: string): Promise<{ mtimeMs: number }>
  unlink(file: string): Promise<void>
  mkdir(dir: string, options: { recursive: boolean; mode: number }): Promise<unknown>
}
/** The open handle surface used here: write a whole document, fsync, close. */
export interface JsonFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}
/** Knobs for one cross-process lock acquisition. */
export interface LockOptions {
  fs?: JsonFileSystem
  logger?: Logger
  staleMs?: number
  waitMs?: number
  retryMs?: number
}
/** Knobs for one atomic write; a caller may redirect the fs, the logger or the modes. */
export interface WriteJsonOptions {
  fs?: JsonFileSystem
  logger?: Logger
  dir?: string
  dirMode?: number
  fileMode?: number
}
/** Knobs for one atomic read. */
export interface ReadJsonOptions {
  fs?: JsonFileSystem
  logger?: Logger
}
/** The three read outcomes; `value` stays `unknown` because the caller owns the parsed shape. */
export type JsonReadResult =
  { status: 'ok'; value: unknown } | { status: 'missing' | 'corrupt' | 'unreadable'; value: null }

const RENAME_RETRY_ATTEMPTS = 5
const RENAME_RETRY_BASE_MS = 20
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 20_000
const LOCK_RETRY_MS = 10
/** How long a non-`EEXIST` lock error counts as contention with no lock present: Windows reports mid-create races as
 * EPERM/EACCES, but those codes also mean an impossible lock (ACL denial, read-only mount); past this it surfaces. */
const LOCK_TRANSIENT_MS = 250
const LOCK_UNLINK_ATTEMPTS = 3
/** In-process chains keyed by lock path; the value is the always-settled tail so a rejected write never poisons the next waiter. */
const LOCAL_CHAINS = new Map<string, Promise<unknown>>()

/** Run `task` under the cross-process lock, serialized with every in-process holder of the same lock path. */
export function withProcessLock<T>(
  lockFile: string,
  options: LockOptions | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const start = async (): Promise<T> => {
    const release = await acquireLock(lockFile, options ?? {})
    try {
      return await task()
    } finally {
      await release()
    }
  }
  const previous = LOCAL_CHAINS.get(lockFile) ?? Promise.resolve()
  const run = previous.then(start, start)
  LOCAL_CHAINS.set(
    lockFile,
    run.catch((): undefined => undefined),
  )
  return run
}

async function acquireLock(lockFile: string, options: LockOptions): Promise<() => Promise<void>> {
  const fsImpl = options.fs ?? fs
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  const started = Date.now()
  // Only a lock we never once observed can be a permanent permission error: under real contention
  // the lock is created and unlinked constantly.
  let sawLock = false
  while (true) {
    try {
      const handle = await fsImpl.open(lockFile, 'wx', 0o600)
      return async (): Promise<void> => {
        // A failed close on a released lock handle is not actionable here.
        await handle.close().catch(() => {})
        // A leaked lock costs the next writer a full stale wait, so retry the unlink (Windows can
        // hold it briefly after close).
        for (let attempt = 0; attempt < LOCK_UNLINK_ATTEMPTS; attempt += 1) {
          try {
            await fsImpl.unlink(lockFile)
            return
          } catch (unlinkError) {
            const unlinkCode = unlinkError?.code
            if (unlinkCode === 'ENOENT' || attempt === LOCK_UNLINK_ATTEMPTS - 1) return
            await sleep(retryMs)
          }
        }
      }
    } catch (error) {
      // Windows reports contention on an exclusive create as EPERM/EACCES/EBUSY rather than EEXIST
      // when the other process is mid-create or mid-delete.
      const code = error?.code
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      if (code !== 'EEXIST' && !sawLock && Date.now() - started > LOCK_TRANSIENT_MS) {
        if (!(await lockExists(fsImpl, lockFile))) throw error
      }
      if (code === 'EEXIST' || (await lockExists(fsImpl, lockFile))) sawLock = true
      await breakStaleLock(fsImpl, lockFile, staleMs)
      if (Date.now() - started > waitMs) {
        const timeout = new Error('timed out waiting for another process to release the store lock') as Error & {
          code?: string
        }
        timeout.code = 'ELOCKTIMEOUT'
        throw timeout
      }
      await sleep(retryMs)
    }
  }
}

async function breakStaleLock(fsImpl: JsonFileSystem, lockFile: string, staleMs: number): Promise<void> {
  try {
    const info = await fsImpl.stat(lockFile)
    if (Date.now() - info.mtimeMs > staleMs) await removeQuietly(fsImpl, lockFile)
  } catch {
    // swallow-ok: the lock disappeared or cannot be inspected; the create retries
  }
}

export async function writeJsonAtomic(file: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
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
  let handle: JsonFileHandle | null = null
  try {
    handle = await fsImpl.open(tmp, 'wx', fileMode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    // The temp file is removed right below, so a close error here is not fixable.
    if (handle) await handle.close().catch(() => {})
    await removeQuietly(fsImpl, tmp)
    throw error
  }
  await renameWithRetry(fsImpl, tmp, file)
  await syncDir(fsImpl, dir)
}

async function renameWithRetry(fsImpl: JsonFileSystem, tmp: string, file: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsImpl.rename(tmp, file)
      return
    } catch (error) {
      const code = error?.code
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

async function syncDir(fsImpl: JsonFileSystem, dir: string): Promise<void> {
  let handle: JsonFileHandle | null = null
  try {
    handle = await fsImpl.open(dir, 'r')
    await handle.sync()
  } catch {
    // swallow-ok: directory fsync is not supported on every platform or filesystem
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Read one JSON state file. The outcomes are distinct: `missing` (never written), `corrupt` (not JSON — the caller
 * may quarantine and recover) and `unreadable` (EACCES/EPERM/EISDIR/IO); that one is never renamed away. */
export async function readJsonFile(file: string, options: ReadJsonOptions = {}): Promise<JsonReadResult> {
  const fsImpl = options.fs ?? fs
  const logger = options.logger ?? console
  let text
  try {
    if (!existsSync(file)) return { status: 'missing', value: null }
    text = await fsImpl.readFile(file, 'utf8')
  } catch (error) {
    logger.warn?.(`[dsh-remote-go] cannot read ${path.basename(file)}:`, error)
    return { status: 'unreadable', value: null }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch (error) {
    logger.warn?.(`[dsh-remote-go] ${path.basename(file)} is not valid JSON:`, error)
    return { status: 'corrupt', value: null }
  }
}

async function removeQuietly(fsImpl: JsonFileSystem, target: string): Promise<void> {
  try {
    await fsImpl.unlink(target)
  } catch {
    // swallow-ok: a missing temp file is the success case for this cleanup
  }
}

async function lockExists(fsImpl: JsonFileSystem, lockFile: string): Promise<boolean> {
  try {
    await fsImpl.stat(lockFile)
    return true
  } catch {
    // swallow-ok: a lock that cannot be inspected is treated as absent
    return false
  }
}
