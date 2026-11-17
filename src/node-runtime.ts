/**
 * The plugin's own Node.js runtime on the remote: an official build, SHA-256 verified, under `$DSH_HOME/remote-go/node`; commands are fixed templates, never user-composed.
 */
import { errors } from './errors.js'
import type { RemoteGoError } from './errors.js'
import type { BilingualText } from './util.js'
import { headTail, messageOf, shellQuote } from './util.js'
import { MIN_NODE_VERSION, normalizeVersion, parseVersion } from './version.js'
import type { RemoteFacts } from './probe.js'
import type { RemoteLayout } from './layout.js'
import type { SshExecOptions, SshTransport } from './ssh.js'

export const NODE_DIST_BASES: readonly string[] = Object.freeze([
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
])

export const MANAGED_NODE_VERSION_FALLBACK = MIN_NODE_VERSION

/** One managed Node installation the scan found under `nodeDir`. */
export interface NodeInstallation {
  version: string
  dir: string
}

/** One verified release: where the checksum came from and what the tarball must hash to. */
export interface NodeRelease {
  base: string
  version: string
  sha256: string
  file: string
}

/** What the installer reports while it works; the connect progress line renders it. */
export interface NodeInstallEvent {
  step: string
  version: string
  bytes?: number
  source?: string
}

/** The managed runtime `ensureRemoteNode` resolves to. */
export interface ManagedNode {
  managed: true
  version: string
  nodePath: string
  npmPath: string
  npxPath: string
  nodeBinDir: string
  installed: boolean
}

/** A failed resolution/install: the typed reason plus the technical detail to report. */
export type NodeSetupFailure = { ok: false; reason: string; technical?: string }

export function managedNodeVersionFromEngine(range: unknown, fallback: string = MANAGED_NODE_VERSION_FALLBACK): string {
  const text = String(range ?? '').trim()
  if (text === '') return normalizeVersion(fallback)
  const first = text.split('||')[0].trim()
  if (first === '' || first === '*' || first === 'latest') return normalizeVersion(fallback)
  // A strict `>` needs the next patch; `>=`, `^`, `~`, `=` and a bare version all
  // mean that version itself.
  const strict = /^>\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(first)
  if (strict && !first.startsWith('>=')) {
    return normalizeVersion(`${Number(strict[1])}.${Number(strict[2] ?? 0)}.${Number(strict[3] ?? 0) + 1}`)
  }
  const match = /(?:>=|\^|~|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(first)
  if (!match) return normalizeVersion(fallback)
  return normalizeVersion(`${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0)}`)
}

const NODE_SCAN_TIMEOUT_MS = 30_000
const NODE_CHECKSUM_TIMEOUT_MS = 240_000
const NODE_INSTALL_TIMEOUT_MS = 30 * 60_000

const NODE_MIN_FREE_KB = 400 * 1024

const NODE_MIN_GLIBC = '2.28'

const DIST_ARCH = new Map<string, string>([
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  ['aarch64', 'arm64'],
  ['arm64', 'arm64'],
  ['armv7l', 'armv7l'],
  ['armv7', 'armv7l'],
  ['ppc64le', 'ppc64le'],
  ['s390x', 's390x'],
])

/**
 * Pick the downloader both install scripts share: curl when present, else wget.
 * Exit 9 is the "neither tool" contract the caller maps to `no-fetch`.
 */
const FETCH_PROLOGUE = `if command -v curl >/dev/null 2>&1; then
  FETCH=curl
elif command -v wget >/dev/null 2>&1; then
  FETCH=wget
else
  printf 'FAILED\\tno-fetch\\n'
  exit 9
fi`

export function nodeDistArch(arch: unknown): string | null {
  return DIST_ARCH.get(String(arch ?? '').toLowerCase()) ?? null
}

function compareGlibc(left: unknown, right: unknown): number {
  const a = String(left ?? '').split('.')
  const b = String(right ?? '').split('.')
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(a[index] ?? '0', 10)
    const y = Number.parseInt(b[index] ?? '0', 10)
    const leftValue = Number.isFinite(x) ? x : 0
    const rightValue = Number.isFinite(y) ? y : 0
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
  }
  return 0
}

export function buildNodeScanScript(layout: RemoteLayout): string {
  return `set -u
NODE_DIR=${shellQuote(layout.nodeDir)}
if [ -d "$NODE_DIR" ]; then
  for DIR in "$NODE_DIR"/*; do
    [ -d "$DIR" ] || continue
    [ -x "$DIR/bin/node" ] || continue
    [ -x "$DIR/bin/npx" ] || continue
    VER=$("$DIR/bin/node" -v 2>/dev/null || true)
    case "$VER" in
      v[0-9]*) printf 'NODE\\t%s\\t%s\\n' "\${VER#v}" "$DIR" ;;
    esac
  done
fi
`
}

