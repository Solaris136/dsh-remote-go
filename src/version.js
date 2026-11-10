/**
 * Version parsing/comparison and the design's exact-version parity rule (§16.3).
 * Supports the version shapes DSH and Node actually publish: `0.2.2-rc.1`,
 * `24.22.2`, optional leading `v`, optional build metadata.
 */

/** @typedef {{ raw: string, major: number, minor: number, patch: number, prerelease: (string|number)[], build: string | null }} ParsedVersion */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * @param {string} input
 * @returns {ParsedVersion | null}
 */
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

/** @param {string} input */
export function normalizeVersion(input) {
  const parsed = parseVersion(input)
  if (!parsed) return String(input ?? '').trim()
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length > 0 ? `${core}-${parsed.prerelease.join('.')}` : core
}

/** @param {unknown} a @param {unknown} b */
function compareIdentifiers(a, b) {
  const aNum = typeof a === 'number'
  const bNum = typeof b === 'number'
  if (aNum && bNum) return a === b ? 0 : a < b ? -1 : 1
  if (aNum) return -1 // numeric identifiers sort before alphanumeric ones
  if (bNum) return 1
  return a === b ? 0 : String(a) < String(b) ? -1 : 1
}

/**
 * Semver ordering (build metadata is ignored, as in semver).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1 | number}
 */
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

/** Exact version equality after normalization (`v` prefix and build ignored). */
export function versionsEqual(a, b) {
  return compareVersions(normalizeVersion(a), normalizeVersion(b)) === 0
}

/**
 * Design §16.3: the remote target is the local DSH version, and a mismatch is
 * surfaced instead of silently mixing UIs.
 * @param {string | null} localVersion
 * @param {string | null} remoteVersion
 */
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

/** Node.js >= 24.9.0 is required by the DSH runtime (`engines.node`). */
export const MIN_NODE_VERSION = '24.9.0'

/** @param {string | null | undefined} version */
export function isNodeVersionSupported(version) {
  if (!version) return false
  // node -v prints "v24.22.2"; a bare "24" from a fallback should not pass.
  if (!parseVersion(version)) return false
  return compareVersions(normalizeVersion(version), MIN_NODE_VERSION) >= 0
}

/**
 * Pick an exact version from a list of strings matching a semver range prefix.
 * Only used by tests/fixtures; runtime always pins exact versions.
 * @param {string[]} candidates
 * @param {string} wanted
 */
export function pickExactVersion(candidates, wanted) {
  return candidates.find((candidate) => versionsEqual(candidate, wanted)) ?? null
}
