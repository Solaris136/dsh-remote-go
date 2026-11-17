/**
 * Same-origin reverse proxy for a connected host's remote DSH web UI.
 *
 * The browser half shows the remote UI in a same-origin frame. This module makes that frame work
 * without handing the browser a second origin:
 *
 * - every request under `REMOTE_VIEW_PREFIX<hostId>/` is stripped of the prefix and forwarded to
 *   that host's loopback tunnel;
 * - the remote's session cookies stay in a per-host jar here, never in the local GUI's cookie jar
 *   (both GUIs answer on 127.0.0.1, so browser cookies are shared across ports);
 * - `Host`/`Origin` are rewritten to the remote's own loopback authority, so the remote's
 *   authority-bound cookie and same-origin fence keep working;
 * - the only WebSocket route a remote DSH owns (`/api/remote.mux`) gets one exact upgrade route
 *   per connected host, because the local web server matches upgrades by exact pathname.
 *
 * It proxies nothing but a host that is currently connected: an unknown or disconnected host id
 * is a 404, DSH's own admission decides whether the caller may use the seat at all, and the
 * same-origin fence rejects cross-site requests, matching the local API.
 */
import http from 'node:http';
import net from 'node:net';
import { REMOTE_VIEW_PREFIX } from './constants.js';
import { trustedRequest } from './request-trust.js';
/** How long the remote may take to accept a connection and answer; see `createRemoteProxy`. */
export const UPSTREAM_TIMEOUT_MS = 30_000;
/** A handshake response head larger than this is not a WebSocket upgrade; it is dropped. */
const MAX_UPSTREAM_HEAD_BYTES = 64 * 1024;
/** How long the remote web UI's own stream route is (the only upgrade a DSH web serves). */
const REMOTE_STREAM_PATH = '/api/remote.mux';
const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Headers that describe one hop and must not be copied to the other connection. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
/**
 * The request headers this proxy forwards. This is an allowlist on purpose: the browser's own
 * credentials belong to the *local* origin (`authorization`, `cookie`, `x-dsh-*`) and the
 * traffic-shaping headers belong to this hop (`forwarded`, `x-forwarded-*`, `sec-fetch-*`).
 * A blacklist forwarded them all to a host that the remote controls.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'content-length',
    'content-type',
    'range',
    'user-agent',
    'x-requested-with',
]);
/** Conditional-request headers: `if-match`, `if-none-match`, `if-modified-since`, `if-range`, … */
const FORWARDED_REQUEST_PREFIX = 'if-';
/** The fields a WebSocket handshake needs, forwarded only on an upgrade. */
const UPGRADE_REQUEST_HEADERS = new Set([
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
    'sec-websocket-extensions',
]);
/**
 * Response headers a remote page may not set on the local origin. `clear-site-data` would let a
 * compromised remote wipe this GUI's own cookies and storage, `access-control-*` would open the
 * local origin to other sites, and `refresh` / `content-location` / `report-to` / `nel` /
 * `permissions-policy` / `alt-svc` redirect or reshape the browser's view of a server it does
 * not own.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
    'clear-site-data',
    'refresh',
    'content-location',
    'report-to',
    'nel',
    'permissions-policy',
    'alt-svc',
]);
/** Every `access-control-*` response header belongs to the remote's origin, not this one. */
const BLOCKED_RESPONSE_PREFIX = 'access-control-';
/**
 * Whether one browser request header may reach the remote.
 * @param name - lowercase header name.
 * @param preserveUpgrade - whether this is a WebSocket handshake.
 */
export function forwardableRequestHeader(name, preserveUpgrade = false) {
    if (FORWARDED_REQUEST_HEADERS.has(name))
        return true;
    if (name.startsWith(FORWARDED_REQUEST_PREFIX))
        return true;
    return preserveUpgrade === true && UPGRADE_REQUEST_HEADERS.has(name);
}
/**
 * Whether one upstream response header may reach the browser.
 * @param name - lowercase header name.
 */