export function parseNodeScanOutput(stdout: unknown): NodeInstallation[] {
  const versions: NodeInstallation[] = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const parts = rawLine.split('\t')
    if (parts[0] !== 'NODE' || parts.length < 3) continue
    const version = normalizeVersion(parts[1])
    if (!parseVersion(version)) continue
    if (versions.some((entry) => entry.version === version)) continue
    versions.push({ version, dir: parts[2] })
  }
  return versions
}

/** What the checksum script needs: where to cache, which version/arch, which mirrors. */
export interface NodeChecksumInput {
  downloadDir: string
  version: string
  arch: string
  bases?: readonly string[]
}

export function buildNodeChecksumScript(input: NodeChecksumInput): string {
  const bases = (input.bases ?? NODE_DIST_BASES).map((base) => shellQuote(base)).join(' ')
  return `set -u
DL=${shellQuote(input.downloadDir)}
VERSION=${shellQuote(input.version)}
FILE="node-v$VERSION-linux-${input.arch}.tar.gz"
mkdir -p "$DL" || exit 3
${FETCH_PROLOGUE}
fetch() {
  URL=$1
  OUT=$2
  if [ "$FETCH" = curl ]; then
    curl -fsSL --connect-timeout 10 --max-time 60 -o "$OUT" "$URL" 2>/dev/null
  else
    wget -q -T 30 -t 1 -O "$OUT" "$URL" 2>/dev/null
  fi
}
for BASE in ${bases}; do
  TMP="$DL/.shasums.$$"
  if fetch "$BASE/v$VERSION/SHASUMS256.txt" "$TMP"; then
    LINE=$(grep -F "  $FILE" "$TMP" | head -n 1 || true)
    if [ -n "$LINE" ]; then
      SHA=$(printf '%s\\n' "$LINE" | awk '{print $1}')
      if [ "\${#SHA}" -eq 64 ]; then
        printf 'CHECKSUM\\t%s\\t%s\\n' "$BASE" "$SHA"
        rm -f "$TMP"
        exit 0
      fi
    fi
  fi
  rm -f "$TMP"
done
exit 5
`
}

export function parseNodeChecksumOutput(
  stdout: unknown,
  input: { version: string; arch: string; bases?: readonly string[] },
): NodeRelease | null {
  const file = `node-v${input.version}-linux-${input.arch}.tar.gz`
  const allowed = input.bases ?? NODE_DIST_BASES
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const parts = rawLine.split('\t')
    if (parts[0] !== 'CHECKSUM' || parts.length < 3) continue
    const [, base, sha256] = parts
    if (!allowed.includes(base)) continue
    if (!/^[0-9a-f]{64}$/.test(sha256)) continue
    return { base, version: input.version, sha256, file }
  }
  return null
}

/** What the install script needs: the layout, the verified release and the mirrors to try. */
export interface NodeInstallInput {
  layout: RemoteLayout
  release: NodeRelease
  bases?: readonly string[]
}

