/**
 * The per-host cookie jar of the same-origin proxy.
 *
 * The remote hands its session cookie to a browser that speaks to the local origin, so those
 * cookies are kept here instead: one jar per host, bounded, and never handed to the local GUI's
 * own cookie jar (both GUIs answer on 127.0.0.1, so browser cookies are shared across ports).
 */
import type { ProxyTarget } from './headers.js'

/**
 * Bounds of one host's cookie jar. The remote decides what to set, so the jar needs a ceiling:
 * 64 cookies of at most 4 KiB keep a hostile or simply broken remote from growing the process,
 * and a cookie the remote marks `Secure` never lands in this plaintext, in-memory jar at all.
 */
export const MAX_JAR_COOKIES = 64
export const MAX_COOKIE_VALUE = 4096
export const MAX_COOKIE_NAME = 128

/** One jar entry: what `parseSetCookie` understood from one `Set-Cookie` line. */
export interface ParsedCookie {
  name: string
  value: string
  path: string
  expiresAt: number
  secure: boolean
}

/**
 * One cookie as the jar keeps it. `name` is repeated because a jar entry has to be complete on its
 * own when it is read back; `secure` is absent because such a cookie is never stored.
 */
export interface StoredCookie {
  name: string
  value: string
  path: string
  expiresAt: number
}

/** One host's cookies, keyed by name; values never leave this process. */
export type CookieJar = Map<string, StoredCookie>

/**
 * Parse one `Set-Cookie` line into the jar entry it should replace.
 * Only the attributes that decide whether and where the value is sent are kept.
 * @param line - one Set-Cookie header value.
 */
export function parseSetCookie(line: string): ParsedCookie | null {
  const [pair, ...attributes] = String(line ?? '').split(';')
  const equals = pair.indexOf('=')
  if (equals <= 0) return null
  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()
  if (name === '' || name.length > MAX_COOKIE_NAME) return null
  if (value.length > MAX_COOKIE_VALUE) return null
  let cookiePath = '/'
  let expiresAt = Number.POSITIVE_INFINITY
  let secure = false
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
    const raw = at === -1 ? '' : attribute.slice(at + 1).trim()
    if (key === 'path' && raw.startsWith('/')) cookiePath = raw
    if (key === 'secure') secure = true
    if (key === 'max-age') {
      const seconds = Number(raw)
      if (Number.isFinite(seconds)) expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1000
    }
    if (key === 'expires' && expiresAt === Number.POSITIVE_INFINITY) {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) expiresAt = parsed
    }
  }
  return { name, value, path: cookiePath, expiresAt, secure }
}

/** One host's cookies, keyed by name; values never leave this process. */
function createCookieJar(): CookieJar {
  return new Map()
}

/**
 * Store every non-expired cookie from one response and drop the ones it cleared.
 * @param jar - host jar.
 * @param setCookie - raw Set-Cookie value(s).
 */
export function storeCookies(jar: CookieJar, setCookie: string | string[] | undefined): void {
  if (setCookie === undefined) return
  for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const entry = parseSetCookie(line)
    if (entry === null) continue
    if (entry.value === '' || entry.expiresAt <= Date.now()) {
      jar.delete(entry.name)
      continue
    }
    // The tunnel is plain HTTP to 127.0.0.1, so a `Secure` cookie is not one this jar may
    // keep: storing and replaying it would downgrade a flag the remote asked for.
    if (entry.secure) {
      jar.delete(entry.name)
      continue
    }
    if (!jar.has(entry.name) && jar.size >= MAX_JAR_COOKIES) continue
    jar.set(entry.name, { name: entry.name, value: entry.value, path: entry.path, expiresAt: entry.expiresAt })
  }
}

/**
 * Cookies whose path covers the upstream path, as one Cookie header value.
 * @param jar - host jar.
 * @param path - upstream request path.
 */
export function cookieHeader(jar: CookieJar, path: string): string {
  const now = Date.now()
  const parts: string[] = []
  for (const [name, entry] of jar) {
    if (entry.expiresAt <= now) {
      jar.delete(name)
      continue
    }
    const covers =
      entry.path === '/' ||
      path === entry.path ||
      path.startsWith(`${entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path}/`)
    if (covers) parts.push(`${name}=${entry.value}`)
  }
  return parts.join('; ')
}

/** One host's jar, bound to the remote authority it was filled from (see `jarFor`). */
interface HostJar {
  authority: string
  jar: CookieJar
}

/** The per-host jars one proxy activation owns. */
export interface JarBook {
  /** The jar for one host, rebuilt whenever the remote authority behind it changed. */
  jarFor: (hostId: string, target: ProxyTarget) => CookieJar
  /** Drop one host's jar, or every jar when `hostId` is omitted. */
  clear: (hostId?: string) => void
  /** The jar one host currently has, for diagnostics. */
  get: (hostId: string) => CookieJar | undefined
}

/**
 * Create the per-host jar book.
 *
 * `authorityOf` is injected instead of imported: `remoteAuthority` is defined next to the header
 * rewriting, and `headers.ts` already imports `cookieHeader` from here, so reaching back would
 * make the two leaf modules import each other.
 */
export function createJarBook(authorityOf: (target: ProxyTarget) => string): JarBook {
  const jars = new Map<string, HostJar>()

  /**
   * The per-host cookie jar is bound to the remote authority it was filled from: after a
   * restart or a re-attach the remote comes back on a new random port, and cookies issued
   * by the old instance must not be sent to the new one (nor kept after the host is gone).
   */
  function jarFor(hostId: string, target: ProxyTarget): CookieJar {
    const authority = authorityOf(target)
    let entry = jars.get(hostId)
    if (entry === undefined || entry.authority !== authority) {
      entry = { authority, jar: createCookieJar() }
      jars.set(hostId, entry)
    }
    return entry.jar
  }

  return {
    jarFor,
    clear(hostId?: string): void {
      if (hostId === undefined) jars.clear()
      else jars.delete(hostId)
    },
    get(hostId: string): CookieJar | undefined {
      return jars.get(hostId)?.jar
    },
  }
}
