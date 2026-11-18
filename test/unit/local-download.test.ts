import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { destinationPolicy, requireDestination, saveHostFile, saveHostFolder } from '../../dist/src/local-download.js'
import { isRemoteGoError } from '../../dist/src/errors.js'
import { readHostDownload } from '../../dist/src/remote-files.js'

const connected = (ssh) => ({ status: 'connected', ssh })

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** assert.rejects matcher: a RemoteGoError carrying exactly `code`. */
const coded = (code) => (error) => {
  assert.ok(isRemoteGoError(error), `expected a RemoteGoError, got ${error?.name}: ${error?.message}`)
  assert.equal(error.code, code)
  return true
}

const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
const under = (...parts) => path.join(HOME, ...parts)
const WINDOWS = process.platform === 'win32'

/** A connected host whose transport records every write, so a refusal can prove zero writes. */
function recordingRuntime(kind = 'file') {
  const writes = []
  const runtime = {
    id: 'h_1',
    status: 'connected',
    ssh: {
      async inspectRemotePath() {
        return kind === 'folder'
          ? { isFile: false, isDirectory: true, size: 0 }
          : { isFile: true, isDirectory: false, size: 12 }
      },
      async saveRemoteFile(_remotePath, localPath) {
        writes.push(localPath)
        return { size: 12 }
      },
      async saveRemoteTree(_remotePath, root) {
        writes.push(root)
        return { destination: root, totalBytes: 0, totalFiles: 0 }
      },
    },
  }
  return { runtime, writes }
}

