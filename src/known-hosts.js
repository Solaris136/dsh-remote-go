/**
 * Read-only `~/.ssh/known_hosts` parsing and OpenSSH SHA256 fingerprints; hashed entries are counted, never guessed at.
 */
import { createHash } from 'node:crypto';
export function fingerprintFromBase64(keyBase64) {
    const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64');
    return `SHA256:${digest.replace(/=+$/g, '')}`;
}
export function fingerprintFromBlob(keyBlob) {
    const digest = createHash('sha256').update(keyBlob).digest('base64');
    return `SHA256:${digest.replace(/=+$/g, '')}`;
}
export function parseKnownHosts(text) {
    const entries = [];
    const malformed = [];
    let hashedCount = 0;
    let revoked = 0;
    let certAuthority = 0;
    const lines = String(text ?? '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const lineNo = index + 1;
        const raw = lines[index].trim();
        if (raw === '' || raw.startsWith('#'))
            continue;
        const parts = raw.split(/\s+/);
        let marker = null;
        if (parts[0].startsWith('@'))
            marker = parts.shift() ?? null;
        if (parts.length < 3) {
            malformed.push({ line: lineNo, text: raw });
            continue;
        }
        const [hostField, keyType, keyBase64] = parts;
        if (marker === '@revoked') {
            revoked += 1;
            continue;
        }
        if (marker === '@cert-authority') {
            certAuthority += 1;
            continue;
        }
        if (hostField.startsWith('|1|')) {
            hashedCount += 1;
            continue;
        }
        if (!/^[A-Za-z0-9+/=]+$/.test(keyBase64 ?? '')) {
            malformed.push({ line: lineNo, text: raw });
            continue;
        }
        entries.push({
            hosts: hostField.split(',').filter(Boolean),
            keyType,
            keyBase64,
            fingerprint: fingerprintFromBase64(keyBase64),
            marker,
            line: lineNo,
        });
    }
    return { entries, hashedCount, malformed, revoked, certAuthority };
}
/**
 * OpenSSH `known_hosts` host-field matching: `*` matches any run of characters, `?` exactly
 * one, everything else is literal and the comparison ignores case.
 *
 * Implemented without a regular expression on purpose: a host field is data, and building a
 * `RegExp` from it invites injection and backtracking on remote-controlled text.
 */
function wildcardMatch(pattern, value) {
    const wanted = String(pattern).toLowerCase();
    const text = String(value).toLowerCase();
    let patternAt = 0;
    let textAt = 0;
    let starAt = -1;
    let markAt = 0;
    while (textAt < text.length) {
        if (patternAt < wanted.length && (wanted[patternAt] === '?' || wanted[patternAt] === text[textAt])) {
            patternAt += 1;
            textAt += 1;
        }
        else if (patternAt < wanted.length && wanted[patternAt] === '*') {
            starAt = patternAt;
            patternAt += 1;
            markAt = textAt;
        }
        else if (starAt >= 0) {
            patternAt = starAt + 1;
            textAt = markAt + 1;
            markAt = textAt;
        }
        else {
            return false;
        }
    }
    while (patternAt < wanted.length && wanted[patternAt] === '*')
        patternAt += 1;
    return patternAt === wanted.length;
}
/**
 * Whether one `known_hosts` host field covers `host` on `port`.
 *
 * OpenSSH writes a plain `host` field only for port 22 and `[host]:port` for every other
 * port, and it matches the same way: a plain entry never vouches for a service on 2222.
 */
export function knownHostFieldMatches(pattern, host, port) {
    const targetPort = Number(port) || 22;
    const target = targetPort === 22 ? String(host) : `[${host}]:${targetPort}`;
    return wildcardMatch(pattern, target);
}
export function findKnownHostEntries(parsed, host, port) {
    return parsed.entries.filter((entry) => entry.hosts.some((pattern) => knownHostFieldMatches(pattern, host, port)));
}
export function summarizeKnownHosts(parsed) {
    const hosts = new Set();
    for (const entry of parsed.entries) {
        for (const host of entry.hosts) {
            if (!host.startsWith('|1|'))
                hosts.add(host);
        }
    }
    return {
        entries: parsed.entries.length,
        hashed: parsed.hashedCount,
        hosts: [...hosts].sort().slice(0, 200),
    };
}