export function buildNodeInstallScript(input: NodeInstallInput): string {
  const bases = (input.bases ?? NODE_DIST_BASES).map((base) => shellQuote(base)).join(' ')
  const { release } = input
  return `set -eu
NODE_DIR=${shellQuote(input.layout.nodeDir)}
DL=${shellQuote(input.layout.downloadDir)}
VERSION=${shellQuote(release.version)}
SHA=${shellQuote(release.sha256)}
FILE=${shellQuote(release.file)}
BINDIR="$NODE_DIR/v$VERSION"
mkdir -p "$NODE_DIR" "$DL" || exit 3
if [ -x "$BINDIR/bin/node" ] && [ "$("$BINDIR/bin/node" -v 2>/dev/null || true)" = "v$VERSION" ]; then
  printf 'READY\\t%s\\n' "$BINDIR"
  exit 0
fi
${FETCH_PROLOGUE}
verify() {
  TARGET=$1
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$SHA" "$TARGET" | sha256sum -c - >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$SHA" "$TARGET" | shasum -a 256 -c - >/dev/null 2>&1
  elif command -v openssl >/dev/null 2>&1; then
    GOT=$(openssl dgst -sha256 "$TARGET" 2>/dev/null | sed 's/.*= //')
    [ "$GOT" = "$SHA" ]
  else
    return 127
  fi
}
TARBALL="$DL/$FILE"
if [ -f "$TARBALL" ] && verify "$TARBALL"; then
  echo "STEP\\treuse"
else
  OK=0
  for BASE in ${bases}; do
    PART="$TARBALL.part.$$"
    rm -f "$PART"
    printf 'STEP\\tdownload\\t%s\\n' "$BASE"
    if [ "$FETCH" = curl ]; then
      curl -fsSL --connect-timeout 15 --max-time 600 -o "$PART" "$BASE/v$VERSION/$FILE" &
    else
      wget -q -T 60 -t 3 -O "$PART" "$BASE/v$VERSION/$FILE" &
    fi
    PID=$!
    while kill -0 "$PID" 2>/dev/null; do
      printf 'BYTES\\t%s\\n' "$(wc -c < "$PART" 2>/dev/null || echo 0)"
      sleep 2
    done
    if wait "$PID" && verify "$PART"; then
      mv "$PART" "$TARBALL"
      OK=1
      break
    fi
    printf 'FAILED\\tchecksum\\t%s\\n' "$BASE"
    rm -f "$PART"
  done
  if [ "$OK" -ne 1 ]; then
    echo "FAILED\\tdownload"
    exit 6
  fi
fi
echo "STEP\\textract"
TMPX="$NODE_DIR/.extract.$$"
rm -rf "$TMPX"
mkdir -p "$TMPX"
if ! tar -xzf "$TARBALL" -C "$TMPX" --strip-components=1; then
  echo "FAILED\\textract"
  rm -rf "$TMPX"
  exit 7
fi
if [ ! -x "$TMPX/bin/node" ]; then
  echo "FAILED\\textract"
  rm -rf "$TMPX"
  exit 7
fi
GOT=$("$TMPX/bin/node" -v 2>/dev/null || true)
if [ "$GOT" != "v$VERSION" ]; then
  echo "FAILED\\tverify"
  rm -rf "$TMPX"
  exit 8
fi
rm -rf "$BINDIR"
mv "$TMPX" "$BINDIR"
rm -f "$TARBALL"
for OLD in "$NODE_DIR"/v*; do
  [ -d "$OLD" ] || continue
  [ "$OLD" = "$BINDIR" ] && continue
  rm -rf "$OLD"
done
printf 'READY\\t%s\\n' "$BINDIR"
`
}

function technicalOf(error: unknown): string {
  return messageOf(error ?? '')
}

function nodeError(detail: BilingualText, technical?: string): RemoteGoError {
  return errors.nodeInstallFailed(detail, technical ? { technical } : undefined)
}

/** Run one remote command and normalize whatever shape the transport returned. */
async function runRemote(
  ssh: SshTransport,
  command: string,
  options: SshExecOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await ssh.exec(command, options)
  return {
    code: typeof result?.code === 'number' ? result.code : 0,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  }
}

async function scanManagedNode(ssh: SshTransport, layout: RemoteLayout): Promise<NodeInstallation[]> {
  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runRemote(ssh, buildNodeScanScript(layout), {
      timeoutMs: NODE_SCAN_TIMEOUT_MS,
      maxBytes: 200_000,
    })
  } catch (error) {
    throw nodeError(
      { zh: '无法检查远端托管的 Node。', en: 'Could not inspect the managed Node on the remote.' },
      technicalOf(error),
    )
  }
  if (result.code !== 0) {
    throw nodeError(
      {
        zh: `无法检查远端托管的 Node（退出码 ${result.code}）。`,
        en: `Could not inspect the managed Node on the remote (exit ${result.code}).`,
      },
      headTail(result.stderr || result.stdout, 800),
    )
  }
  return parseNodeScanOutput(result.stdout)
}

async function resolveNodeRelease(
  ssh: SshTransport,
  input: { layout: RemoteLayout; version: string; arch: string; bases?: readonly string[] },
): Promise<{ ok: true; release: NodeRelease } | NodeSetupFailure> {
  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runRemote(
      ssh,
      buildNodeChecksumScript({
        downloadDir: input.layout.downloadDir,
        version: input.version,
        arch: input.arch,
        bases: input.bases,
      }),
      { timeoutMs: NODE_CHECKSUM_TIMEOUT_MS, maxBytes: 200_000 },
    )
  } catch (error) {
    // swallow-ok: unreachable — a transport failure is reported as a typed resolution
    // reason; the caller turns it into the install error.
    return { ok: false, reason: 'unreachable', technical: technicalOf(error) }
  }
  if (result.code === 0) {
    const release = parseNodeChecksumOutput(result.stdout, {
      version: input.version,
      arch: input.arch,
      bases: input.bases,
    })
    if (release) return { ok: true, release }
    return { ok: false, reason: 'no-checksum', technical: headTail(result.stdout, 600) }
  }
  if (result.code === 9 || result.stdout.includes('FAILED\tno-fetch')) {
    return { ok: false, reason: 'no-fetch' }
  }
  if (result.code === 5) {
    return { ok: false, reason: 'unreachable', technical: headTail(result.stderr || result.stdout, 600) }
  }
  return { ok: false, reason: 'unreachable', technical: headTail(`${result.stdout}\n${result.stderr}`, 600) }
}