describe('download writer: files and folders', () => {
  test('requireDestination accepts an existing directory and rejects everything else', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-destination-')
    assert.equal(await requireDestination(root, { home: root }), path.resolve(root))

    for (const value of [undefined, null, '', '   ', `${root}\0suffix`]) {
      await assert.rejects(
        () => requireDestination(value, { home: root }),
        coded('invalid-input'),
        `value ${JSON.stringify(value)}`,
      )
    }

    const file = path.join(root, 'not-a-directory.txt')
    await writeFile(file, 'x')
    await assert.rejects(() => requireDestination(file, { home: root }), coded('invalid-input'))
    await assert.rejects(() => requireDestination(path.join(root, 'missing'), { home: root }), coded('invalid-input'))
  })

  test('saveHostFile requires a connected host with a file-capable transport', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-file-')
    await assert.rejects(
      () => saveHostFile(null, '/home/ubuntu/a.txt', root, { home: root }),
      coded('remote-file-unavailable'),
    )
    await assert.rejects(
      () => saveHostFile({ status: 'disconnected', ssh: {} }, '/home/ubuntu/a.txt', root, { home: root }),
      coded('remote-file-unavailable'),
    )
    await assert.rejects(
      () => saveHostFile(connected({}), '/home/ubuntu/a.txt', root, { home: root }),
      coded('internal'),
    )
  })

  test('saveHostFile streams one file and auto-renames an existing target', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-file-')
    const written = []
    const ssh = {
      async saveRemoteFile(remotePath, localPath, options) {
        written.push({ remotePath, localPath, options })
        await writeFile(localPath, 'downloaded')
        return { size: 10 }
      },
    }

    const first = await saveHostFile(connected(ssh), '/home/ubuntu/notes.txt', root, { home: root, onProgress() {} })
    assert.deepEqual(
      { kind: first.kind, name: first.name, path: first.path, files: first.files, totalBytes: first.totalBytes },
      {
        kind: 'file',
        name: 'notes.txt',
        path: '/home/ubuntu/notes.txt',
        files: 1,
        totalBytes: 10,
      },
    )
    assert.equal(first.destination, path.join(root, 'notes.txt'))
    assert.equal(await readFile(first.destination, 'utf8'), 'downloaded')
    assert.equal(written.length, 1)

    const second = await saveHostFile(connected(ssh), '/home/ubuntu/notes.txt', root, { home: root })
    assert.equal(second.name, 'notes (2).txt')
    assert.equal(second.destination, path.join(root, 'notes (2).txt'))
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'downloaded')
  })

  test('saveHostFile removes a partial local file and maps an unknown transport failure', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-file-')
    const ssh = {
      async saveRemoteFile(_remotePath, localPath) {
        await writeFile(localPath, 'partial')
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      },
    }
    await assert.rejects(
      () => saveHostFile(connected(ssh), '/home/ubuntu/big.bin', root, { home: root }),
      (error) => coded('remote-file-unavailable')(error) && /connection reset/.test(error.technical),
    )
    await assert.rejects(() => stat(path.join(root, 'big.bin')), /ENOENT/)
  })

  test('saveHostFile preserves a coded error and still cleans the partial file', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-file-')
    const { errors } = await import('../../dist/src/errors.js')
    const ssh = {
      async saveRemoteFile(_remotePath, localPath) {
        await writeFile(localPath, 'partial')
        throw errors.remoteFileUnavailable({ zh: '远端文件不存在。', en: 'The remote file does not exist.' })
      },
    }
    await assert.rejects(
      () => saveHostFile(connected(ssh), '/home/ubuntu/gone.bin', root, { home: root }),
      coded('remote-file-unavailable'),
    )
    await assert.rejects(() => stat(path.join(root, 'gone.bin')), /ENOENT/)
  })

  test('saveHostFolder requires a connected host with a tree-capable transport', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
    await assert.rejects(
      () => saveHostFolder(null, '/home/ubuntu/reports', root, { home: root }),
      coded('remote-file-unavailable'),
    )
    await assert.rejects(
      () => saveHostFolder(connected({}), '/home/ubuntu/reports', root, { home: root }),
      coded('internal'),
    )
  })

  test('saveHostFolder copies one folder and auto-renames an existing target', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
    const trees = []
    const ssh = {
      async saveRemoteTree(remotePath, targetRoot, options) {
        trees.push({ remotePath, targetRoot, options })
        await mkdir(path.join(targetRoot, 'nested'), { recursive: true })
        await writeFile(path.join(targetRoot, 'nested', 'a.txt'), 'a')
        return { destination: targetRoot, totalBytes: 1, totalFiles: 1 }
      },
    }

    const first = await saveHostFolder(connected(ssh), '/home/ubuntu/reports', root, { home: root, onInventory() {} })
    assert.deepEqual(
      { kind: first.kind, name: first.name, path: first.path, files: first.files, totalBytes: first.totalBytes },
      { kind: 'folder', name: 'reports', path: '/home/ubuntu/reports', files: 1, totalBytes: 1 },
    )
    assert.equal(first.destination, path.join(root, 'reports'))
    assert.equal(await readFile(path.join(first.destination, 'nested', 'a.txt'), 'utf8'), 'a')
    assert.equal(trees.length, 1)

    const second = await saveHostFolder(connected(ssh), '/home/ubuntu/reports', root, { home: root })
    // A folder download keeps the remote name in `name`; only the local directory is renamed.
    assert.equal(second.name, 'reports')
    assert.equal(second.destination, path.join(root, 'reports (2)'))
  })

  test('saveHostFolder reports cancellation and removes a failed copy', async (t) => {
    const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
    const cancelling = {
      async saveRemoteTree(_remotePath, targetRoot) {
        return { destination: targetRoot, totalBytes: 3, totalFiles: 2, cancelled: true }
      },
    }
    const cancelled = await saveHostFolder(connected(cancelling), '/home/ubuntu/partial', root, { home: root })
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.files, 2)

    const failing = {
      async saveRemoteTree() {
        throw Object.assign(new Error('SFTP closed'), { code: 'ECONNRESET' })
      },
    }
    await assert.rejects(
      () => saveHostFolder(connected(failing), '/home/ubuntu/broken', root, { home: root }),
      (error) => coded('remote-file-unavailable')(error) && /SFTP closed/.test(error.technical),
    )
    await assert.rejects(() => stat(path.join(root, 'broken')), /ENOENT/)
  })
})

