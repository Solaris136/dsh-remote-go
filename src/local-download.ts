// Local download writer: streams one remote file or folder from SFTP into a user-selected local directory, never
// overwriting (a taken name gets a ` (2)` suffix). The destination is a **write primitive whose contents a remote host
// chooses**, so it is fenced to folders under the local user's home — otherwise a compromised remote could save into
// `…\Start Menu\Programs\Startup` or `~/.ssh/authorized_keys` and run code at the next logon.
import path from 'node:path'
import { homedir } from 'node:os'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { errors, isRemoteGoError } from './errors.js'
import type { RemoteGoError } from './errors.js'
import { remoteFileName, safeLocalSegment } from './remote-path.js'
import type { SshPort, TransferInventory, TransferProgress } from './ssh-port.js'

/** Why a local folder may not receive a remote download, or null when it is acceptable. */
export type DestinationRefusal =
  'invalid' | 'outside-home' | 'autorun' | 'credentials' | 'login' | 'system' | 'protected' | null

type Refusal = Exclude<DestinationRefusal, null>

// Segments that execute something at logon or authorize one, matched case-insensitively as a whole segment anywhere
// below home (so `…\Start Menu\Programs\Startup` and `~/.config/autostart` hit). The login group covers the shell
// startup files, `~/.config`/`~/.local` (whose `bin` is on PATH in many distributions), the macOS login items and X.
const FORBIDDEN_SEGMENTS = new Map<string, Refusal>([
  ['startup', 'autorun'],
  ['startupfolder', 'autorun'],
  ['startupitems', 'autorun'],
  ['autostart', 'autorun'],
  ['systemd', 'autorun'],
  ['launchagents', 'autorun'],
  ['launchdaemons', 'autorun'],
  ['.ssh', 'credentials'],
  ['.gnupg', 'credentials'],
  ['.config', 'login'],
  ['.local', 'login'],
  ['.bashrc', 'login'],
  ['.bash_profile', 'login'],
  ['.bash_login', 'login'],
  ['.bash_logout', 'login'],
  ['.profile', 'login'],
  ['.zshrc', 'login'],
  ['.zprofile', 'login'],
  ['.zshenv', 'login'],
  ['.zlogin', 'login'],
  ['.zlogout', 'login'],
  ['.kshrc', 'login'],
  ['.cshrc', 'login'],
  ['.tcshrc', 'login'],
  ['.login', 'login'],
  ['.logout', 'login'],
  ['.xsessionrc', 'login'],
  ['.xprofile', 'login'],
  ['.xinitrc', 'login'],
])

/** `shell:startup` / `shell:common startup` name an autorun folder without spelling a path. */
const SHELL_FOLDER_RE = /^\s*shell\s*:/i
/** Directories that belong to the OS; never a download target even if home somehow covers them. */
const SYSTEM_ROOTS: readonly string[] = Object.freeze(
  process.platform === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/opt', '/var', '/dev', '/proc', '/sys'],
)

/** A stronger reason wins when several segments of one path match (most specific first). */
const REASON_PRIORITY: Refusal[] = ['autorun', 'credentials', 'login', 'system']
/** The client-facing text of each refusal; `invalid` also covers "no destination at all". */
const REFUSAL_TEXT: Record<Refusal, { zh: string; en: string }> = {
  invalid: { zh: '请选择本机的保存文件夹。', en: 'Choose a destination folder on this machine.' },
  'outside-home': {
    zh: '只能保存到本机用户主目录下的文件夹（防止写入系统或自启动位置）。',
    en: 'Downloads must go to a folder under this machine’s home directory (system and autorun locations are refused).',
  },
  autorun: {
    zh: '不能保存到自启动目录（例如 Startup / autostart / shell:startup）。',
    en: 'An autorun folder (for example Startup / autostart / shell:startup) cannot be a download target.',
  },
  credentials: {
    zh: '不能保存到 SSH / GPG 配置目录（例如 .ssh）。',
    en: 'An SSH / GPG configuration folder (for example .ssh) cannot be a download target.',
  },
  login: {
    zh: '不能保存到登录脚本或用户配置目录（例如 .bashrc / .profile / .config / .local）。',
    en: 'A login script or user configuration folder (for example .bashrc / .profile / .config / .local) cannot be a download target.',
  },
  protected: {
    zh: '不能保存到会在登录或启动时生效的位置（自启动、登录脚本或凭据目录及其上级目录）。',
    en: 'A location that runs or authenticates at logon (autorun, login scripts, credentials, or one of their parent folders) cannot be a download target.',
  },
  system: {
    zh: '不能保存到系统目录。',
    en: 'A system directory cannot be a download target.',
  },
}

