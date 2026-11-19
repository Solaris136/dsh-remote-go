/**
 * Local SSH material (read-only): `~/.ssh/config` and `~/.ssh/known_hosts`; never writes, never prompts.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** The two files of the local `~/.ssh` the wizard reads, plus the directory they live in. */
export interface LocalSshMaterial {
  sshDir: string
  configText: string
  knownHostsText: string
  configPath: string
  knownHostsPath: string
}

/** Injectable IO so the wizard can be tested without a real `~/.ssh`. */
export interface LocalSshInput {
  home: string
  exists?: (target: string) => boolean
  readFileImpl?: (target: string, encoding: 'utf8') => Promise<string>
}

export async function loadLocalSshMaterial(input: LocalSshInput): Promise<LocalSshMaterial> {
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
