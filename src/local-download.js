/**
 * Local download writer. Every download (single file or folder) is streamed from
 * SFTP directly to a user-selected local directory. Nothing is archived or held in
 * memory, and there is no byte or entry cap. Existing target names are renamed with
 * a ` (2)`, ` (3)` suffix so a download never overwrites local data.
 *
 * The destination is a **write primitive that a remote host chooses the contents of** (the
 * file or folder name comes from the remote tree), so it is fenced like one: only folders
 * under the local user's home, and never a system, autorun or credential folder. Without this
 * fence a compromised remote could ask the GUI to save its tree into
 * `…\Start Menu\Programs\Startup` (or `~/.ssh/authorized_keys`) and run code on this machine at
 * the next logon.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { errors, isRemoteGoError } from './errors.js';
import { remoteFileName, safeLocalSegment } from './remote-path.js';
/**
 * Path segments that execute something when the user logs in, or that authorize a login.
 * Matched case-insensitively as a whole segment anywhere below the home directory, so both
 * `…\Start Menu\Programs\Startup` and `~/.config/autostart` are covered. Shell startup files
 * and the per-user containers that hold them (`~/.config`, `~/.local`, whose `bin` is on PATH in
 * many distributions) are refused for the same reason, as are the macOS login-item folders
 * (`~/Library/LaunchAgents`, `LaunchDaemons`, `StartupItems`) and the X session files.
 */
