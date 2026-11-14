/**
 * One read-only remote probe (design §4.2 step 2–3, §16.2): a single POSIX `sh`
 * script prints `key<TAB>value` lines that this module turns into facts used by
 * the runtime planner, the managed-Node installer, the wizard's capability list
 * and diagnostics.
 *
 * Deliberately small now that the runtime is always npx-pinned: the probe only
 * needs to prove what the remote has (Node, npm/npx, curl/wget, libc, home) so
 * the plugin knows whether it has to provision a managed Node itself.
 */
import { headTail } from './util.js'
import { errors } from './errors.js'
import { normalizeVersion, isNodeVersionSupported } from './version.js'

/**
 * @typedef {{
 *   os: string, arch: string, osName: string, user: string, home: string, shell: string,
 *   nodePath: string | null, nodeVersion: string | null,
 *   npmPath: string | null, npxPath: string | null,
 *   curlPath: string | null, wgetPath: string | null,
 *   libc: 'glibc' | 'musl' | 'unknown', glibcVersion: string | null,
 *   diskFreeKb: number | null,
 *   sshConnection: boolean,
 *   credentialsFile: boolean, deepseekKeyEnv: boolean, providerEnvKeys: string[],
 * }} ProbeFacts
 */

/**
 * @returns {string}
 */
export function buildProbeScript() {
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

/**
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
export function parseProbeOutput(stdout) {
  /** @type {Record<string, string>} */
  const values = {}
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t')
    if (tab < 0) continue
    const key = rawLine.slice(0, tab).trim()
    const value = rawLine.slice(tab + 1).trim()
    if (key !== '') values[key] = value
  }
  return values
}

/**
 * @param {Record<string, string>} values
 * @returns {ProbeFacts}
 */
export function toProbeFacts(values) {
  const num = (/** @type {string} */ value) => {
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

/**
 * Run the probe against one SSH connection.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<ProbeFacts>}
 */
export async function probeRemote(ssh, options = {}) {
  const script = buildProbeScript()
  const result = await ssh.exec(script, { timeoutMs: options.timeoutMs ?? 60_000 })
  if (result.code !== 0) {
    throw errors.remoteDshMissing({
      zh: `远端环境探测失败（退出码 ${result.code}）：${headTail(result.stderr || result.stdout, 400)}`,
      en: `Remote probe failed (exit ${result.code}): ${headTail(result.stderr || result.stdout, 400)}`,
    })
  }
  return toProbeFacts(parseProbeOutput(result.stdout))
}

/**
 * Capability summary for the wizard and diagnostics.
 * @param {ProbeFacts} facts
 */
export function describeProbeCapabilities(facts) {
  return {
    system: {
      os: facts.os,
      arch: facts.arch,
      name: facts.osName || `${facts.os} ${facts.arch}`,
      supported: facts.os === 'Linux',
    },
    node: {
      version: facts.nodeVersion,
      supported: isNodeVersionSupported(facts.nodeVersion),
      path: facts.nodePath,
    },
    npx: {
      path: facts.npxPath,
      available: Boolean(facts.npxPath),
    },
    network: {
      curl: Boolean(facts.curlPath),
      wget: Boolean(facts.wgetPath),
    },
    libc: facts.libc,
    glibcVersion: facts.glibcVersion,
    modelCredentials: {
      credentialsFile: facts.credentialsFile,
      deepseekKeyEnv: facts.deepseekKeyEnv,
      providerKeys: facts.providerEnvKeys,
    },
    sshSession: facts.sshConnection,
    diskFreeKb: facts.diskFreeKb,
  }
}
