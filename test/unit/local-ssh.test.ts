import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadLocalSshMaterial } from '../../dist/src/local-ssh.js'

test('loadLocalSshMaterial reads the existing config and known_hosts files', async () => {
  // path.join keeps the fixture portable: on Windows the same input becomes backslashes,
  // and loadLocalSshMaterial must behave identically there.
  const sshDir = path.join('/home/ubuntu', '.ssh')
  const configPath = path.join(sshDir, 'config')
  const knownHostsPath = path.join(sshDir, 'known_hosts')
  const reads = []
  const material = await loadLocalSshMaterial({
    home: '/home/ubuntu',
    exists: (file) => file === configPath || file === knownHostsPath,
    readFileImpl: async (file) => {
      reads.push(file)
      return file === configPath ? 'Host test-host\n  HostName 2001:db8::1\n' : 'test-host ssh-ed25519 AAAA\n'
    },
  })

  assert.deepEqual(material, {
    sshDir,
    configPath,
    knownHostsPath,
    configText: 'Host test-host\n  HostName 2001:db8::1\n',
    knownHostsText: 'test-host ssh-ed25519 AAAA\n',
  })
  assert.deepEqual(reads.sort(), [configPath, knownHostsPath].sort())
})

test('loadLocalSshMaterial returns empty text when neither file exists', async () => {
  const material = await loadLocalSshMaterial({
    home: '/home/empty',
    exists: () => false,
    readFileImpl: async () => assert.fail('no file should be read when it does not exist'),
  })
  assert.equal(material.configText, '')
  assert.equal(material.knownHostsText, '')
})

test('loadLocalSshMaterial never fails when checking or reading a file throws', async () => {
  const material = await loadLocalSshMaterial({
    home: '/home/broken',
    exists: (file) => {
      if (file.endsWith('config')) throw new Error('EACCES')
      return true
    },
    readFileImpl: async () => {
      throw new Error('EIO')
    },
  })
  assert.equal(material.configText, '')
  assert.equal(material.knownHostsText, '')
})
