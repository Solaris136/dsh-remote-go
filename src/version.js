/**
 * Version parsing/comparison and the exact-version parity rule, covering the shapes DSH and Node publish (`0.2.2-rc.1`, `24.22.2`, optional `v`).
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const match = VERSION_RE.exec(input.trim())
  if (!match) return null
  const [, major, minor, patch, prerelease, build] = match
  return {
    raw: input.trim(),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
    build: build ?? null,
  }
}

export function normalizeVersion(input) {
  const parsed = parseVersion(input)
  if (!parsed) return String(input ?? '').trim()
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length > 0 ? `${core}-${parsed.prerelease.join('.')}` : core
}

function compareIdentifiers(a, b) {
  const aNum = typeof a === 'number'
  const bNum = typeof b === 'number'
  if (aNum && bNum) return a === b ? 0 : a < b ? -1 : 1
  if (aNum) return -1 // numeric identifiers sort before alphanumeric ones
  if (bNum) return 1
  return a === b ? 0 : String(a) < String(b) ? -1 : 1
}

export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) {
    const sa = String(a ?? '')
    const sb = String(b ?? '')
    return sa === sb ? 0 : sa < sb ? -1 : 1
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const length = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const left = pa.prerelease[i]
    const right = pb.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const result = compareIdentifiers(left, right)
    if (result !== 0) return result
  }
  return 0
}

export function versionsEqual(a, b) {
  return compareVersions(normalizeVersion(a), normalizeVersion(b)) === 0
}

export function versionParity(localVersion, remoteVersion) {
  if (!localVersion || !remoteVersion) {
    return {
      status: /** @type {'unknown'} */ ('unknown'),
      local: localVersion ?? null,
      remote: remoteVersion ?? null,
      same: false,
      message: {
        zh: '无法确定版本一致性（缺少本机或远端版本）。',
        en: 'Version parity is unknown (a local or remote version is missing).',
      },
    }
  }
  const same = versionsEqual(localVersion, remoteVersion)
  return {
    status: /** @type {'same' | 'different'} */ (same ? 'same' : 'different'),
    local: normalizeVersion(localVersion),
    remote: normalizeVersion(remoteVersion),
    same,
    message: same
      ? { zh: '远端与本机 DSH 版本一致。', en: 'The remote DSH version matches this machine.' }
      : {
          zh: `远端 DSH（${normalizeVersion(remoteVersion)}）与本机（${normalizeVersion(localVersion)}）不一致。`,
          en: `Remote DSH (${normalizeVersion(remoteVersion)}) differs from this machine (${normalizeVersion(localVersion)}).`,
        },
  }
}

export const MIN_NODE_VERSION = '24.9.0'

export function isNodeVersionSupported(version) {
  if (!version) return false
  // node -v prints "v24.22.2"; a bare "24" from a fallback should not pass.
  if (!parseVersion(version)) return false
  return compareVersions(normalizeVersion(version), MIN_NODE_VERSION) >= 0
}

/** Pad a partial version (`24`, `^1.2`) so range comparisons see three numeric parts. */
function coerceVersion(input) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+][0-9A-Za-z.+-]*)?$/.exec(String(input ?? '').trim())
  if (!match) return normalizeVersion(input)
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4] ?? ''}`
}

function satisfiesComparator(token, version) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(String(token ?? '').trim())
  if (!match) return false
  const op = match[1] ?? ''
  const targetText = coerceVersion(match[2])
  const target = parseVersion(targetText)
  const current = parseVersion(coerceVersion(version))
  if (!target || !current) return false
  const cmp = compareVersions(coerceVersion(version), targetText)
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  if (op === '=') return cmp === 0
  if (op === '^') {
    const upper =
      target.major > 0
        ? `${target.major + 1}.0.0`
        : target.minor > 0
          ? `0.${target.minor + 1}.0`
          : `0.0.${target.patch + 1}`
    return cmp >= 0 && compareVersions(coerceVersion(version), upper) < 0
  }
  if (op === '~') {
    const upper = `${target.major}.${target.minor + 1}.0`
    return cmp >= 0 && compareVersions(coerceVersion(version), upper) < 0
  }
  return cmp === 0
}

/**
 * Minimal semver range check for plugin manifests (`engines.dsh` / `engines.node`):
 * `||` groups, whitespace-joined comparators, `>= <= > < = ^ ~` and bare versions.
 * Prerelease-exclusion rules are deliberately ignored; a plugin whose engine range
 * cannot be parsed is treated as unconstrained by the caller.
 */
export function satisfiesRange(range, version) {
  const text = String(range ?? '').trim()
  if (text === '') return true
  if (!parseVersion(coerceVersion(version))) return false
  return text.split('||').some((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return true
    return tokens.every((token) => satisfiesComparator(token, version))
  })
}
