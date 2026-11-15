/**
 * Remote side of a sync: fixed shell templates (never caller-composed) for reading the remote snapshot, writing files over stdin, backing up / restoring the touched files, preparing pnpm and driving `dsh plugin`.
 */
import { normalizeVersion } from './version.js'
import { headTail, shellQuote } from './util.js'

const MARKER_PREFIX = '@@dsh-remote-go:'
const MARKER_SUFFIX = '@@'

/** The remote files a sync reads before planning. Paths are relative to the DSH home. */
export function snapshotFiles(profile) {
  return [
    `profiles/${profile}/package.json`,
    `profiles/${profile}/cordis.patch.yml`,
    '.credentials.yaml',
    'remote-go/sync/state.json',
    `profiles/${profile}/pnpm-workspace.yaml`,
  ]
}

/** The remote files a sync may rewrite; the backup/restore pair covers the same set. */
export function mutableFiles(profile) {
  return [
    `profiles/${profile}/package.json`,
    `profiles/${profile}/cordis.patch.yml`,
    `profiles/${profile}/pnpm-lock.yaml`,
    `profiles/${profile}/pnpm-workspace.yaml`,
    '.credentials.yaml',
  ]
}

export function buildSnapshotCommand({ home, files }) {
  const lines = ['set -u']
  for (const file of files) {
    lines.push(`printf '%s\\n' ${shellQuote(`${MARKER_PREFIX}${file}${MARKER_SUFFIX}`)}`)
    // The trailing newline keeps the next marker on its own line even when the
    // file does not end with one.
    lines.push(`cat ${shellQuote(`${home}/${file}`)} 2>/dev/null || true`)
    lines.push(`printf '\\n'`)
  }
  return lines.join('\n')
}

/** Split the snapshot output back into one string per requested file. */
export function parseSnapshotOutput(stdout, files) {
  const texts = new Map()
  let current = null
  let buffer = []
  const flush = () => {
    // Drop only the separator newline the command adds after each file.
    if (current !== null) texts.set(current, buffer.join('\n').replace(/\n$/, ''))
    buffer = []
  }
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX)) {
      flush()
      current = line.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length)
      continue
    }
    if (current !== null) buffer.push(line)
  }
  flush()
  const out = {}
  for (const file of files) out[file] = texts.get(file) ?? ''
  return out
}

export function buildWriteFileCommand(file, mode = '600') {
  const target = shellQuote(file)
  return `set -eu
TARGET=${target}
TMP="$TARGET.tmp.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
mkdir -p "$(dirname "$TARGET")"
cat > "$TMP"
chmod ${mode} "$TMP"
mv "$TMP" "$TARGET"
echo WROTE
`
}

export function buildBackupCommand({ home, files, archive }) {
  const list = files.map((file) => shellQuote(file)).join(' ')
  return `set -eu
ARCHIVE=${shellQuote(archive)}
mkdir -p "$(dirname "$ARCHIVE")"
LIST="$ARCHIVE.list"
: > "$LIST"
for REL in ${list}; do
  if [ -f ${shellQuote(home)}/"$REL" ]; then printf '%s\\n' "$REL" >> "$LIST"; fi
done
tar -czf "$ARCHIVE" -C ${shellQuote(home)} -T "$LIST"
rm -f "$LIST"
echo BACKED-UP
`
}

export function buildRestoreCommand({ home, archive }) {
  return `set -eu
ARCHIVE=${shellQuote(archive)}
if [ ! -f "$ARCHIVE" ]; then echo NO-BACKUP; exit 0; fi
tar -xzf "$ARCHIVE" -C ${shellQuote(home)}
echo RESTORED
`
}

export function buildMkdirCommand(dir) {
  return `mkdir -p ${shellQuote(dir)} && echo OK`
}

/** pnpm is not part of the managed Node; install it once under the plugin's state directory. */
export function buildEnsurePnpmCommand({ npmPath, nodeBinDir, dir, version, shimDir }) {
  const path = nodeBinDir ? `PATH=${shellQuote(nodeBinDir)}:"$PATH" ` : ''
  return `set -eu
DIR=${shellQuote(dir)}
NPM=${shellQuote(npmPath)}
SHIMDIR=${shellQuote(shimDir)}
VER=${shellQuote(version)}
mkdir -p "$DIR" "$SHIMDIR"
if [ ! -x "$DIR/node_modules/.bin/pnpm" ]; then
  ${path}"$NPM" install --no-audit --no-fund --ignore-scripts --loglevel=error --prefix "$DIR" "pnpm@$VER" >/dev/null 2>&1 || { echo PNPM-FAILED; exit 3; }
fi
if [ ! -x "$DIR/node_modules/.bin/pnpm" ]; then echo PNPM-MISSING; exit 4; fi
cat > "$SHIMDIR/pnpm" <<SHIM
#!/bin/sh
exec "$DIR/node_modules/.bin/pnpm" "\\$@"
SHIM
chmod 755 "$SHIMDIR/pnpm"
echo PNPM-READY
`
}

function managedPath(nodeBinDir, shimDir) {
  const parts = [nodeBinDir, shimDir].filter((value) => typeof value === 'string' && value !== '')
  return `${parts.map((value) => shellQuote(value)).join(':')}:"$PATH"`
}

export function buildPluginAddCommand({ home, profile, spec, dshVersion, npxPath, nodeBinDir, shimDir }) {
  const path = managedPath(nodeBinDir, shimDir)
  return `env DSH_HOME=${shellQuote(home)} PATH=${path} ${shellQuote(npxPath)} -y @deepseek-ai/dsh@${normalizeVersion(dshVersion)} plugin --profile ${shellQuote(profile)} add ${shellQuote(spec)}`
}

export function buildDumpConfigCommand({ home, profile, dshVersion, npxPath, nodeBinDir }) {
  const path = managedPath(nodeBinDir, '')
  return `env DSH_HOME=${shellQuote(home)} PATH=${path} ${shellQuote(npxPath)} -y @deepseek-ai/dsh@${normalizeVersion(dshVersion)} --profile ${shellQuote(profile)} --dump-config`
}

/** One line per installed package; used to prove the remote node_modules has them. */
export function buildPackageCheckCommand({ profileDir, names }) {
  const lines = ['set -u']
  for (const name of names) {
    const file = `${profileDir}/node_modules/${name}/package.json`
    lines.push(`if [ -f ${shellQuote(file)} ]; then echo "OK ${name}"; else echo "MISSING ${name}"; fi`)
  }
  return lines.join('\n')
}

export async function writeRemoteFile(ssh, file, text, options = {}) {
  const result = await ssh.exec(buildWriteFileCommand(file, options.mode ?? '600'), {
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBytes: 20_000,
    stdin: String(text ?? ''),
  })
  if (result.code !== 0 || !String(result.stdout).includes('WROTE')) {
    throw new Error(`writing ${file} failed: ${headTail(result.stderr || result.stdout, 400)}`)
  }
}

export async function readRemoteFile(ssh, file, options = {}) {
  const result = await ssh.exec(`cat ${shellQuote(file)} 2>/dev/null || true`, {
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 512 * 1024,
  })
  return String(result.stdout ?? '')
}

export async function runRemote(ssh, command, options = {}) {
  return ssh.exec(command, {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxBytes: options.maxBytes ?? 512 * 1024,
  })
}