export function forwardableResponseHeader(name) {
    if (BLOCKED_RESPONSE_HEADERS.has(name))
        return false;
    if (name.startsWith(BLOCKED_RESPONSE_PREFIX))
        return false;
    return true;
}
/**
 * Split `/dsh-remote-go/remote/<hostId>/<rest>` into its host and the upstream path.
 * Returns null for anything that is not one well-formed view path (encoded slashes included).
 * @param pathname - URL pathname; anything else is refused, so the guard stays.
 */
export function parseViewPath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith(REMOTE_VIEW_PREFIX))
        return null;
    const rest = pathname.slice(REMOTE_VIEW_PREFIX.length);
    const slash = rest.indexOf('/');
    const rawId = slash === -1 ? rest : rest.slice(0, slash);
    let hostId;
    try {
        hostId = decodeURIComponent(rawId);
    }
    catch {
        return null;
    }
    if (!HOST_ID_PATTERN.test(hostId))
        return null;
    // The seat is always `<prefix><hostId>/`: the bare id is not a page.
    if (slash === -1)
        return null;
    const upstream = rest.slice(slash);
    return { hostId, path: upstream === '' ? '/' : upstream };
}
/** Exact pathname the remote's stream upgrade arrives on. */
export function upgradePath(hostId) {
    return `${REMOTE_VIEW_PREFIX}${hostId}${REMOTE_STREAM_PATH}`;
}
/**
 * Bounds of one host's cookie jar. The remote decides what to set, so the jar needs a ceiling:
 * 64 cookies of at most 4 KiB keep a hostile or simply broken remote from growing the process,
 * and a cookie the remote marks `Secure` never lands in this plaintext, in-memory jar at all.
 */
export const MAX_JAR_COOKIES = 64;
export const MAX_COOKIE_VALUE = 4096;
export const MAX_COOKIE_NAME = 128;
/**
 * Parse one `Set-Cookie` line into the jar entry it should replace.
 * Only the attributes that decide whether and where the value is sent are kept.
 * @param line - one Set-Cookie header value.
 */
export function parseSetCookie(line) {
    const [pair, ...attributes] = String(line ?? '').split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0)
        return null;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (name === '' || name.length > MAX_COOKIE_NAME)
        return null;
    if (value.length > MAX_COOKIE_VALUE)
        return null;
    let cookiePath = '/';
    let expiresAt = Number.POSITIVE_INFINITY;
    let secure = false;
    for (const attribute of attributes) {
        const at = attribute.indexOf('=');
        const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
        const raw = at === -1 ? '' : attribute.slice(at + 1).trim();
        if (key === 'path' && raw.startsWith('/'))
            cookiePath = raw;
        if (key === 'secure')
            secure = true;
        if (key === 'max-age') {
            const seconds = Number(raw);
            if (Number.isFinite(seconds))
                expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
        }
        if (key === 'expires' && expiresAt === Number.POSITIVE_INFINITY) {
            const parsed = Date.parse(raw);
            if (Number.isFinite(parsed))
                expiresAt = parsed;
        }
    }
    return { name, value, path: cookiePath, expiresAt, secure };
}
/** One host's cookies, keyed by name; values never leave this process. */
function createCookieJar() {
    return new Map();
}
/**
 * Store every non-expired cookie from one response and drop the ones it cleared.
 * @param jar - host jar.
 * @param setCookie - raw Set-Cookie value(s).
 */
export function storeCookies(jar, setCookie) {
    if (setCookie === undefined)
        return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        const entry = parseSetCookie(line);
        if (entry === null)
            continue;
        if (entry.value === '' || entry.expiresAt <= Date.now()) {
            jar.delete(entry.name);
            continue;
        }
        // The tunnel is plain HTTP to 127.0.0.1, so a `Secure` cookie is not one this jar may
        // keep: storing and replaying it would downgrade a flag the remote asked for.
        if (entry.secure) {
            jar.delete(entry.name);
            continue;
        }
        if (!jar.has(entry.name) && jar.size >= MAX_JAR_COOKIES)
            continue;
        jar.set(entry.name, { name: entry.name, value: entry.value, path: entry.path, expiresAt: entry.expiresAt });
    }
}
/**
 * Cookies whose path covers the upstream path, as one Cookie header value.
 * @param jar - host jar.
 * @param path - upstream request path.
 */
