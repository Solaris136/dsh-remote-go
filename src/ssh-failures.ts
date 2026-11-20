/** SSH failure classification: the one place that turns a transport failure into the coded, bilingual error the Client
 * renders; both adapters share it, so "which code and which sentence" has one answer. The table pins three details:
 * `network`/`auth` are retryable but `host-key-changed` is not, `exec` deadlines are results (`timedOut`) never
 * exceptions, and a coded error passes through. */
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

/** The three message shapes the rules below recognise, in the order they are tried. */
const HOST_KEY_MESSAGE = /host key|hostkey|verification/i
const AUTH_MESSAGE = /authentication|All configured authentication methods failed|Permission denied/i
const TRANSPORT_MESSAGE =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed out|timeout|Cannot connect|connect failed/i

/** The typed "the transport is gone" failure: retryable network, never a bare internal error. The wording and the
 * `reason=ssh-closed` technical string are frozen: `exec`, `forwardOut` and the SFTP entry points have raised this
 * exact sentence since the first release, and callers (plus tests) match on it. */
export function closedError(): RemoteGoError {
  return errors.network(
    {
      zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
      en: 'SSH connection is not open; the transport closed before this step finished.',
    },
    { technical: 'reason=ssh-closed' },
  )
}

/** The host-key failure an adapter reports when it has no more specific factory to call. */
function hostKeyFailure(context: SshFailureContext): RemoteGoError {
  const endpoint = `${context.host ?? 'the host'}:${context.port ?? 22}`
  return errors.network({
    zh: `主机密钥校验未通过（${endpoint}）。`,
    en: `Host key verification failed for ${endpoint}.`,
  })
}

function failureOfKind(kind: SshFailureKind, context: SshFailureContext): RemoteGoError {
  if (kind === 'closed') return closedError()
  if (kind === 'auth') return errors.auth()
  if (kind === 'hostkey') return hostKeyFailure(context)
  // `transport` and `timeout` are the same client-visible failure: a retryable network error. The timeout
  // row only lets an adapter label a handshake deadline without inventing a second sentence for it.
  return errors.network()
}

/** Turn any thrown value into the error the contract may expose. The order decides: an already-coded error passes
 * through, then an explicit `kind` wins over the message, then host-key, auth, transport, and anything left becomes
 * `network` naming `headTail(message, 300)`. */
export function classifySshFailure(error: unknown, context: SshFailureContext = {}): RemoteGoError {
  if (error instanceof RemoteGoError) return error
  if (context.kind !== undefined) return failureOfKind(context.kind, context)
  if (!error) return errors.internal('unknown ssh error')
  // A thrown value is `unknown`: the `as` restates the two fields a node/ssh2 transport error carries.
  const message = String((error as { message?: unknown }).message ?? error)
  const code = String((error as { code?: unknown }).code ?? '')
  if (HOST_KEY_MESSAGE.test(message)) return hostKeyFailure(context)
  if (AUTH_MESSAGE.test(message)) return errors.auth()
  if (TRANSPORT_MESSAGE.test(`${code} ${message}`)) return errors.network()
  return errors.network({
    zh: `SSH 连接失败：${headTail(message, 300)}`,
    en: `SSH connection failed: ${headTail(message, 300)}`,
  })
}

/** The historical name for {@link classifySshFailure}; an alias, not a copy, so the two cannot drift. */
export function toSshError(error: unknown, host: string, port: number): RemoteGoError {
  return classifySshFailure(error, { host, port })
}

/** Whether one thrown value is a host-key refusal: `connect()` must rethrow it, not try the next credential. */
export function isHostKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'host-key-changed' || code === 'host-key-unknown'
}
