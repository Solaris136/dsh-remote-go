/**
 * The browser-trust fence shared by the local HTTP API and the same-origin remote proxy.
 *
 * Both surfaces answer on the local DSH origin, so both must give the same answer to one question:
 * did this request arrive from the origin it names? Two confused-deputy paths reach a loopback web
 * server — DNS rebinding and a cross-site page — and a browser labels neither reliably: a rebound
 * page sends its own hostname as `Host` while the socket lands on this server, and a plain
 * navigation or image read carries no `Origin` and no Fetch-Metadata. `Host` is the one header
 * rebinding cannot forge, so it is checked for every request; when a browser does attach `Origin`
 * or `sec-fetch-site`, they must agree too.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** The port a URL actually names, counting an omitted default port. */
function effectivePort(url) {
    if (url.port !== '')
        return url.port;
    return url.protocol === 'https:' ? '443' : '80';
}
/**
 * Hostname/port match for a `Host` header (which carries no scheme). The suffix is the local
 * listener's origin; loopback spellings are interchangeable because a browser may dial either one.
 */
export function sameServerHost(value, origin) {
    if (typeof value !== 'string' || value === '')
        return false;
    let candidate;
    try {
        candidate = new URL(`${origin.protocol}//${value}`);
    }
    catch {
        return false;
    }
    // WHATWG parsing rewrites anything that is not a bare authority: `user@host` drops its userinfo,
    // a backslash becomes a path separator, `#`/`?` start the fragment/query, and a trailing dot or a
    // zero-padded port is normalized away. A browser fills `Host` from the serialized URL, so a value
    // the parser had to rewrite is not an authority this server answers to; comparing the rewritten
    // hostname would let `attacker.example@127.0.0.1:port` pass as loopback.
    if (candidate.host !== value.toLowerCase())
        return false;
    if (effectivePort(candidate) !== effectivePort(origin))
        return false;
    if (candidate.hostname === origin.hostname)
        return true;
    return LOOPBACK_HOSTNAMES.has(origin.hostname) && LOOPBACK_HOSTNAMES.has(candidate.hostname);
}
/**
 * Full same-origin match for an `Origin` header (scheme included).
 *
 * The authority is compared verbatim (case-insensitively) as well as through `sameServerHost`.
 * A browser fills `Origin` from the serialized URL, so anything the URL parser had to rewrite —
 * `user@host`, a trailing dot, a zero-padded port — cannot have come from one, and letting the
 * rewritten form through would accept `http://attacker.example@127.0.0.1:port` as loopback.
 */
export function sameServerOrigin(value, origin) {
    if (typeof value !== 'string' || value === '')
        return false;
    // One trailing slash is tolerated (`Origin: http://host/` is not what a browser sends, but a
    // hand-written caller may); no regex on this string, it is attacker-controlled.
    const text = value.endsWith('/') ? value.slice(0, -1) : value;
    let candidate;
    try {
        candidate = new URL(text);
    }
    catch {
        return false;
    }
    // Drop the scheme without a regex: `scheme://rest` is the only shape left after URL parsing.
    const schemeEnd = text.indexOf('://');
    const authority = schemeEnd === -1 ? '' : text.slice(schemeEnd + 3);
    if (authority.toLowerCase() !== candidate.host)
        return false;
    return candidate.protocol === origin.protocol && sameServerHost(candidate.host, origin);
}
/**
 * The fence applied to a browser navigation and its subresources: the request must name this
 * server, and any browser-announced relationship must be same-origin.
 */
export function trustedRequest(req, origin) {
    if (!sameServerHost(req.headers.host, origin))
        return false;
    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader !== '' && !sameServerOrigin(originHeader, origin))
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    return true;
}