async function installNodeRelease(
  ssh: SshTransport,
  input: {
    layout: RemoteLayout
    release: NodeRelease
    bases?: readonly string[]
    onProgress: (event: NodeInstallEvent) => void
  },
): Promise<{ ok: true; dir: string } | NodeSetupFailure> {
  const expectedDir = `${input.layout.nodeDir}/v${input.release.version}`
  let buffered = ''
  let dir: string | null = null
  let failure: string | null = null
  let lastBytes = -1
  let lastEmit = 0
  const handleLine = (line: string): void => {
    if (line === '') return
    const parts = line.split('\t')
    if (parts[0] === 'BYTES') {
      const bytes = Number(parts[1])
      if (!Number.isFinite(bytes) || bytes < 0) return
      const now = Date.now()
      if (bytes - lastBytes < 8 * 1024 * 1024 && now - lastEmit < 5000 && bytes !== 0) return
      lastBytes = bytes
      lastEmit = now
      input.onProgress({ step: 'download', version: input.release.version, bytes })
      return
    }
    if (parts[0] === 'STEP' && parts[1] === 'download') {
      input.onProgress({ step: 'download', version: input.release.version, bytes: 0, source: parts[2] })
      return
    }
    if (parts[0] === 'STEP' && parts[1] === 'extract') {
      input.onProgress({ step: 'extract', version: input.release.version })
      return
    }
    if (parts[0] === 'READY') {
      dir = parts[1] ?? null
      return
    }
    if (parts[0] === 'FAILED') {
      failure = parts.slice(1).filter(Boolean).join(' ') || 'failed'
    }
  }
  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runRemote(
      ssh,
      buildNodeInstallScript({ layout: input.layout, release: input.release, bases: input.bases }),
      {
        timeoutMs: NODE_INSTALL_TIMEOUT_MS,
        maxBytes: 400_000,
        onStdout: (chunk) => {
          buffered += String(chunk ?? '')
          const lines = buffered.split('\n')
          buffered = lines.pop() ?? ''
          for (const piece of lines) handleLine(piece.replace(/\r$/, ''))
        },
      },
    )
  } catch (error) {
    // swallow-ok: unreachable — same contract as the checksum step: the caller turns
    // it into the install error with the technical detail.
    return { ok: false, reason: 'unreachable', technical: technicalOf(error) }
  }
  if (result.code !== 0 || !dir) {
    return {
      ok: false,
      reason: failure ?? `exit ${result.code}`,
      technical: headTail(`${result.stdout}\n${result.stderr}`, 800),
    }
  }
  if (dir !== expectedDir) {
    return { ok: false, reason: 'unexpected-location', technical: dir }
  }
  return { ok: true, dir }
}

/** What `ensureRemoteNode` needs: the probed facts, the layout and the version to install. */
export interface EnsureRemoteNodeOptions {
  facts?: Partial<RemoteFacts>
  layout: RemoteLayout
  version?: unknown
  bases?: readonly string[]
  onProgress?: (event: NodeInstallEvent) => void
}