/** The remaining client-facing texts of this module. */
const TEXT = {
  notFolder: { zh: '选择的保存位置不是文件夹。', en: 'The selected destination is not a folder.' },
  destinationUnusable: {
    zh: '选择的保存文件夹不存在或不可写。',
    en: 'The selected destination folder does not exist or cannot be written.',
  },
  tooManyFolders: {
    zh: '目标目录里已经有太多同名文件夹，请换一个目录。',
    en: 'The destination already contains too many folders with this name; choose another directory.',
  },
  tooManyFiles: {
    zh: '目标目录里已经有太多同名文件，请换一个目录。',
    en: 'The destination already contains too many files with this name; choose another directory.',
  },
  fileNotConnected: {
    zh: '这台主机还没有连接，无法读取远端文件。',
    en: 'This host is not connected, so the remote file cannot be read.',
  },
  folderNotConnected: {
    zh: '这台主机还没有连接，无法读取远端文件夹。',
    en: 'This host is not connected, so the remote folder cannot be read.',
  },
}

export interface DownloadDestinationOptions {
  home?: string
}

export interface HostDownloadRuntime {
  readonly id: string
  readonly status: string
  readonly ssh: SshPort | null
}

export interface SaveHostFileOptions {
  onProgress?: (info: TransferProgress) => void
  isCancelled?: () => boolean
  home?: string
}

export interface SaveHostFolderOptions {
  onInventory?: (info: TransferInventory) => void
  onProgress?: (info: TransferProgress) => void
  onIgnored?: (names: string[]) => void
  isCancelled?: () => boolean
  home?: string
}

export interface SavedFile {
  path: string
  kind: 'file'
  name: string
  destination: string
  totalBytes: number
  files: number
}

export interface SavedFolder {
  path: string
  kind: 'folder'
  name: string
  destination: string
  totalBytes: number
  files: number
  cancelled?: boolean
}

export type SavedDownload = SavedFile | SavedFolder

// Windows and macOS default to a case-insensitive filesystem, so compare the way the OS does.
function comparable(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
}

function segmentsOf(resolved: string): string[] {
  return resolved.split(/[\\/]+/).filter((segment) => segment !== '')
}

function isInside(root: string, target: string): boolean {
  const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target === root || target.startsWith(base)
}

// Locations whose *contents* run or authenticate at logon: a download may neither land inside one nor create an
// ancestor of one, or `~/AppData/Roaming` plus a remote folder named `Microsoft` would put a Startup tree on disk.
function sensitiveRoots(home: string): string[] {
  const roots = ['.config', '.local', '.ssh', '.gnupg'].map((name) => path.join(home, name))
  roots.push(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'))
  for (const name of ['LaunchAgents', 'LaunchDaemons', 'StartupItems']) roots.push(path.join(home, 'Library', name))
  const appData = typeof process.env.APPDATA === 'string' && process.env.APPDATA.trim() !== ''
  if (appData) roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu'))
  return roots
}

/** Whether a path is a sensitive location, inside one, or an ancestor of one. */
function isProtectedLocation(target: string, home: string): boolean {
  const resolved = comparable(target)
  for (const root of sensitiveRoots(home)) {
    const sensitive = comparable(path.resolve(root))
    if (isInside(sensitive, resolved) || isInside(resolved, sensitive)) return true
  }
  return false
}

function homeOf(options: DownloadDestinationOptions = {}): string {
  return path.resolve(options.home ?? homedir())
}

// Pure: no filesystem access, so a caller can ask before creating anything and a test can ask about
// a folder that does not exist.
export function destinationPolicy(destination: unknown, options: DownloadDestinationOptions = {}): DestinationRefusal {
  if (typeof destination !== 'string' || destination.trim() === '' || destination.includes('\0')) return 'invalid'
  if (SHELL_FOLDER_RE.test(destination)) return 'autorun'
  const home = comparable(homeOf(options))
  const target = comparable(path.resolve(destination))
  if (!isInside(home, target)) return 'outside-home'
  const segments = segmentsOf(target)
  const reasons = new Set<Refusal>()
  for (const segment of segments) {
    const reason = FORBIDDEN_SEGMENTS.get(segment.toLowerCase())
    if (reason !== undefined) reasons.add(reason)
  }
  // `…\Start Menu\Programs`: a two-segment location whose entries appear in the Start menu.
  for (let at = 1; at < segments.length; at += 1) {
    if (segments[at - 1].toLowerCase() === 'start menu' && segments[at].toLowerCase() === 'programs') {
      reasons.add('autorun')
    }
  }
  for (const root of SYSTEM_ROOTS) {
    if (isInside(comparable(path.resolve(root)), target)) reasons.add('system')
  }
  for (const reason of REASON_PRIORITY) if (reasons.has(reason)) return reason
  return null
}

function destinationRefusal(reason: DestinationRefusal): RemoteGoError {
  return errors.invalidInput('destination', REFUSAL_TEXT[reason ?? 'invalid'])
}

// The destination is chosen locally, but the *name* below it comes from the remote tree (`~/.config` + a remote folder
// called `autostart`, `~` + a remote file called `.bash_login`); this refuses those combinations before any write.
function assertCandidateAllowed(candidate: string, options: DownloadDestinationOptions = {}): void {
  const refusal = destinationPolicy(candidate, options)
  if (refusal !== null) throw destinationRefusal(refusal)
  if (isProtectedLocation(candidate, homeOf(options))) throw destinationRefusal('protected')
}

export async function requireDestination(
  destination: unknown,
  options: DownloadDestinationOptions = {},
): Promise<string> {
  const refusal = destinationPolicy(destination, options)
  if (refusal !== null) throw destinationRefusal(refusal)
  // `destinationPolicy` accepts only a non-empty string path, so by here the unknown is a string;
  // the `as` restates that narrowing instead of adding a second runtime check.
  const base = path.resolve(destination as string)
  try {
    const info = await stat(base)
    if (!info.isDirectory()) throw errors.invalidInput('destination', TEXT.notFolder)
  } catch (error) {
    if (isRemoteGoError(error)) throw error
    throw errors.invalidInput('destination', TEXT.destinationUnusable)
  }
  return base
}

/** Only EEXIST means "this name is taken, try the next suffix"; every other code is a real failure. */
function isTaken(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EEXIST'
}

async function createUniqueFolder(
  base: string,
  name: unknown,
  options: DownloadDestinationOptions = {},
): Promise<string> {
  const safeName = safeLocalSegment(name) || 'download'
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(base, index === 1 ? safeName : `${safeName} (${index})`)
    // The root's name comes from the remote tree, so it is judged before anything is created:
    // `~/.config` + a remote folder called `autostart` must fail here, with zero writes.
    assertCandidateAllowed(candidate, options)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (!isTaken(error)) throw error
    }
  }
  throw errors.invalidInput('destination', TEXT.tooManyFolders)
}

