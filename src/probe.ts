/** One read-only remote probe: a single POSIX `sh` script prints `key<TAB>value` lines that become the facts used by
 * the planner, the Node installer and diagnostics. */
import { headTail } from './util.js'
import { errors } from './errors.js'
import { normalizeVersion } from './version.js'
import type { SshPort } from './ssh-port.js'

/** The libc family the remote runs; `unknown` never upgrades to a guess. */
export type RemoteLibc = 'musl' | 'glibc' | 'unknown'
/** What one probe learned about the remote. Every field is either a measured value or an explicit `null`; the planner,
 * the Node installer and diagnostics all read this shape. */
export interface RemoteFacts {
  os: string
  arch: string
  osName: string
  user: string
  home: string
  shell: string
  nodePath: string | null
  nodeVersion: string | null
  npmPath: string | null
  npxPath: string | null
  curlPath: string | null
  wgetPath: string | null
  libc: RemoteLibc
  glibcVersion: string | null
  diskFreeKb: number | null
  sshConnection: boolean
  credentialsFile: boolean
  deepseekKeyEnv: boolean
  providerEnvKeys: string[]
}

export function buildProbeScript(): string {
  return `set -u
echo "os\t$(uname -s 2>/dev/null || echo unknown)"
echo "arch\t$(uname -m 2>/dev/null || echo unknown)"
echo "os_name\t$(sed -n 's/^PRETTY_NAME="\\(.*\\)"$/\\1/p' /etc/os-release 2>/dev/null | head -n 1)"
echo "user\t$(id -un 2>/dev/null || echo unknown)"
echo "home\t$HOME"
echo "shell\t\${SHELL:-unknown}"
NODE_PATH_1="$(command -v node 2>/dev/null || true)"
echo "node_path\t$NODE_PATH_1"
if [ -n "$NODE_PATH_1" ]; then echo "node_version\t$(timeout 10 "$NODE_PATH_1" -v 2>/dev/null || true)"; else echo "node_version\t"; fi
echo "npm_path\t$(command -v npm 2>/dev/null || true)"
echo "npx_path\t$(command -v npx 2>/dev/null || true)"
echo "curl_path\t$(command -v curl 2>/dev/null || true)"
echo "wget_path\t$(command -v wget 2>/dev/null || true)"
if [ -f /etc/alpine-release ]; then
  echo "libc\tmusl"
elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | head -n 1 | grep -qi musl; then
  echo "libc\tmusl"
else
  echo "libc\tglibc"
fi
echo "glibc_version\t$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
echo "disk_free_kb\t$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
if [ -n "\${SSH_CONNECTION:-}" ] || [ -n "\${SSH_TTY:-}" ]; then echo "ssh_connection\tyes"; else echo "ssh_connection\tno"; fi
[ -f "$HOME/.dsh/.credentials.yaml" ] && echo "credentials_file\tyes" || echo "credentials_file\tno"
if [ -n "\${DEEPSEEK_API_KEY:-}" ]; then echo "deepseek_key_env\tyes"; else echo "deepseek_key_env\tno"; fi
echo "provider_env_keys\t$(env 2>/dev/null | sed -n 's/^\\([A-Z0-9_]*\\)_API_KEY=.*/\\1/p' | tr '\\n' ',' | sed 's/,$//')"
`
}

export function parseProbeOutput(stdout: unknown): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t')
    if (tab < 0) continue
    const key = rawLine.slice(0, tab).trim()
    const value = rawLine.slice(tab + 1).trim()
    if (key !== '') values[key] = value
  }
  return values
}

export function toProbeFacts(values: Record<string, string>): RemoteFacts {
  /** A measured number, or `null` when the remote reported nothing usable. */
  const num = (value: string): number | null => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    os: values.os || 'unknown',
    arch: values.arch || 'unknown',
    osName: values.os_name || '',
    user: values.user || '',
    home: values.home || '',
    shell: values.shell || '',
    nodePath: values.node_path || null,
    nodeVersion: values.node_version ? normalizeVersion(values.node_version) : null,
    npmPath: values.npm_path || null,
    npxPath: values.npx_path || null,
    curlPath: values.curl_path || null,
    wgetPath: values.wget_path || null,
    libc: values.libc === 'musl' ? 'musl' : values.libc === 'glibc' ? 'glibc' : 'unknown',
    glibcVersion: values.glibc_version ? String(values.glibc_version).trim() : null,
    diskFreeKb: num(values.disk_free_kb),
    sshConnection: values.ssh_connection === 'yes',
    credentialsFile: values.credentials_file === 'yes',
    deepseekKeyEnv: values.deepseek_key_env === 'yes',
    providerEnvKeys: values.provider_env_keys ? values.provider_env_keys.split(',').filter(Boolean) : [],
  }
}

export async function probeRemote(ssh: SshPort, options: { timeoutMs?: number } = {}): Promise<RemoteFacts> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const result = await ssh.exec(buildProbeScript(), { timeoutMs })
  // A probe that ran out of time says nothing about the remote's DSH: report a retryable timeout, not a
  // missing remote runtime.
  if (result.timedOut === true) {
    throw errors.network(
      {
        zh: `远端环境探测超过 ${Math.round(timeoutMs / 1000)} 秒没有完成，可能是链路很慢或远端负载过高。`,
        en: `The remote environment probe did not finish within ${Math.round(timeoutMs / 1000)}s; the link may be slow or the remote overloaded.`,
      },
      { technical: `reason=probe-timeout timeoutMs=${timeoutMs}` },
    )
  }
  if (result.code !== 0) {
    throw errors.remoteDshMissing({
      zh: `远端环境探测失败（退出码 ${result.code}）：${headTail(result.stderr || result.stdout, 400)}`,
      en: `Remote probe failed (exit ${result.code}): ${headTail(result.stderr || result.stdout, 400)}`,
    })
  }
  return toProbeFacts(parseProbeOutput(result.stdout))
}