describe('download destination policy', () => {
  test('a download destination must stay under the home directory, never an autorun or system folder', () => {
    const cases = [
      // Ordinary user folders are fine.
      [under('Downloads'), null],
      [under('Documents', 'projects'), null],
      [HOME, null],
      // Outside home, however harmless it looks.
      [WINDOWS ? 'D:\\Downloads' : '/srv/downloads', 'outside-home'],
      [under('..', 'elsewhere'), 'outside-home'],
      [WINDOWS ? 'C:\\Windows\\System32' : '/etc/cron.d', 'outside-home'],
      // Autostart locations, both operating systems.
      [under('AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), 'autorun'],
      [under('AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'startup'), 'autorun'],
      [under('AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 'autorun'],
      [under('.config', 'autostart'), 'autorun'],
      [under('.config', 'systemd', 'user'), 'autorun'],
      ['shell:startup', 'autorun'],
      ['shell:common startup', 'autorun'],
      // Credential folders: writing `authorized_keys` into ~/.ssh would authorize the remote host.
      [under('.ssh'), 'credentials'],
      [under('.gnupg'), 'credentials'],
      // macOS login items, and the X session files on Linux/BSD.
      [under('Library', 'LaunchAgents'), 'autorun'],
      [under('Library', 'LaunchDaemons'), 'autorun'],
      [under('Library', 'StartupItems'), 'autorun'],
      [under('Library', 'launchagents'), 'autorun'],
      [under('.xsessionrc'), 'login'],
      [under('.xinitrc'), 'login'],
      [under('.xprofile'), 'login'],
      // A macOS user folder that is not a login item is fine.
      [under('Library', 'Caches'), null],
      [under('Library', 'Application Support', 'app'), null],
      // The segment rules themselves are case-insensitive on every platform.
      [under('.SSH'), 'credentials'],
      [under('Startup'), 'autorun'],
      // Login scripts and the per-user containers that hold them.
      [under('.config'), 'login'],
      [under('.config', 'mytool'), 'login'],
      [under('.local', 'bin'), 'login'],
      [under('.bashrc'), 'login'],
      [under('.profile'), 'login'],
      [under('.zshrc'), 'login'],
      [under('.bash_login'), 'login'],
      // A destination with a NUL byte or no value at all is not a folder name.
      ['', 'invalid'],
      ['  ', 'invalid'],
      [`${under('Downloads')}\0x`, 'invalid'],
      [null, 'invalid'],
    ]
    for (const [value, expected] of cases) {
      assert.equal(destinationPolicy(value, { home: HOME }), expected, JSON.stringify(value))
    }
  })

  test('a system directory is refused even when the home directory covers it', () => {
    const systemRoot = WINDOWS ? 'C:\\Windows' : '/etc'
    // The reason is the platform directory itself, not just "outside home".
    assert.equal(destinationPolicy(path.join(systemRoot, 'tasks'), { home: path.dirname(systemRoot) }), 'system')
  })

  test('a download into an autorun or login destination is refused before anything is written', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-dest-'))
    const startup = path.join(base, 'Startup')
    await mkdir(startup)
    const { runtime, writes } = recordingRuntime()
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/payload.exe', { destination: startup, home: base }),
      (error) => error.code === 'invalid-input',
    )
    assert.deepEqual(writes, [], 'a refused destination must never reach the transport')
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/payload.exe', {
        destination: base,
        home: path.join(base, 'sub', 'home'),
      }),
      (error) => error.code === 'invalid-input',
    )
    assert.deepEqual(writes, [])
  })

  test('a remote-named folder cannot become an autorun, credential or login location', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-candidate-'))
    const config = path.join(base, '.config')
    await mkdir(config)
    const { runtime, writes } = recordingRuntime('folder')

    // The reported bypass: a legal destination (`~/.config` used to pass before the login rule) is
    // no longer reachable either, and a remote folder named `autostart` is refused on its own.
    for (const destination of [config, base]) {
      await assert.rejects(
        readHostDownload(runtime, '/home/ubuntu/autostart', { destination, home: base }),
        (error) => error.code === 'invalid-input',
        `destination ${destination}`,
      )
    }
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/.ssh', { destination: base, home: base }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/Startup', { destination: base, home: base }),
      (error) => error.code === 'invalid-input',
    )
    // Nothing was created under the home root, and the transport never ran.
    assert.deepEqual(writes, [], 'a refused candidate must never reach the transport')
    assert.deepEqual((await readdir(base)).sort(), ['.config'], 'a refused candidate must create nothing')
    assert.deepEqual(await readdir(config), [])
  })

  test('a remote-named file cannot become a login script', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-login-'))
    const { runtime, writes } = recordingRuntime('file')
    for (const name of ['.bash_login', '.profile', '.zshrc']) {
      await assert.rejects(
        readHostDownload(runtime, `/home/ubuntu/${name}`, { destination: base, home: base }),
        (error) => error.code === 'invalid-input',
        name,
      )
      assert.equal(existsSync(path.join(base, name)), false, `${name} must not be created`)
    }
    assert.deepEqual(writes, [])
    assert.deepEqual(await readdir(base), [])
  })

  test('an ancestor of a protected location cannot be created either', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-ancestor-'))
    const roaming = path.join(base, 'AppData', 'Roaming')
    await mkdir(roaming, { recursive: true })
    const { runtime, writes } = recordingRuntime('folder')
    // `…/AppData/Roaming/Microsoft` looks unremarkable, but a folder downloaded there could then
    // contain `Windows/Start Menu/Programs/Startup` — the tree writer creates nested paths.
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/Microsoft', { destination: roaming, home: base }),
      (error) => error.code === 'invalid-input',
    )
    assert.deepEqual(writes, [])
    assert.equal(existsSync(path.join(roaming, 'Microsoft')), false)
  })

  test('a remote-named macOS login item is refused before anything is written', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-launchagents-'))
    const library = path.join(base, 'Library')
    await mkdir(library)
    const { runtime, writes } = recordingRuntime('folder')
    // `~/Library` is an ordinary destination, but the remote chooses the name below it…
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/LaunchAgents', { destination: library, home: base }),
      (error) => error.code === 'invalid-input',
    )
    // …and must not be able to create `~/Library` itself either: a tree written below it could
    // contain `LaunchAgents/…`, which macOS runs at login.
    await assert.rejects(
      readHostDownload(runtime, '/home/ubuntu/Library', { destination: base, home: base }),
      (error) => error.code === 'invalid-input',
    )
    assert.deepEqual(writes, [], 'a refused candidate must never reach the transport')
    assert.deepEqual(await readdir(library), [])
    assert.equal(existsSync(path.join(library, 'LaunchAgents')), false)
  })

  test('requireDestination accepts a real user folder and rejects a file', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-dest-ok-'))
    assert.equal(await requireDestination(base, { home: base }), path.resolve(base))
    const nested = path.join(base, 'nested')
    await mkdir(nested)
    assert.equal(await requireDestination(nested, { home: base }), path.resolve(nested))
    await assert.rejects(
      requireDestination(path.join(base, 'nested', 'missing'), { home: base }),
      (error) => error.code === 'invalid-input',
    )
  })

  test('the policy is pure: it never creates or inspects the destination', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-dest-pure-'))
    const ghost = path.join(base, 'never-created')
    assert.equal(destinationPolicy(ghost, { home: base }), null)
    assert.deepEqual(await readdir(base), [])
  })
})
