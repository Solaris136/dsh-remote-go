/**
 * SSH failure classification: the one place that turns a transport failure into the coded,
 * bilingual error the Client renders (decision D2).
 *
 * Both adapters share it — the ssh2 one and the test double — so "which code and which sentence
 * does this failure produce" has exactly one answer. The client-visible wording comes from
 * `errors.ts`; this module only decides *which* factory applies, which is why extracting it keeps
 * the text byte-for-byte identical to the pre-P5 `toSshError`.
 *
 * The three details the table pins and that must not be "simplified" away:
 *   - `errors.network` is retryable for connection failures, `errors.auth` too, and
 *     `host-key-changed` is not — that row decides whether the Client offers "Retry";
 *   - `exec` timeouts are **results** (`SshExecResult.timedOut`), never exceptions, so no timeout
 *     factory is called from the exec path;
 *   - a `RemoteGoError` that already reached us is the contract's own failure and is passed
 *     through untouched (the host-key factories build theirs directly).
 */
import { errors, RemoteGoError } from './errors.js'
import type { SshFailureKind } from './ssh-port.js'
import { headTail } from './util.js'

/** What the classifier knows about the failure beyond the thrown value itself. */
export interface SshFailureContext {
  host?: string
  port?: number
  /** The adapter's own label; when present it wins over the message/code heuristics. */
  kind?: SshFailureKind
}

/**
 * The typed "the transport is gone" failure: retryable network, never a bare internal error.
 *
 * The wording and the `reason=ssh-closed` technical string are frozen: `exec`, `forwardOut` and
 * the SFTP entry points have raised exactly this sentence since the first release, and callers
 * (plus tests) match on it.
 */
export function closedError(): RemoteGoError {
  return errors.network(
    {
      zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
      en: 'SSH connection is not open; the transport closed before this step finished.',
    },
    { technical: 'reason=ssh-closed' },
  )
}

/** The endpoint a host-key failure names in its sentence. */
function endpointOf(context: SshFailureContext): string {
  const host = context.host ?? 'the host'
  const port = context.port ?? 22
  return `${host}:${port}`
}

/** The host-key failure an adapter reports when it has no more specific factory to call. */
function hostKeyFailure(context: SshFailureContext): RemoteGoError {
  const endpoint = endpointOf(context)
  return errors.network({
    zh: `主机密钥校验未通过（${endpoint}）。`,
    en: `Host key verification failed for ${endpoint}.`,
  })
}

/** The factory one explicit kind maps to; see the table in design-ssh §5. */
function failureOfKind(kind: SshFailureKind, context: SshFailureContext): RemoteGoError {
  if (kind === 'closed') return closedError()
  if (kind === 'auth') return errors.auth()
  if (kind === 'hostkey') return hostKeyFailure(context)
  // `transport` and `timeout` are the same client-visible failure: a retryable network error.
  // The timeout row exists so an adapter can label a handshake deadline without inventing a
  // second sentence for it (an `exec` deadline never reaches this function at all).
  return errors.network()
}

/**
 * Turn any thrown value into the error the contract may expose.
 *
 * Rules, in order (each one is the pre-P5 `toSshError` rule, unchanged):
 *   1. an already-coded `RemoteGoError` passes through;
 *   2. an explicit `kind` chooses the factory without inspecting the message;
 *   3. a host-key-looking message → network with the host-key sentence;
 *   4. an authentication-looking message → `auth`;
 *   5. a connection/timeout code or message → default `network`;
 *   6. anything else → `network` with `SSH 连接失败：<headTail(message, 300)>`.
 *
 * @param error - the thrown value; `unknown` because every caller catches one.
 * @param context - the endpoint (for the sentence) and the adapter's optional kind label.
 * @returns the coded error; never throws.
 */
export function classifySshFailure(error: unknown, context: SshFailureContext = {}): RemoteGoError {
  if (error instanceof RemoteGoError) return error
  if (context.kind !== undefined) return failureOfKind(context.kind, context)
  if (!error) return errors.internal('unknown ssh error')
  // A thrown value is `unknown`: the `as` restates the two fields a node/ssh2 transport error
  // carries, and the `??` fallbacks keep a thrown string working.
  const message = String((error as { message?: unknown }).message ?? error)
  const code = String((error as { code?: unknown }).code ?? '')
  if (/host key|hostkey|verification/i.test(message)) return hostKeyFailure(context)
  if (/authentication|All configured authentication methods failed|Permission denied/i.test(message)) {
    return errors.auth()
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed out|timeout|Cannot connect|connect failed/i.test(
      `${code} ${message}`,
    )
  ) {
    return errors.network()
  }
  return errors.network({
    zh: `SSH 连接失败：${headTail(message, 300)}`,
    en: `SSH connection failed: ${headTail(message, 300)}`,
  })
}

/**
 * The historical name for {@link classifySshFailure}.
 *
 * It stays an alias (not a copy) so the two can never drift: callers/tests that have always
 * imported `toSshError(error, host, port)` keep working, and there is exactly one rule table.
 * @param error - the thrown value.
 * @param host - the endpoint the failure is about.
 * @param port - the endpoint's port.
 */
export function toSshError(error: unknown, host: string, port: number): RemoteGoError {
  return classifySshFailure(error, { host, port })
}

/**
 * Whether one thrown value is one of the two host-key refusals.
 *
 * `connect()`'s auth-candidate loop must rethrow these instead of trying the next credential: a
 * rejected key is a policy decision, not an authentication failure.
 * @param error - the thrown value.
 */
export function isHostKeyError(error: unknown): boolean {
  // Same narrowing as the classifier: a thrown value is `unknown`, and only its `code` is read.
  const code = (error as { code?: unknown } | null)?.code
  return code === 'host-key-changed' || code === 'host-key-unknown'
}
