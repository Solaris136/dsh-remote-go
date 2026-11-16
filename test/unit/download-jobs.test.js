import test from 'node:test'
import assert from 'node:assert/strict'
import { createDownloadJobs } from '../../src/download-jobs.js'
import { errors } from '../../src/errors.js'

const runtime = { id: 'h_1', status: 'connected', ssh: {} }
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

function makeJobs(readDownload, options = {}) {
  const events = []
  const jobs = createDownloadJobs({
    emit: (job) => events.push(job),
    logger: { warn() {}, debug() {} },
    readDownload,
    ...options,
  })
  return { jobs, events }
}

test('a download job streams, publishes progress and becomes ready', async () => {
  const { jobs, events } = makeJobs(async (_runtime, _path, options) => {
    options.onInventory({ totalBytes: 10, totalFiles: 1 })
    options.onProgress({ doneBytes: 5, totalBytes: 10, doneFiles: 0, totalFiles: 1 })
    await tick(5)
    options.onProgress({ doneBytes: 10, totalBytes: 10, doneFiles: 1, totalFiles: 1 })
    return { kind: 'file', name: 'report.md', destination: 'C:/Downloads/report.md', totalBytes: 10, files: 1 }
  })
  const started = jobs.start(runtime, '/home/ubuntu/report.md', { destination: 'C:/Downloads' })
  assert.equal(started.phase, 'preparing')
  assert.equal(started.hostId, 'h_1')
  await tick(30)
  const ready = jobs.status(started.id)
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.doneBytes, 10)
  assert.equal(ready.totalFiles, 1)
  assert.equal(ready.destination, 'C:/Downloads/report.md')
  assert.ok(events.some((job) => job.phase === 'ready'))
})

test('a folder job writes to the chosen directory', async () => {
  const { jobs, events } = makeJobs(async (_runtime, _path, options) => {
    assert.equal(options.destination, 'C:/Users/me/Downloads')
    return {
      kind: 'folder',
      name: 'project',
      destination: 'C:/Users/me/Downloads/project',
      totalBytes: 42,
      files: 2,
    }
  })
  const started = jobs.start(runtime, '/home/ubuntu/project', { destination: 'C:/Users/me/Downloads' })
  await tick(20)
  const ready = jobs.status(started.id)
  assert.equal(ready.kind, 'folder')
  assert.equal(ready.name, 'project')
  assert.equal(ready.destination, 'C:/Users/me/Downloads/project')
  assert.equal(ready.totalBytes, 42)
  assert.ok(events.some((job) => job.kind === 'folder'))
})

test('the job carries the home root the API judged against into the writer', async () => {
  const seen = []
  const { jobs } = makeJobs(async (_runtime, _path, options) => {
    seen.push(options.home)
    return { kind: 'file', name: 'a.txt', destination: '/home/me/Downloads/a.txt', totalBytes: 1, files: 1 }
  })
  const started = jobs.start(runtime, '/home/ubuntu/a.txt', {
    destination: '/home/me/Downloads',
    home: '/home/me',
  })
  await tick(20)
  // The writer must judge the same root the pre-flight used, not `os.homedir()`.
  assert.deepEqual(seen, ['/home/me'])
  assert.equal('home' in jobs.status(started.id), false, 'the home root is not part of the client view')
})

test('a failed preparation publishes a client-safe error and keeps the job for inspection', async () => {
  const { jobs, events } = makeJobs(async () => {
    throw errors.remoteFileUnavailable({
      zh: '没有权限。',
      en: 'Permission denied.',
    })
  })
  const started = jobs.start(runtime, '/home/ubuntu/secret')
  await tick(20)
  const failed = jobs.status(started.id)
  assert.equal(failed.phase, 'error')
  assert.equal(failed.error.code, 'remote-file-unavailable')
  assert.ok(events.some((job) => job.phase === 'error'))
})

test('simultaneous preparations are bounded', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { jobs } = makeJobs(
    async () => {
      await gate
      return { kind: 'file', name: 'a', data: Buffer.from('a') }
    },
    { maxPreparing: 1 },
  )
  const first = jobs.start(runtime, '/home/ubuntu/a')
  assert.throws(() => jobs.start(runtime, '/home/ubuntu/b'), /download-busy/)
  release()
  await tick(20)
  assert.equal(jobs.status(first.id).phase, 'ready')
})

test('cancel removes a preparing job and ignores its late result', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const events = []
  const jobs = createDownloadJobs({
    emit: (job) => events.push(job),
    logger: { warn() {}, debug() {} },
    readDownload: async (_runtime, _path, options) => {
      options.onProgress({ doneBytes: 1, totalBytes: 2, doneFiles: 0, totalFiles: 1 })
      await gate
      return { kind: 'file', name: 'a', data: Buffer.from('a') }
    },
  })
  const started = jobs.start(runtime, '/home/ubuntu/a')
  await tick(5)
  assert.equal(jobs.cancel(started.id), true)
  assert.equal(jobs.cancel(started.id), false)
  release()
  await tick(20)
  assert.equal(jobs.size, 0)
  assert.equal(
    events.some((job) => job.phase === 'ready'),
    false,
  )
})

test('non-absolute paths are rejected before a job is created', () => {
  const { jobs } = makeJobs(async () => ({}))
  assert.throws(() => jobs.start(runtime, 'relative/path'), /invalid-input/)
  assert.equal(jobs.size, 0)
})

test('a folder job surfaces the names the download deliberately skipped', async () => {
  const { jobs } = makeJobs(async (_runtime, _path, options) => {
    options.onIgnored(['desktop.ini', 'setup.lnk'])
    return { kind: 'folder', name: 'project', destination: 'C:/Downloads/project', totalBytes: 6, files: 2 }
  })
  const started = jobs.start(runtime, '/home/ubuntu/project', { destination: 'C:/Downloads' })
  await tick(20)
  const ready = jobs.status(started.id)
  assert.deepEqual(ready.ignoredNames, ['desktop.ini', 'setup.lnk'])
})
