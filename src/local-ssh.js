/**
 * Local SSH material (read-only): `~/.ssh/config` and `~/.ssh/known_hosts`.
 * Never writes, never prompts.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {{ home: string, readFileImpl?: typeof readFile, exists?: (path: string) => boolean }} input
 * @returns {Promise<{ sshDir: string, configText: string, knownHostsText: string, configPath: string, knownHostsPath: string }>}
 */
export async function loadLocalSshMaterial(input) {
  const sshDir = path.join(input.home, '.ssh')
  const configPath = path.join(sshDir, 'config')
  const knownHostsPath = path.join(sshDir, 'known_hosts')
  const exists = input.exists ?? existsSync
  const read = input.readFileImpl ?? readFile
  let configText = ''
  let knownHostsText = ''
  try {
    if (exists(configPath)) configText = await read(configPath, 'utf8')
  } catch {
    configText = ''
  }
  try {
    if (exists(knownHostsPath)) knownHostsText = await read(knownHostsPath, 'utf8')
  } catch {
    knownHostsText = ''
  }
  return { sshDir, configText, knownHostsText, configPath, knownHostsPath }
}