export function cookieHeader(jar, path) {
    const now = Date.now();
    const parts = [];
    for (const [name, entry] of jar) {
        if (entry.expiresAt <= now) {
            jar.delete(name);
            continue;
        }
        const covers = entry.path === '/' ||
            path === entry.path ||
            path.startsWith(`${entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path}/`);
        if (covers)
            parts.push(`${name}=${entry.value}`);
    }
    return parts.join('; ');
}
/** Absolute origin of the remote's own listener, as the remote sees itself through the tunnel. */
function remoteOrigin(target) {
    const port = Number(target.remotePort);
    return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : target.localPort}`;
}
function remoteAuthority(target) {
    return remoteOrigin(target).slice('http://'.length);
}
/** Rewrite an absolute URL from the local origin to the remote's origin, keeping its path. */
function rewriteSameOrigin(value, localOrigin, target) {
    const local = typeof localOrigin === 'string' ? localOrigin.replace(/\/$/, '') : '';
    const text = String(value);
    if (local !== '' && (text === local || text.startsWith(`${local}/`))) {
        return remoteOrigin(target) + text.slice(local.length);
    }
    return text;
}
/**
 * Request headers for the upstream: only the allowlisted content headers are copied, the two
 * authority fields are rewritten, and only this host's own cookies are added.
 * @param rawHeaders - node raw header list.
 */
export function upstreamHeaders(rawHeaders, input) {
    const out = {};
    const preserveUpgrade = input.preserveUpgrade === true;
    for (let at = 0; at < rawHeaders.length; at += 2) {
        const name = String(rawHeaders[at]).toLowerCase();
        const value = rawHeaders[at + 1];
        if (name === 'host' || name === 'cookie')
            continue;
        if (name === 'origin') {
            out.origin = remoteOrigin(input.target);
            continue;
        }
        if (name === 'referer') {
            out.referer = rewriteSameOrigin(value, input.localOrigin, input.target);
            continue;
        }
        if (!forwardableRequestHeader(name, preserveUpgrade))
            continue;
        out[name] = out[name] === undefined ? value : [].concat(out[name], value);
    }
    out.host = remoteAuthority(input.target);
    const cookies = cookieHeader(input.jar, input.path);
    if (cookies !== '')
        out.cookie = cookies;
    return out;
}
/**
 * Drop only the `frame-ancestors` directive of a CSP: the proxy exists to frame that one page,
 * and a hostile-looking directive would otherwise make a hardened remote unusable in a browser.
 * Every other directive stays exactly as the remote sent it.
 * @param value - one Content-Security-Policy value.
 */
export function withoutFrameAncestors(value) {
    return String(value)
        .split(';')
        .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
        .map((directive) => directive.trim())
        .filter((directive) => directive !== '')
        .join('; ');
}
/**
 * Rewrite one upstream `Location` for the browser.
 *
 * A redirect that names the remote's own loopback listener is folded back under the view
 * prefix, so a form post or a token exchange stays inside the frame. Everything else that is an
 * absolute URL — another host, another scheme, a protocol-relative `//evil.example`, or a
 * different loopback port — is refused (`null`): the header is dropped, because navigation
 * inside this same-origin frame must never leave the seat the user opened. A relative
 * reference (`.`, `./next`, `/assets/app.js`) is already resolved against that seat, so it is
 * passed through untouched.
 * @param value - one upstream Location header value.
 * @returns the header value to send, or null to drop the header.
 */
