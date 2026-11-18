/**
 * Host-side download jobs. Each job streams one remote file or folder directly into
 * the local directory the user chose; nothing is buffered in the Host. Jobs publish
 * progress and expire so a closed browser cannot pin job slots forever.
 */
import { randomUUID } from 'node:crypto'
import { errors, toErrorView } from './errors.js'
import type { ErrorView } from './errors.js'
import { normalizeRemoteFilePath, readHostDownload, remoteFileName } from './remote-files.js'
import type { HostDownloadRuntime, SavedDownload } from './local-download.js'
import type { TransferInventory, TransferProgress } from './ssh-port.js'

/** How long a finished job remains inspectable before it is pruned. */
export const DOWNLOAD_JOB_TTL_MS = 10 * 60 * 1000
/** Maximum jobs retained at once (preparing + ready). */
export const MAX_DOWNLOAD_JOBS = 4
/** Maximum jobs allowed to read SFTP at the same time. */
export const MAX_PREPARING_DOWNLOADS = 2
/** Minimum interval between progress frames for one job. */
const PROGRESS_INTERVAL_MS = 120

/** Where one job stands: preparing, finished, or failed. */
export type DownloadJobPhase = 'preparing' | 'ready' | 'error'

/** One job as the API renders it. */
export interface DownloadJobView {
  id: string
  hostId: string
  path: string
  name: string
  kind: string | null
  phase: DownloadJobPhase
  totalBytes: number
  doneBytes: number
  totalFiles: number
  doneFiles: number
  /**
   * Names a folder download deliberately skipped (Windows metadata / shell shortcuts on a
   * Windows host). Surfaced so nothing disappears without the user seeing it.
   */
  ignoredNames: string[]
  destination: string | null
  startedAt: string
  error: ErrorView | null
}

/** The mutable job record behind one view; never leaves this module. */
interface DownloadJob {
  id: string
  hostId: string
  path: string
  name: string
  kind: string | null
  phase: DownloadJobPhase
  totalBytes: number
  doneBytes: number
  totalFiles: number
  doneFiles: number
  destination: string | null
  /** The local home root the destination policy must judge against; not part of the view. */
  home: string | undefined
  startedAt: string
  error: ErrorView | null
  ignoredNames: string[]
  timer: ReturnType<typeof setTimeout> | null
  lastEmit: number
  cancelled: boolean
}

/** What one read produces; `size` is the older field name a caller may still supply. */
export type DownloadReadResult = SavedDownload & { size?: number }

/** The read function this registry calls; injectable for tests. */
export type DownloadReader = (
  runtime: HostDownloadRuntime,
  rawPath: unknown,
  options: {
    destination?: string
    home?: string
    isCancelled: () => boolean
    onInventory: (info: TransferInventory) => void
    onProgress: (info: TransferProgress) => void
    onIgnored: (names: string[]) => void
  },
) => Promise<DownloadReadResult>

