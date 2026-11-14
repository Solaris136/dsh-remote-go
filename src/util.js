/**
 * Small pure helpers shared by the host half, unit-tested with node:test.
 */

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

export function randomDelay(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min))
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function randomId(prefix = 'h') {
  let out = ''
  for (let i = 0; i < 10; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return `${prefix}_${out}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

/** Prototype-chain names that must never be written by a merge. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Recursively merge `patch` into `base` (arrays and scalars replace). Only keys
 * `base` declares are written, so untrusted input can change known values but
 * never invent a property or poison the prototype.
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
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function expandHome(value, home) {
  if (typeof value !== 'string') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + value.slice(1)
  return value
}

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

/** Mask a destination for display; passwords never reach this layer. */
export function maskSshAddress(target) {
  const alias = target.alias ? `${target.alias}` : null
  const user = target.user ? `${target.user}@` : ''
  const host = target.host || '?'
  const port = target.port && target.port !== 22 ? `:${target.port}` : ''
  const base = `${user}${host}${port}`
  return alias && alias !== base ? `${alias} (${base})` : base
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

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

export function headTail(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = value.slice(0, Math.floor(max / 2))
  const tail = value.slice(-Math.floor(max / 2))
  return `${head}\n…\n${tail}`
}

export function logVisible(level, threshold = 'info') {
  const rank = LOG_LEVELS[level] ?? LOG_LEVELS.info
  const floor = LOG_LEVELS[threshold] ?? LOG_LEVELS.info
  return rank >= floor
}

/**
 * A promise with externally callable resolve/reject, for flows waiting on a
 * user decision (host-key confirmation).
 * @template T
 */
export function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