export function safeLocation(value, input = {}) {
    const text = String(value ?? '')
        .replace(/[\r\n]/g, '')
        .trim();
    if (text === '')
        return null;
    if (input.hostId && input.remoteOrigin) {
        if (text === input.remoteOrigin)
            return `${REMOTE_VIEW_PREFIX}${input.hostId}/`;
        if (text.startsWith(`${input.remoteOrigin}/`)) {
            return `${REMOTE_VIEW_PREFIX}${input.hostId}${text.slice(input.remoteOrigin.length)}`;
        }
        if (text.startsWith(`${input.remoteOrigin}?`) || text.startsWith(`${input.remoteOrigin}#`)) {
            return `${REMOTE_VIEW_PREFIX}${input.hostId}/${text.slice(input.remoteOrigin.length)}`;
        }
    }
    // Any scheme (`https:`, `javascript:`, `data:`…) is an absolute target.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text))
        return null;
    // A backslash is a slash to the URL parser for special schemes: `/\evil.example/x` and
    // `\/evil.example` both resolve to `http://evil.example/`, so a surviving backslash in what
    // looks like a relative reference is an off-origin escape. (`%5c` stays percent-encoded and is
    // not a separator, so it is not caught here.)
    if (text.includes('\\'))
        return null;
    // `//host/…`: a browser reads it as protocol-relative, i.e. off-origin.
    if (text.startsWith('//'))
        return null;
    return text;
}
/**
 * Response headers to hand the browser: drop hop-by-hop fields, this connection's framing, the
 * remote's cookies (they go to the jar), any frame denial the remote inherited from another
 * deployment, and browser-policy headers the remote must not set on the local origin. A
 * `Location` that names the remote's own listener is folded back under the view prefix; any
 * other absolute target is dropped so a redirect cannot slip out of the frame.
 * @param rawHeaders - upstream raw header list.
 * @returns flat [name, value, …] pairs.
 */
export function responseHeaders(rawHeaders, input = {}) {
    const out = [];
    const preserveUpgrade = input.preserveUpgrade === true;
    for (let at = 0; at < rawHeaders.length; at += 2) {
        const name = String(rawHeaders[at]).toLowerCase();
        // `Connection`/`Upgrade` are hop-by-hop, except in the response to a WebSocket handshake:
        // dropping them there would turn a valid 101 into a protocol error.
        if (HOP_BY_HOP.has(name) && !(preserveUpgrade && (name === 'connection' || name === 'upgrade')))
            continue;
        if (name === 'set-cookie' || name === 'x-frame-options')
            continue;
        if (!forwardableResponseHeader(name))
            continue;
        if (name === 'content-security-policy') {
            out.push(rawHeaders[at], withoutFrameAncestors(String(rawHeaders[at + 1])));
            continue;
        }
        if (name === 'location') {
            const location = safeLocation(rawHeaders[at + 1], input);
            if (location === null)
                continue;
            out.push(rawHeaders[at], location);
            continue;
        }
        out.push(rawHeaders[at], rawHeaders[at + 1]);
    }
    return out;
}
/**
 * Rewrite one raw upstream response head (status line + headers, without the final blank line).
 *
 * The upgrade path forwards a 101 byte-for-byte if left alone, which also forwarded
 * `Set-Cookie` and every browser-policy header the remote chose to attach to the handshake. The
 * same policy as `responseHeaders` applies here; only the status line and the header block are
 * touched, never the frames that follow.
 * @param headText - latin1-decoded head, `HTTP/1.1 101 …\r\nkey: value…`.
 * @returns the filtered head (without the trailing blank line), or '' when unparseable.
 */
export function filterResponseHead(headText, input = {}) {
    const lines = String(headText ?? '').split('\r\n');
    const statusLine = lines.shift() ?? '';
    if (!/^HTTP\/1\.[01] \d{3}(?: .*)?$/.test(statusLine))
        return '';
    const raw = [];
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        raw.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const filtered = responseHeaders(raw, { ...input, preserveUpgrade: true });
    let out = `${statusLine}\r\n`;
    for (let at = 0; at < filtered.length; at += 2)
        out += `${filtered[at]}: ${filtered[at + 1]}\r\n`;
    return out;
}
/** One status line and a short body: every refusal this proxy answers with. */
function plain(res, status, text) {
    const body = String(text);
    try {
        res.writeHead(status, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
        });
        res.end(body);
    }
    catch {
        // swallow-ok: the client may already have closed the response
    }
}
/**
 * Create the proxy. `resolveHost` is the single pivot: it returns the loopback target for one
 * connected host (`{ localPort, remotePort }`) or null. Nothing else in this module knows how a
 * tunnel was made.
 */