async function createUniqueFile(
  base: string,
  name: unknown,
  options: DownloadDestinationOptions = {},
): Promise<string> {
  const safeName = safeLocalSegment(name) || 'download'
  const extension = path.extname(safeName)
  const stem = path.basename(safeName, extension) || 'download'
  for (let index = 1; index <= 999; index += 1) {
    const fileName = index === 1 ? safeName : `${stem} (${index})${extension}`
    const candidate = path.join(base, fileName)
    // The remote names the file: `~` + `.bash_login` is a login script, not a download.
    assertCandidateAllowed(candidate, options)
    try {
      const handle = await open(candidate, 'wx', 0o600)
      await handle.close()
      return candidate
    } catch (error) {
      if (!isTaken(error)) throw error
    }
  }
  throw errors.invalidInput('destination', TEXT.tooManyFiles)
}

function toDownloadError(error: unknown): RemoteGoError {
  // `isRemoteGoError` only declares a boolean (it lives in the P1a set); the `as` restates
  // the narrowing its `instanceof` proves at runtime.
  if (isRemoteGoError(error)) return error as RemoteGoError
  return errors.remoteFileUnavailable(undefined, {
    technical: String((error as { message?: unknown } | null)?.message ?? error ?? '').slice(0, 300),
  })
}

function requireTransport(
  runtime: HostDownloadRuntime | null | undefined,
  notConnected: { zh: string; en: string },
): SshPort {
  if (!runtime || runtime.status !== 'connected' || !runtime.ssh) throw errors.remoteFileUnavailable(notConnected)
  return runtime.ssh
}

export async function saveHostFile(
  runtime: HostDownloadRuntime | null | undefined,
  remotePath: string,
  destination: unknown,
  options: SaveHostFileOptions = {},
): Promise<SavedFile> {
  const ssh = requireTransport(runtime, TEXT.fileNotConnected)
  if (typeof ssh.saveRemoteFile !== 'function') throw errors.internal('the SSH transport does not support file saves')
  const base = await requireDestination(destination, options)
  const name = remoteFileName(remotePath)
  let localPath: string | null = null
  try {
    localPath = await createUniqueFile(base, name, options)
    const result = await ssh.saveRemoteFile(remotePath, localPath, options)
    return {
      path: remotePath,
      kind: 'file',
      name: path.basename(localPath),
      destination: localPath,
      totalBytes: Number(result?.size ?? 0),
      files: 1,
    }
  } catch (error) {
    if (localPath) await rm(localPath, { force: true }).catch(() => {})
    throw toDownloadError(error)
  }
}

export async function saveHostFolder(
  runtime: HostDownloadRuntime | null | undefined,
  remotePath: string,
  destination: unknown,
  options: SaveHostFolderOptions = {},
): Promise<SavedFolder> {
  const ssh = requireTransport(runtime, TEXT.folderNotConnected)
  if (typeof ssh.saveRemoteTree !== 'function') throw errors.internal('the SSH transport does not support folder saves')
  const base = await requireDestination(destination, options)
  const name = remoteFileName(remotePath)
  let root: string | null = null
  try {
    root = await createUniqueFolder(base, name, options)
    const result = await ssh.saveRemoteTree(remotePath, root, options)
    return {
      path: remotePath,
      kind: 'folder',
      name,
      destination: result?.destination ?? root,
      totalBytes: Number(result?.totalBytes ?? 0),
      files: Number(result?.totalFiles ?? 0),
      ...(result?.cancelled === true ? { cancelled: true } : {}),
    }
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
    throw toDownloadError(error)
  }
}
