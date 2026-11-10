/**
 * One read-only remote probe (design §4.2 step 2–3, §16.2): a single POSIX `sh`
 * script prints `key<TAB>value` lines that this module turns into facts used by
 * both the wizard's capability list and the bootstrap planner.
 */
import { headTail, shellQuote } from './util.js'
import { errors } from './errors.js'
import { normalizeVersion, isNodeVersionSupported } from './version.js'

/**
 * @typedef {{
 *   os: string, arch: string, osName: string, user: string, home: string, shell: string,
 *   nodePath: string | null, nodeVersion: string | null,
 *   npmPath: string | null, npmVersion: string | null, npxPath: string | null,
 *   dshPath: string | null, dshVersion: string | null,
 *   curlPath: string | null, tarPath: string | null, sha256Path: string | null,
 *   diskFreeKb: number | null,
 *   sshConnection: boolean,
 *   isolatedNodePath: string | null, isolatedNodeVersion: string | null,
 *   isolatedDshVersion: string | null, isolatedDshBinPath: string | null,
 *   credentialsFile: boolean, deepseekKeyEnv: boolean, providerEnvKeys: string[],
 *   runRegistry: Record<string, unknown> | null,
 *   remoteDirExists: boolean, homeExists: boolean,
 * }} ProbeFacts
 */

/**
 * @param {string} remoteDir
 */
export function buildProbeScript(remoteDir) {
  const dir = shellQuote(remoteDir)
  return `set -u
DIR=${dir}
case "$DIR" in
  "~") DIR="$HOME" ;;
  "~/"*) DIR="$HOME/\${DIR#\\~/}" ;;
esac
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
if [ -n "$(command -v npm 2>/dev/null || true)" ]; then echo "npm_version\t$(timeout 10 npm -v 2>/dev/null || true)"; else echo "npm_version\t"; fi
echo "npx_path\t$(command -v npx 2>/dev/null || true)"
DSH_PATH_1="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSH_PATH_1" ]; then
  for candidate in "$HOME/.local/bin/dsh" "$HOME/.npm-global/bin/dsh" "/usr/local/bin/dsh" "$HOME/.local/share/pnpm/dsh"; do
    if [ -x "$candidate" ]; then DSH_PATH_1="$candidate"; break; fi
  done
fi
if [ -z "$DSH_PATH_1" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/.local/share/fnm/node-versions/*/installation/bin/dsh; do
    if [ -x "$candidate" ]; then DSH_PATH_1="$candidate"; break; fi
  done
fi
echo "dsh_path\t$DSH_PATH_1"
if [ -n "$DSH_PATH_1" ]; then echo "dsh_version\t$(timeout 20 "$DSH_PATH_1" --version 2>/dev/null | head -n 1 || true)"; else echo "dsh_version\t"; fi
echo "curl_path\t$(command -v curl 2>/dev/null || true)"
echo "tar_path\t$(command -v tar 2>/dev/null || true)"
echo "sha256_path\t$(command -v sha256sum 2>/dev/null || true)"
echo "disk_free_kb\t$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
if [ -n "\${SSH_CONNECTION:-}" ] || [ -n "\${SSH_TTY:-}" ]; then echo "ssh_connection\tyes"; else echo "ssh_connection\tno"; fi
ISO_NODE="$DIR/node/bin/node"
echo "isolated_node_path\t$([ -x "$ISO_NODE" ] && echo "$ISO_NODE" || true)"
echo "isolated_node_version\t$([ -x "$ISO_NODE" ] && timeout 10 "$ISO_NODE" -v 2>/dev/null || true)"
ISO_DSH="$DIR/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
ISO_DSH_PKG="$DIR/dsh-home/node_modules/@deepseek-ai/dsh/package.json"
echo "isolated_dsh_bin_path\t$([ -f "$ISO_DSH" ] && echo "$ISO_DSH" || true)"
if [ -f "$ISO_DSH_PKG" ] && [ -x "$ISO_NODE" ]; then
  echo "isolated_dsh_version\t$(timeout 10 "$ISO_NODE" -p "require('$ISO_DSH_PKG').version" 2>/dev/null || true)"
else
  echo "isolated_dsh_version\t"
fi
[ -d "$DIR" ] && echo "remote_dir_exists\tyes" || echo "remote_dir_exists\tno"
[ -d "$HOME/.dsh" ] && echo "home_exists\tyes" || echo "home_exists\tno"
[ -f "$HOME/.dsh/.credentials.yaml" ] && echo "credentials_file\tyes" || echo "credentials_file\tno"
if [ -n "\${DEEPSEEK_API_KEY:-}" ]; then echo "deepseek_key_env\tyes"; else echo "deepseek_key_env\tno"; fi
echo "provider_env_keys\t$(env 2>/dev/null | sed -n 's/^\\([A-Z0-9_]*\\)_API_KEY=.*/\\1/p' | tr '\\n' ',' | sed 's/,$//')"
if [ -f "$DIR/run/web.json" ]; then echo "run_registry\t$(head -c 2000 "$DIR/run/web.json" 2>/dev/null | tr '\\n' ' ')"; else echo "run_registry\t"; fi
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
    npmVersion: values.npm_version ? normalizeVersion(values.npm_version) : null,
    npxPath: values.npx_path || null,
    dshPath: values.dsh_path || null,
    dshVersion: values.dsh_version ? normalizeVersion(values.dsh_version) : null,
    curlPath: values.curl_path || null,
    tarPath: values.tar_path || null,
    sha256Path: values.sha256_path || null,
    diskFreeKb: num(values.disk_free_kb),
    sshConnection: values.ssh_connection === 'yes',
    isolatedNodePath: values.isolated_node_path || null,
    isolatedNodeVersion: values.isolated_node_version ? normalizeVersion(values.isolated_node_version) : null,
    isolatedDshVersion: values.isolated_dsh_version ? normalizeVersion(values.isolated_dsh_version) : null,
    isolatedDshBinPath: values.isolated_dsh_bin_path || null,
    credentialsFile: values.credentials_file === 'yes',
    deepseekKeyEnv: values.deepseek_key_env === 'yes',
    providerEnvKeys: values.provider_env_keys ? values.provider_env_keys.split(',').filter(Boolean) : [],
    runRegistry: parseRegistry(values.run_registry),
    remoteDirExists: values.remote_dir_exists === 'yes',
    homeExists: values.home_exists === 'yes',
  }
}

/**
 * @param {string} text
 */
function parseRegistry(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Run the probe against one SSH connection.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ remoteDir: string, timeoutMs?: number }} options
 * @returns {Promise<ProbeFacts>}
 */
export async function probeRemote(ssh, options) {
  const script = buildProbeScript(options.remoteDir)
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
 * Design §16.2 T5: when even the basics are absent, stop with instructions
 * instead of pretending to install.
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
    dsh: {
      version: facts.dshVersion,
      path: facts.dshPath,
      isolatedVersion: facts.isolatedDshVersion,
    },
    network: {
      curl: Boolean(facts.curlPath),
      tar: Boolean(facts.tarPath),
      sha256: Boolean(facts.sha256Path),
    },
    modelCredentials: {
      credentialsFile: facts.credentialsFile,
      deepseekKeyEnv: facts.deepseekKeyEnv,
      providerKeys: facts.providerEnvKeys,
    },
    sshSession: facts.sshConnection,
    diskFreeKb: facts.diskFreeKb,
  }
}