export async function ensureRemoteNode(ssh: SshTransport, options: EnsureRemoteNodeOptions): Promise<ManagedNode> {
  const facts = options.facts ?? {}
  const layout = options.layout
  const version = normalizeVersion(options.version ?? MANAGED_NODE_VERSION_FALLBACK)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  if (!layout?.nodeDir || !layout?.downloadDir) {
    throw errors.internal('remote layout is missing the managed Node directories')
  }
  if (!parseVersion(version)) throw errors.internal(`invalid managed Node version: ${version}`)
  if (!facts.home || !String(layout.nodeDir).startsWith('/')) {
    throw nodeError({
      zh: '远端主目录未知，无法准备托管的 Node。',
      en: 'The remote home directory is unknown, so the managed Node cannot be prepared.',
    })
  }
  if (String(facts.os ?? '') !== 'Linux') {
    // The official builds this module installs are Linux-only; refusing here keeps a
    // Darwin/Windows remote from downloading a binary that could never run.
    throw errors.unsupportedOs(`${facts.os ?? 'unknown'} ${facts.arch ?? ''}`.trim())
  }
  if (facts.libc === 'glibc' && facts.glibcVersion && compareGlibc(facts.glibcVersion, NODE_MIN_GLIBC) < 0) {
    throw nodeError({
      zh: `远端 glibc ${facts.glibcVersion} 过低，Node 官方 Linux 构建需要 ≥ ${NODE_MIN_GLIBC}。请升级系统后重试。`,
      en: `The remote glibc is ${facts.glibcVersion}, but the official Node Linux build needs >= ${NODE_MIN_GLIBC}. Upgrade the system and retry.`,
    })
  }
  if (facts.libc === 'musl') {
    throw nodeError({
      zh: '远端使用 musl libc（如 Alpine），Node 官方构建无法运行；插件只使用自己的 Node，请换用 glibc 系统（如 Ubuntu/Debian）。',
      en: 'The remote uses musl libc (for example Alpine), where the official Node build cannot run; the plugin only uses its own Node, so use a glibc system (such as Ubuntu/Debian).',
    })
  }
  const arch = nodeDistArch(facts.arch)
  if (!arch) {
    throw nodeError({
      zh: `远端架构「${facts.arch}」没有对应的 Node 官方构建。插件只使用自己的 Node，请换一台受支持的架构。`,
      en: `No official Node build exists for the remote architecture "${facts.arch}". The plugin only uses its own Node, so use a supported architecture.`,
    })
  }
  if (typeof facts.diskFreeKb === 'number' && facts.diskFreeKb > 0 && facts.diskFreeKb < NODE_MIN_FREE_KB) {
    throw nodeError({
      zh: `远端磁盘空间不足（可用约 ${Math.round(facts.diskFreeKb / 1024)} MB，至少需要 ${Math.round(NODE_MIN_FREE_KB / 1024)} MB）。`,
      en: `The remote has too little free space (about ${Math.round(facts.diskFreeKb / 1024)} MB; at least ${Math.round(NODE_MIN_FREE_KB / 1024)} MB is required).`,
    })
  }

  onProgress({ step: 'check', version })
  const installed = await scanManagedNode(ssh, layout)
  let current: NodeInstallation | null = installed.find((entry) => entry.version === version) ?? null
  let installedNow = false
  if (!current) {
    onProgress({ step: 'checksum', version })
    const resolved = await resolveNodeRelease(ssh, {
      layout,
      version,
      arch,
      bases: options.bases,
    })
    if (resolved.ok === false) {
      throw nodeError(resolveFailureDetail(resolved.reason, version), resolved.technical ?? `reason=${resolved.reason}`)
    }
    onProgress({ step: 'install', version })
    const install = await installNodeRelease(ssh, {
      layout,
      release: resolved.release,
      bases: options.bases,
      onProgress,
    })
    if (install.ok === false) {
      throw nodeError(
        {
          zh: `自动安装 Node ${version} 失败（${install.reason}）。`,
          en: `Automatically installing Node ${version} failed (${install.reason}).`,
        },
        install.technical,
      )
    }
    current = { version, dir: install.dir }
    installedNow = true
  }
  onProgress({ step: 'ready', version })
  const nodeBinDir = `${current.dir}/bin`
  return {
    managed: true,
    version: current.version,
    nodePath: `${nodeBinDir}/node`,
    npmPath: `${nodeBinDir}/npm`,
    npxPath: `${nodeBinDir}/npx`,
    nodeBinDir,
    installed: installedNow,
  }
}

function resolveFailureDetail(reason: string, version: string): BilingualText {
  if (reason === 'no-fetch') {
    return {
      zh: '远端既没有 curl 也没有 wget，无法下载 Node。请安装其中一个后重试。',
      en: 'The remote has neither curl nor wget, so Node cannot be downloaded. Install one of them and retry.',
    }
  }
  if (reason === 'no-checksum') {
    return {
      zh: `没有在 Node 官方索引里找到 v${version} 的 linux 构建校验和。`,
      en: `No linux build checksum was found in the official Node index for v${version}.`,
    }
  }
  return {
    zh: '无法从 nodejs.org / npmmirror.com 下载 Node（远端网络不可达或被拦截）。',
    en: 'Node could not be downloaded from nodejs.org / npmmirror.com (the remote network is unreachable or blocked).',
  }
}

export function applyManagedNodeFacts(
  facts: Partial<RemoteFacts>,
  managed: ManagedNode,
): Partial<RemoteFacts> & { nodeBinDir: string } {
  return {
    ...facts,
    nodePath: managed.nodePath,
    nodeBinDir: managed.nodeBinDir,
    nodeVersion: normalizeVersion(managed.version),
    npmPath: managed.npmPath ?? facts.npmPath,
    npxPath: managed.npxPath,
  }
}