/** The host logger surface a job failure is reported to. */
export interface DownloadJobsLogger {
  warn?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

/** Knobs for one registry; every field has a production default. */
export interface DownloadJobOptions {
  emit?: (job: DownloadJobView) => void
  logger?: DownloadJobsLogger
  readDownload?: DownloadReader
  ttlMs?: number
  maxJobs?: number
  maxPreparing?: number
  now?: () => number
}

/** What a caller may pass when starting a job. */
export interface StartDownloadOptions {
  destination?: string
  home?: string
}

/** The registry `service` owns: start/status/cancel plus its live size. */
export interface DownloadJobs {
  start(runtime: HostDownloadRuntime, rawPath: unknown, options?: StartDownloadOptions): DownloadJobView
  status(id: unknown): DownloadJobView
  cancel(id: unknown): boolean
  readonly size: number
  dispose(): void
}

export function createDownloadJobs(options: DownloadJobOptions): DownloadJobs {
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const logger = options.logger ?? console
  const readDownload: DownloadReader =
    typeof options.readDownload === 'function' ? options.readDownload : readHostDownload
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DOWNLOAD_JOB_TTL_MS
  const maxJobs = Number.isSafeInteger(options.maxJobs) && options.maxJobs > 0 ? options.maxJobs : MAX_DOWNLOAD_JOBS
  const maxPreparing =
    Number.isSafeInteger(options.maxPreparing) && options.maxPreparing > 0
      ? options.maxPreparing
      : MAX_PREPARING_DOWNLOADS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const jobs = new Map<string, DownloadJob>()

  const preparingCount = (): number => [...jobs.values()].filter((job) => job.phase === 'preparing').length

  const view = (job: DownloadJob): DownloadJobView => ({
    id: job.id,
    hostId: job.hostId,
    path: job.path,
    name: job.name,
    kind: job.kind,
    phase: job.phase,
    totalBytes: job.totalBytes,
    doneBytes: job.doneBytes,
    totalFiles: job.totalFiles,
    doneFiles: job.doneFiles,
    ignoredNames: Array.isArray(job.ignoredNames) ? job.ignoredNames : [],
    destination: job.destination ?? null,
    startedAt: job.startedAt,
    error: job.error,
  })

  const publish = (job: DownloadJob, force = false): void => {
    if (job.cancelled || !jobs.has(job.id)) return
    const stamp = now()
    if (!force && stamp - job.lastEmit < PROGRESS_INTERVAL_MS) return
    job.lastEmit = stamp
    try {
      emit(view(job))
    } catch (error) {
      logger.warn?.('[dsh-remote-go] download progress listener failed:', error)
    }
  }

  const clearTimer = (job: DownloadJob): void => {
    if (job.timer !== null && typeof clearTimeout === 'function') clearTimeout(job.timer)
    job.timer = null
  }

  const scheduleExpiry = (job: DownloadJob): void => {
    clearTimer(job)
    job.timer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
        logger.debug?.('[dsh-remote-go] download job expired:', job.id)
      }
    }, ttlMs)
    job.timer.unref?.()
  }

  const failJob = (job: DownloadJob, error: unknown): void => {
    if (job.cancelled) return
    job.phase = 'error'
    job.error = toErrorView(error)
    clearTimer(job)
    publish(job, true)
    scheduleExpiry(job)
  }

  const prepare = async (runtime: HostDownloadRuntime, job: DownloadJob): Promise<void> => {
    try {
      const result = await readDownload(runtime, job.path, {
        destination: job.destination ?? undefined,
        // The same home root the API pre-flight used; the write is judged by it again.
        home: job.home,
        isCancelled: () => job.cancelled === true,
        onInventory: (info) => {
          if (job.cancelled) return
          if (Number.isFinite(info?.totalBytes)) job.totalBytes = Math.max(0, Number(info.totalBytes))
          if (Number.isFinite(info?.totalFiles)) job.totalFiles = Math.max(0, Number(info.totalFiles))
          publish(job)
        },
        onProgress: (info) => {
          if (job.cancelled) return
          if (Number.isFinite(info?.doneBytes)) job.doneBytes = Math.max(0, Number(info.doneBytes))
          if (Number.isFinite(info?.totalBytes)) job.totalBytes = Math.max(0, Number(info.totalBytes))
          if (Number.isFinite(info?.doneFiles)) job.doneFiles = Math.max(0, Number(info.doneFiles))
          if (Number.isFinite(info?.totalFiles)) job.totalFiles = Math.max(0, Number(info.totalFiles))
          publish(job)
        },
        // Folder downloads report the names they skipped (Windows-only metadata/shortcuts);
        // `saveHostFolder` forwards this options object to the SSH layer unchanged.
        onIgnored: (names) => {
          if (job.cancelled || !Array.isArray(names)) return
          job.ignoredNames = names.slice(0, 200).map((name) => String(name))
          publish(job)
        },
      })
      if (job.cancelled) return
      job.kind = result.kind
      job.name = result.name || remoteFileName(job.path)
      job.destination = result.destination ?? job.destination
      job.totalBytes = Number(result.totalBytes ?? result.size ?? job.totalBytes ?? 0)
      job.doneBytes = job.totalBytes
      job.totalFiles = Number(result.files ?? job.totalFiles ?? 0)
      job.doneFiles = job.totalFiles
      job.phase = 'ready'
      clearTimer(job)
      publish(job, true)
      scheduleExpiry(job)
    } catch (error) {
      if (job.cancelled) return
      logger.warn?.('[dsh-remote-go] download preparation failed:', error)
      failJob(job, error)
    }
  }

  return {
    /**
     * Create and start a download job.
     * @param runtime - connected host runtime.
     * @param rawPath - absolute remote file or folder path.
     * @param options - local destination for a folder job.
     * @returns the initial job view (phase `preparing`).
     */
    start(runtime, rawPath, options = {}) {
      const path = normalizeRemoteFilePath(rawPath)
      if (jobs.size >= maxJobs) {
        throw errors.downloadBusy({
          zh: `最多同时保留 ${maxJobs} 个下载任务，请先完成或取消一个。`,
          en: `At most ${maxJobs} download jobs can be kept; finish or cancel one first.`,
        })
      }
      if (preparingCount() >= maxPreparing) {
        throw errors.downloadBusy({
          zh: `正在准备 ${maxPreparing} 个下载，请等一个完成后再试。`,
          en: `${maxPreparing} downloads are already being prepared; wait for one to finish.`,
        })
      }
      if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
        throw errors.remoteFileUnavailable({
          zh: '这台主机还没有连接，无法读取远端文件。',
          en: 'This host is not connected, so the remote file cannot be read.',
        })
      }
      const job: DownloadJob = {
        id: 'dl_' + randomUUID(),
        hostId: runtime.id,
        path,
        name: remoteFileName(path),
        kind: null,
        phase: 'preparing',
        totalBytes: 0,
        doneBytes: 0,
        totalFiles: 0,
        doneFiles: 0,
        destination: typeof options.destination === 'string' && options.destination !== '' ? options.destination : null,
        // The local home root the destination policy must judge against; not part of the view.
        home: typeof options.home === 'string' && options.home !== '' ? options.home : undefined,
        startedAt: new Date(now()).toISOString(),
        error: null,
        ignoredNames: [],
        timer: null,
        lastEmit: 0,
        cancelled: false,
      }
      jobs.set(job.id, job)
      publish(job, true)
      void prepare(runtime, job)
      return view(job)
    },

    /** Current status of one job. */
    status(id) {
      const job = typeof id === 'string' ? jobs.get(id) : undefined
      if (!job) {
        throw errors.downloadNotReady({
          zh: '这个下载任务不存在或已过期，请重新发起下载。',
          en: 'This download job no longer exists or expired; start the download again.',
        })
      }
      return view(job)
    },

    /** Cancel one preparing/ready job. Returns false when it was already gone. */
    cancel(id) {
      const job = typeof id === 'string' ? jobs.get(id) : undefined
      if (!job) return false
      job.cancelled = true
      clearTimer(job)
      jobs.delete(job.id)
      return true
    },

    /** Number of retained jobs, for tests/diagnostics. */
    get size() {
      return jobs.size
    },

    dispose() {
      for (const job of jobs.values()) {
        job.cancelled = true
        clearTimer(job)
      }
      jobs.clear()
    },
  }
}