const FORBIDDEN_SEGMENTS = new Map([
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
]);
/** `shell:startup` / `shell:common startup` name an autorun folder without spelling a path. */
const SHELL_FOLDER_RE = /^\s*shell\s*:/i;
/** Directories that belong to the OS; never a download target even if home somehow covers them. */
const SYSTEM_ROOTS = Object.freeze(process.platform === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/opt', '/var', '/dev', '/proc', '/sys']);
/** A stronger reason wins when several segments of one path match (most specific first). */
const REASON_PRIORITY = ['autorun', 'credentials', 'login', 'system'];
/**
 * One resolved path, comparable on this platform. Windows and macOS both have a
 * case-insensitive default filesystem, so a case-insensitive compare is the one the OS itself
 * would do (`C:\Users` vs `c:\users`, `/Users/Me` vs `/Users/me`).
 */
function comparable(value) {
    return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
}
function segmentsOf(resolved) {
    return resolved.split(/[\\/]+/).filter((segment) => segment !== '');
}
function isInside(root, target) {
    const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return target === root || target.startsWith(base);
}
/**
 * Locations whose *contents* run or authenticate at logon. A download may neither land inside
 * one of them nor create one of their ancestors: a remote folder named `Microsoft` under
 * `~/AppData/Roaming` would otherwise put a whole `Windows\Start Menu\Programs\Startup` tree on
 * disk without any single path segment looking suspicious (macOS has the same shape under
 * `~/Library`).
 * @param home - resolved home directory.
 * @returns resolved sensitive roots that exist by definition (not on disk).
 */
function sensitiveRoots(home) {
    const roots = ['.config', '.local', '.ssh', '.gnupg'].map((name) => path.join(home, name));
    roots.push(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'));
    for (const name of ['LaunchAgents', 'LaunchDaemons', 'StartupItems']) {
        roots.push(path.join(home, 'Library', name));
    }
    const appData = typeof process.env.APPDATA === 'string' && process.env.APPDATA.trim() !== '';
    if (appData)
        roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu'));
    return roots;
}
/**
 * Whether a path is a sensitive location, inside one, or an ancestor of one.
 * @param target - resolved candidate path.
 * @param home - resolved home directory.
 */
function isProtectedLocation(target, home) {
    const resolved = comparable(target);
    for (const root of sensitiveRoots(home)) {
        const sensitive = comparable(path.resolve(root));
        if (isInside(sensitive, resolved) || isInside(resolved, sensitive))
            return true;
    }
    return false;
}
/** The concrete home directory a policy call is judged against. */
function homeOf(options = {}) {
    return path.resolve(options.home ?? homedir());
}
/**
 * Whether one local folder may receive a remote download.
 * @param destination - the folder the client asked to save into.
 * @param options - the local user's home (defaults to the OS home).
 * @returns a refusal reason, or null when the folder is acceptable. Pure: no filesystem
 *   access, so it is testable.
 */
export function destinationPolicy(destination, options = {}) {
    if (typeof destination !== 'string' || destination.trim() === '' || destination.includes('\0'))
        return 'invalid';
    if (SHELL_FOLDER_RE.test(destination))
        return 'autorun';
    const home = comparable(homeOf(options));
    const target = comparable(path.resolve(destination));
    if (!isInside(home, target))
        return 'outside-home';
    const segments = segmentsOf(target);
    const reasons = new Set();
    for (const segment of segments) {
        const reason = FORBIDDEN_SEGMENTS.get(segment.toLowerCase());
        if (reason !== undefined)
            reasons.add(reason);
    }
    // `…\Start Menu\Programs`: a two-segment location whose entries appear in the Start menu.
    for (let at = 1; at < segments.length; at += 1) {
        if (segments[at - 1].toLowerCase() === 'start menu' && segments[at].toLowerCase() === 'programs') {
            reasons.add('autorun');
        }
    }
    for (const root of SYSTEM_ROOTS) {
        if (isInside(comparable(path.resolve(root)), target))
            reasons.add('system');
    }
    for (const reason of REASON_PRIORITY)
        if (reasons.has(reason))
            return reason;
    return null;
}
/** The client-facing refusal for one destination policy result. */
function destinationRefusal(reason) {
    if (reason === 'outside-home') {
        return errors.invalidInput('destination', {
            zh: '只能保存到本机用户主目录下的文件夹（防止写入系统或自启动位置）。',
            en: 'Downloads must go to a folder under this machine’s home directory (system and autorun locations are refused).',
        });
    }
    if (reason === 'autorun') {
        return errors.invalidInput('destination', {
            zh: '不能保存到自启动目录（例如 Startup / autostart / shell:startup）。',
            en: 'An autorun folder (for example Startup / autostart / shell:startup) cannot be a download target.',
        });
    }
    if (reason === 'credentials') {
        return errors.invalidInput('destination', {
            zh: '不能保存到 SSH / GPG 配置目录（例如 .ssh）。',
            en: 'An SSH / GPG configuration folder (for example .ssh) cannot be a download target.',
        });
    }
    if (reason === 'login') {
        return errors.invalidInput('destination', {
            zh: '不能保存到登录脚本或用户配置目录（例如 .bashrc / .profile / .config / .local）。',
            en: 'A login script or user configuration folder (for example .bashrc / .profile / .config / .local) cannot be a download target.',
        });
    }
    if (reason === 'protected') {
        return errors.invalidInput('destination', {
            zh: '不能保存到会在登录或启动时生效的位置（自启动、登录脚本或凭据目录及其上级目录）。',
            en: 'A location that runs or authenticates at logon (autorun, login scripts, credentials, or one of their parent folders) cannot be a download target.',
        });
    }
    if (reason === 'system') {
        return errors.invalidInput('destination', {
            zh: '不能保存到系统目录。',
            en: 'A system directory cannot be a download target.',
        });
    }
    return errors.invalidInput('destination', {
        zh: '请选择本机的保存文件夹。',
        en: 'Choose a destination folder on this machine.',
    });
}
/**
 * Refuse a path the remote host named inside an already-accepted destination.
 *
 * The destination is chosen locally, but the *name* below it comes from the remote tree
 * (`~/Downloads/…`, `~/.config` + a remote folder called `autostart`, `~` + a remote file called
 * `.bash_login`). This is the check that turns those combinations into a refusal.
 * @param candidate - resolved folder or file path about to be created.
 * @throws `invalid-input` when the path is protected.
 */
function assertCandidateAllowed(candidate, options = {}) {
    const refusal = destinationPolicy(candidate, options);
    if (refusal !== null)
        throw destinationRefusal(refusal);
    if (isProtectedLocation(candidate, homeOf(options)))
        throw destinationRefusal('protected');
}
/**
 * Resolve and check one download destination.
 * @param destination - absolute local folder.
 * @param options - the local user's home, for tests.
 * @returns the resolved folder.
 */
async function requireDestination(destination, options = {}) {
    const refusal = destinationPolicy(destination, options);
    if (refusal !== null)
        throw destinationRefusal(refusal);
    // `destinationPolicy` accepts only a non-empty string path, so by here the unknown is a
    // string; the `as` restates that narrowing instead of adding a second runtime check.
    const base = path.resolve(destination);
    try {
        const info = await stat(base);
        if (!info.isDirectory()) {
            throw errors.invalidInput('destination', {
                zh: '选择的保存位置不是文件夹。',
                en: 'The selected destination is not a folder.',
            });
        }
    }
    catch (error) {
        if (isRemoteGoError(error))
            throw error;
        throw errors.invalidInput('destination', {
            zh: '选择的保存文件夹不存在或不可写。',
            en: 'The selected destination folder does not exist or cannot be written.',
        });
    }
    return base;
}
async function createUniqueFolder(base, name, options = {}) {
    const safeName = safeLocalSegment(name) || 'download';
    for (let index = 1; index <= 999; index += 1) {
        const candidate = path.join(base, index === 1 ? safeName : `${safeName} (${index})`);
        // The root's name comes from the remote tree, so it is judged before anything is created:
        // `~/.config` + a remote folder called `autostart` must fail here, with zero writes.
        assertCandidateAllowed(candidate, options);
        try {
            await mkdir(candidate);
            return candidate;
        }
        catch (error) {
            // Only EEXIST means "this name is taken, try the next suffix"; a thrown value is
            // `unknown`, and the `as` restates the one field this branch reads.
            if (error?.code !== 'EEXIST')
                throw error;
        }
    }
    throw errors.invalidInput('destination', {
        zh: '目标目录里已经有太多同名文件夹，请换一个目录。',
        en: 'The destination already contains too many folders with this name; choose another directory.',
    });
}
async function createUniqueFile(base, name, options = {}) {
    const safeName = safeLocalSegment(name) || 'download';
    const extension = path.extname(safeName);
    const stem = path.basename(safeName, extension) || 'download';
    for (let index = 1; index <= 999; index += 1) {
        const fileName = index === 1 ? safeName : `${stem} (${index})${extension}`;
        const candidate = path.join(base, fileName);
        // The remote names the file: `~` + `.bash_login` is a login script, not a download.
        assertCandidateAllowed(candidate, options);
        try {
            const handle = await open(candidate, 'wx', 0o600);
            await handle.close();
            return candidate;
        }
        catch (error) {
            // Same EEXIST-only contract as the folder name search above.
            if (error?.code !== 'EEXIST')
                throw error;
        }
    }
    throw errors.invalidInput('destination', {
        zh: '目标目录里已经有太多同名文件，请换一个目录。',
        en: 'The destination already contains too many files with this name; choose another directory.',
    });
}
function toDownloadError(error) {
    // `isRemoteGoError` only declares a boolean (it lives in the P1a set); the `as` restates
    // the narrowing its `instanceof` proves at runtime.
    if (isRemoteGoError(error))
        return error;
    return errors.remoteFileUnavailable(undefined, {
        technical: String(error?.message ?? error ?? '').slice(0, 300),
    });
}
/**
 * Stream one remote file into `destination`, creating an auto-renamed local file.
 * @param runtime - connected host runtime.
 * @param remotePath - normalized absolute remote path.
 * @param destination - absolute local directory.
 */
export async function saveHostFile(runtime, remotePath, destination, options = {}) {
    if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
        throw errors.remoteFileUnavailable({
            zh: '这台主机还没有连接，无法读取远端文件。',
            en: 'This host is not connected, so the remote file cannot be read.',
        });
    }
    if (typeof runtime.ssh.saveRemoteFile !== 'function') {
        throw errors.internal('the SSH transport does not support file saves');
    }
    const base = await requireDestination(destination, options);
    const name = remoteFileName(remotePath);
    let localPath = null;
    try {
        localPath = await createUniqueFile(base, name, options);
        const result = await runtime.ssh.saveRemoteFile(remotePath, localPath, options);
        return {
            path: remotePath,
            kind: 'file',
            name: path.basename(localPath),
            destination: localPath,
            totalBytes: Number(result?.size ?? 0),
            files: 1,
        };
    }
    catch (error) {
        if (localPath)
            await rm(localPath, { force: true }).catch(() => { });
        throw toDownloadError(error);
    }
}
/**
 * Copy one remote folder into `destination` as individual local files.
 * @param runtime - connected host runtime.
 * @param remotePath - normalized absolute remote folder path.
 * @param destination - absolute local directory.
 */
export async function saveHostFolder(runtime, remotePath, destination, options = {}) {
    if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
        throw errors.remoteFileUnavailable({
            zh: '这台主机还没有连接，无法读取远端文件夹。',
            en: 'This host is not connected, so the remote folder cannot be read.',
        });
    }
    if (typeof runtime.ssh.saveRemoteTree !== 'function') {
        throw errors.internal('the SSH transport does not support folder saves');
    }
    const base = await requireDestination(destination, options);
    const name = remoteFileName(remotePath);
    let root = null;
    try {
        root = await createUniqueFolder(base, name, options);
        const result = await runtime.ssh.saveRemoteTree(remotePath, root, options);
        return {
            path: remotePath,
            kind: 'folder',
            name,
            destination: result?.destination ?? root,
            totalBytes: Number(result?.totalBytes ?? 0),
            files: Number(result?.totalFiles ?? 0),
            ...(result?.cancelled === true ? { cancelled: true } : {}),
        };
    }
    catch (error) {
        if (root)
            await rm(root, { recursive: true, force: true }).catch(() => { });
        throw toDownloadError(error);
    }
}
export { requireDestination };
