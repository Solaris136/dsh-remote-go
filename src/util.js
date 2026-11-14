/**
 * Small dependency-free helpers shared by the host half.
 * Everything here is pure so it can be unit-tested with node:test.
 */

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve a promise or reject after `ms`.
 * @template T
 * @param {Promise<T> | T} value
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function withTimeout(value, ms, label = 'operation') {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** @param {number} min @param {number} max */
export function randomDelay(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min))
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** @param {string} prefix */
export function randomId(prefix = 'h') {
  let out = ''
  for (let i = 0; i < 10; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return `${prefix}_${out}`
}

/** @returns {string} ISO timestamp */
export function nowIso() {
  return new Date().toISOString()
}

/** @param {unknown} value */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Property names whose write would land on the prototype chain instead of a
 * plain value. The merge below only writes keys that `base` declares, so these
 * can only appear if a caller ever passes a hostile `base`; the guard is cheap
 * insurance for that case.
 */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Recursively merge `patch` into `base` (arrays and scalars replace).
 *
 * Only properties that `base` declares are merged: `base` is the trusted schema
 * (the settings defaults), `patch` is untrusted input (a saved or HTTP-supplied
 * settings object), and a patch may therefore change known values but never
 * invent a property name. That closes the remote-property-injection path (and
 * with it the prototype-polluting-assignment shape, where `{"__proto__": …}`
 * would replace the merged object's prototype) by construction rather than by
 * blocklist, and matches the caller, which reads a fixed set of fields.
 * @template T
 * @param {T} base
 * @param {unknown} patch
 * @returns {T}
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return /** @type {T} */ (patch === undefined ? base : patch)
  const out = { ...base }
  for (const key of Object.keys(base)) {
    if (UNSAFE_KEYS.has(key)) continue
    const value = patch[key]
    if (value === undefined) continue
    // Recurse into declared nested objects so their keys are schema-anchored too.
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Expand a leading `~` using the given home directory.
 * @param {string} value
 * @param {string} home
 */
export function expandHome(value, home) {
  if (typeof value !== 'string') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + value.slice(1)
  return value
}

/**
 * Parse an SSH destination written as `[user@]host[:port]`, an SSH config alias,
 * or an IPv6 literal in brackets.
 * @param {string} raw
 * @returns {{ user: string | null, host: string, port: number | null }}
 */
export function parseSshDestination(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { user: null, host: '', port: null }
  let user = null
  let rest = text
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let host = rest
  let port = null
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close > 0) {
      host = rest.slice(1, close)
      const tail = rest.slice(close + 1)
      if (/^:\d+$/.test(tail)) port = Number(tail.slice(1))
    }
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon > 0 && rest.indexOf(':') === colon) {
      const maybePort = rest.slice(colon + 1)
      if (/^\d{1,5}$/.test(maybePort)) {
        host = rest.slice(0, colon)
        port = Number(maybePort)
      }
    }
  }
  return { user: user || null, host, port }
}

/** @param {string | null | undefined} host */
export function isLoopbackHost(host) {
  if (!host) return false
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  if (normalized === '::ffff:127.0.0.1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/**
 * Mask an SSH destination for display: hide the user's details but keep the
 * shape (`user@host:port`). Passwords never reach this layer by design.
 * @param {{ user?: string | null, host: string, port?: number | null, alias?: string | null }} target
 */
export function maskSshAddress(target) {
  const alias = target.alias ? `${target.alias}` : null
  const user = target.user ? `${target.user}@` : ''
  const host = target.host || '?'
  const port = target.port && target.port !== 22 ? `:${target.port}` : ''
  const base = `${user}${host}${port}`
  return alias && alias !== base ? `${alias} (${base})` : base
}

/**
 * Quote one argument for a POSIX shell as a single-quoted word.
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * Split a shell command line into argv without invoking a shell.
 * Used by tests and config parsing only.
 * @param {string} line
 * @returns {string[]}
 */
export function splitShellWords(line) {
  const words = []
  let current = ''
  let quote = null
  let escaped = false
  for (const ch of String(line)) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        words.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') words.push(current)
  return words
}

/** @param {string} text @param {number} max */
export function headTail(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = value.slice(0, Math.floor(max / 2))
  const tail = value.slice(-Math.floor(max / 2))
  return `${head}\n…\n${tail}`
}

/**
 * Whether a line at `level` clears the `threshold`.
 * @param {string} level
 * @param {string} [threshold]
 */
export function logVisible(level, threshold = 'info') {
  const rank = LOG_LEVELS[level] ?? LOG_LEVELS.info
  const floor = LOG_LEVELS[threshold] ?? LOG_LEVELS.info
  return rank >= floor
}

/**
 * A promise with externally callable resolve/reject, used for flows that wait
 * on a user decision (host-key confirmation).
 * @template T
 */
export function createDeferred() {
  /** @type {(value: T | PromiseLike<T>) => void} */
  let resolve
  /** @type {(reason?: unknown) => void} */
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