export function createRemoteProxy(options) {
    const logger = options.logger ?? console;
    const webServer = options.webServer;
    const getOrigin = options.getOrigin;
    const resolveHost = options.resolveHost;
    // Annotated because the default below must answer like the real gate: the kernel may not
    // provide the Connection service at all, and a missing gate admits the request.
    const admit = typeof options.admit === 'function' ? options.admit : () => undefined;
    const onUpstreamError = options.onUpstreamError;
    const upstreamTimeoutMs = Number.isSafeInteger(options.upstreamTimeoutMs) && options.upstreamTimeoutMs > 0
        ? options.upstreamTimeoutMs
        : UPSTREAM_TIMEOUT_MS;
    const jars = new Map();
    const upgrades = new Map();
    const sockets = new Set();
    let disposed = false;
    /** Report one failed upstream without letting the reporter break the proxy. */
    function reportUpstreamFailure(hostId) {
        try {
            onUpstreamError?.(hostId);
        }
        catch {
            // swallow-ok: reporting only feeds the liveness confirmation, it must never fail a request
        }
    }
    /**
     * The per-host cookie jar is bound to the remote authority it was filled from: after a
     * restart or a re-attach the remote comes back on a new random port, and cookies issued
     * by the old instance must not be sent to the new one (nor kept after the host is gone).
     */
    function jarOf(hostId, target) {
        const authority = remoteAuthority(target);
        let entry = jars.get(hostId);
        if (entry === undefined || entry.authority !== authority) {
            entry = { authority, jar: createCookieJar() };
            jars.set(hostId, entry);
        }
        return entry.jar;
    }
    function localOrigin() {
        try {
            const origin = getOrigin();
            return typeof origin === 'string' && origin !== '' ? new URL(origin) : null;
        }
        catch {
            return null;
        }
    }
    function targetOf(hostId) {
        try {
            const target = resolveHost(hostId);
            return target && Number.isInteger(Number(target.localPort)) && Number(target.localPort) > 0 ? target : null;
        }
        catch {
            return null;
        }
    }
    function handle(req, res) {
        if (disposed) {
            plain(res, 503, 'proxy disposed');
            return;
        }
        // DSH's own admission gate runs before anything this module decides: the proxy reaches a
        // connected host's remote session (its cookie jar), so only an admitted caller may use it.
        const rejection = admit(req);
        if (rejection !== undefined) {
            plain(res, rejection, 'request rejected by DSH admission');
            return;
        }
        const origin = localOrigin();
        if (origin === null) {
            plain(res, 503, 'local origin is not ready');
            return;
        }
        if (!trustedRequest(req, origin)) {
            plain(res, 403, 'cross-site request rejected');
            return;
        }
        let pathname;
        let search;
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            pathname = url.pathname;
            search = url.search;
        }
        catch {
            plain(res, 400, 'bad request path');
            return;
        }
        const parsed = parseViewPath(pathname);
        if (parsed === null) {
            plain(res, 404, 'unknown remote view');
            return;
        }
        const target = targetOf(parsed.hostId);
        if (target === null) {
            plain(res, 404, 'host is not connected');
            return;
        }
        const jar = jarOf(parsed.hostId, target);
        const upstreamPath = parsed.path + search;
        const headers = upstreamHeaders(req.rawHeaders, {
            target,
            localOrigin: origin.origin,
            path: parsed.path,
            jar,
        });
        // The remote is reached over a tunnel; a listener that accepts and never answers used to
        // hang the local request forever. The deadline covers the wait for response headers only —
        // once the response started, an idle stream (SSE, a large asset) is legitimate.
        let answered = false;
        let failed = false;
        const upstream = http.request({
            host: '127.0.0.1',
            port: target.localPort,
            path: upstreamPath,
            method: req.method,
            headers,
            timeout: upstreamTimeoutMs,
        }, (response) => {
            answered = true;
            upstream.setTimeout(0);
            storeCookies(jar, response.headers['set-cookie']);
            try {
                res.writeHead(response.statusCode ?? 502, responseHeaders(response.rawHeaders, {
                    hostId: parsed.hostId,
                    remoteOrigin: remoteOrigin(target),
                }));
            }
            catch {
                response.destroy();
                return;
            }
            // A browser that leaves the page mid-load must not keep the tunneled response alive.
            res.once('close', () => response.destroy());
            response.pipe(res);
        });
        /**
         * One failed upstream: report it once and answer 502 (or nothing, when the response has
         * already started). Nothing from the failure reaches the log line: the emitter is
         * request-driven, so CodeQL treats its error as user-controlled (log injection). The
         * loopback port names the host to an operator, and the browser only ever sees the 502.
         */
        const upstreamFailed = () => {
            if (failed)
                return;
            failed = true;
            logger.debug?.(`[dsh-remote-go] remote proxy upstream 127.0.0.1:${target.localPort} failed`);
            plain(res, 502, 'remote UI is unreachable');
            reportUpstreamFailure(parsed.hostId);
        };
        upstream.on('timeout', () => {
            if (answered)
                return;
            answered = true;
            upstream.destroy();
            upstreamFailed();
        });
        upstream.on('error', () => {
            // A failure after the response started is still worth reporting (the Host confirms it
            // with probes); `plain` is a no-op once the headers are out.
            upstreamFailed();
        });
        req.once('aborted', () => upstream.destroy());
        req.pipe(upstream);
    }
    /** One exact upgrade route per host: the only WebSocket a DSH web serves is its stream mux. */
    function handleUpgrade(hostId, req, socket, head) {
        if (disposed) {
            socket.destroy();
            return;
        }
        const rejection = admit(req);
        if (rejection !== undefined) {
            // An upgrade owns its socket: answer the handshake with the status, then close it.
            socket.on('error', () => { });
            socket.end(`HTTP/1.1 ${rejection} ${http.STATUS_CODES[rejection] ?? 'Rejected'}\r\n` +
                'connection: close\r\ncontent-length: 0\r\n\r\n');
            return;
        }
        const origin = localOrigin();
        if (origin === null || !trustedRequest(req, origin)) {
            socket.destroy();
            return;
        }
        const target = targetOf(hostId);
        if (target === null) {
            socket.destroy();
            return;
        }
        // A malformed request target (absolute-form, broken escape) must not throw out of the upgrade
        // handler: the HTTP path already degrades to a 400, this one just drops the socket.
        let parsed = null;
        try {
            parsed = parseViewPath(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        }
        catch {
            parsed = null;
        }
        if (parsed === null) {
            socket.destroy();
            return;
        }
        const jar = jarOf(hostId, target);
        const headers = upstreamHeaders(req.rawHeaders, {
            target,
            localOrigin: origin.origin,
            path: parsed.path,
            jar,
            preserveUpgrade: true,
        });
        let raw = `${req.method} ${parsed.path} HTTP/1.1\r\n`;
        for (const [name, value] of Object.entries(headers)) {
            for (const item of Array.isArray(value) ? value : [value])
                raw += `${name}: ${item}\r\n`;
        }
        raw += '\r\n';
        const upstream = net.connect({ port: target.localPort, host: '127.0.0.1', timeout: upstreamTimeoutMs });
        // An upgrade owns its socket, so the deadline covers the handshake only: an upstream that
        // accepts and never answers would otherwise leave both sockets dangling forever.
        let settled = false;
        const handshakeTimer = setTimeout(() => failUpgrade(), upstreamTimeoutMs);
        handshakeTimer.unref?.();
        function failUpgrade() {
            clearTimeout(handshakeTimer);
            if (settled)
                return;
            settled = true;
            upstream.destroy();
            socket.destroy();
            reportUpstreamFailure(hostId);
        }
        sockets.add(socket);
        // The upstream's response head is filtered before the browser sees it: a 101 used to be
        // forwarded byte-for-byte, which also handed the remote's `Set-Cookie` and policy headers to
        // the local origin. Only the head is parsed; everything after it streams untouched.
        let upstreamHead = Buffer.alloc(0);
        let headForwarded = false;
        const writeToClient = (chunk) => {
            if (!socket.write(chunk))
                upstream.pause();
        };
        const forwardUpstreamData = (chunk) => {
            if (settled)
                return;
            clearTimeout(handshakeTimer);
            upstream.setTimeout(0);
            if (headForwarded) {
                writeToClient(chunk);
                return;
            }
            upstreamHead = upstreamHead.length === 0 ? Buffer.from(chunk) : Buffer.concat([upstreamHead, chunk]);
            if (upstreamHead.length > MAX_UPSTREAM_HEAD_BYTES) {
                // Nothing legitimate answers a handshake with a head this large.
                failUpgrade();
                return;
            }
            const end = upstreamHead.indexOf('\r\n\r\n');
            if (end === -1)
                return;
            const filtered = filterResponseHead(upstreamHead.subarray(0, end).toString('latin1'), {
                hostId,
                remoteOrigin: remoteOrigin(target),
            });
            if (filtered === '') {
                failUpgrade();
                return;
            }
            headForwarded = true;
            writeToClient(`${filtered}\r\n`);
            const rest = upstreamHead.subarray(end + 4);
            upstreamHead = Buffer.alloc(0);
            if (rest.length > 0)
                writeToClient(rest);
        };
        upstream.on('data', forwardUpstreamData);
        socket.on('drain', () => upstream.resume());
        upstream.on('timeout', () => failUpgrade());
        upstream.on('error', () => failUpgrade());
        /**
         * The remote ended the stream. `upstream.pipe(socket)` used to forward that EOF implicitly;
         * the head is parsed here, so the end of the upstream must still close the browser side or
         * the page would hold a dead socket forever.
         */
        const endClient = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(handshakeTimer);
            try {
                socket.end();
            }
            catch { }
        };
        upstream.on('end', endClient);
        upstream.on('close', endClient);
        socket.once('close', () => {
            settled = true;
            clearTimeout(handshakeTimer);
            sockets.delete(socket);
            upstream.destroy();
        });
        socket.on('error', () => {
            settled = true;
            clearTimeout(handshakeTimer);
            upstream.destroy();
        });
        upstream.once('connect', () => {
            if (settled)
                return;
            upstream.write(raw);
            if (head && head.length > 0)
                upstream.write(head);
            socket.pipe(upstream);
        });
    }
    /**
     * Keep one upgrade route per configured host. Called on init and on every state change; a host
     * that disappears loses its route and its cookies.
     */
    function sync(hostIds) {
        if (disposed)
            return;
        const wanted = new Set((Array.isArray(hostIds) ? hostIds : []).filter((id) => HOST_ID_PATTERN.test(String(id))));
        for (const [hostId, dispose] of upgrades) {
            if (wanted.has(hostId))
                continue;
            dispose();
            upgrades.delete(hostId);
            jars.delete(hostId);
        }
        for (const hostId of wanted) {
            if (upgrades.has(hostId))
                continue;
            try {
                upgrades.set(hostId, webServer.registerUpgrade({
                    path: upgradePath(hostId),
                    handler: (req, socket, head) => handleUpgrade(hostId, req, socket, head),
                }));
            }
            catch (error) {
                logger.warn?.(`[dsh-remote-go] could not register the stream route for ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return {
        prefix: REMOTE_VIEW_PREFIX,
        /**
         * The route registration path. The web server matches a prefix as `pathname === prefix ||
         * pathname.startsWith(prefix + '/')`, so registering the trailing-slash seat prefix verbatim
         * would never match a real view URL.
         */
        routePath: REMOTE_VIEW_PREFIX.replace(/\/$/, ''),
        handle,
        handleUpgrade,
        sync,
        /** One host's current cookie header, for diagnostics and tests. */
        cookies(hostId) {
            const entry = jars.get(hostId);
            return entry === undefined ? '' : cookieHeader(entry.jar, '/');
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            for (const dispose of upgrades.values())
                dispose();
            upgrades.clear();
            jars.clear();
            for (const socket of sockets)
                socket.destroy();
            sockets.clear();
        },
    };
}
