/** Small pure helpers shared by the host half, unit-tested with node:test. */
export interface BilingualText {
  zh: string
  en: string
}
/** A parsed `[user@]host[:port]`; `null` means "not given", never "empty". */
export interface SshDestination {
  user: string | null
  host: string
  port: number | null
}
/** The slice of `console` the host half reports through; tests pass a collector. */
export interface Logger {
  warn?: (...args: unknown[]) => void
}
export interface Decision<T> {
  promise: Promise<T>
  settle: (value: T) => void
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function randomDelay(min: number, max: number): number {
  return Math.round(min + Math.random() * Math.max(0, max - min))
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function randomId(prefix = 'h'): string {
  let out = ''
  for (let i = 0; i < 10; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return `${prefix}_${out}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LOG_LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const LOOPBACK_NAMES = new Set(['localhost', '::1', '::ffff:127.0.0.1'])
/** Prototype-chain names that must never be written by a merge. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Merge `patch` into `base` (arrays/scalars replace); only keys `base` declares are written, so untrusted input cannot invent a property or poison the prototype. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    const value = patch[key]
    if (value === undefined || UNSAFE_KEYS.has(key)) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out as T
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function expandHome(value: unknown, home: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + text.slice(1)
  return text
}

export function parseSshDestination(raw: unknown): SshDestination {
  const text = String(raw ?? '').trim()
  if (text === '') return { user: null, host: '', port: null }
  const at = text.lastIndexOf('@')
  const user = (at >= 0 ? text.slice(0, at) : '') || null
  const rest = at >= 0 ? text.slice(at + 1) : text
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    const tail = close > 0 ? rest.slice(close + 1) : ''
    const port = /^:\d+$/.test(tail) ? Number(tail.slice(1)) : null
    return { user, host: close > 0 ? rest.slice(1, close) : rest, port }
  }
  const colon = rest.lastIndexOf(':')
  const maybePort = rest.slice(colon + 1)
  const port = colon > 0 && rest.indexOf(':') === colon && /^\d{1,5}$/.test(maybePort) ? Number(maybePort) : null
  return { user, host: port === null ? rest : rest.slice(0, colon), port }
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return LOOPBACK_NAMES.has(normalized) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function headTail(text: unknown, max = 4000): string {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const half = Math.floor(max / 2)
  return `${value.slice(0, half)}\n…\n${value.slice(-half)}`
}

export function logVisible(level: string, threshold = 'info'): boolean {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= (LOG_LEVELS[threshold] ?? LOG_LEVELS.info)
}

/** Message of an unknown thrown value, so catch blocks need not spell the ternary. */
export function messageOf(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error)
}

/** A positive integer — the only shape `kill`, `/proc` and a TCP port accept. */
export function isPid(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0
}

/** A promise that resolves at most once: through `settle`, or with `onTimeout()` when the deadline passes first; `onSettled` runs before the resolution so a caller can clear the slot it installed on both paths. */
export function createDecision<T>(timeoutMs: number, onTimeout: () => T, onSettled?: (value: T) => void): Decision<T> {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    let done = false
    const timer = setTimeout(() => settle(onTimeout?.()), timeoutMs)
    settle = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      onSettled?.(value)
      resolve(value)
    }
  })
  return { promise, settle }
}
