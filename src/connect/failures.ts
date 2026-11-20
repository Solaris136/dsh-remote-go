/** One classification for a failed connect step: a step that raced the transport going away must read as a dropped connection (network, retryable), never as a bare internal error or as a key decision the user never made. */
import { errors, RemoteGoError, toErrorView } from '../errors.js'
import type { ErrorView } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import type { BilingualText } from '../util.js'

type ThrownError = { message?: unknown }

/** The bilingual detail of "the transport this step needed is gone". */
export const SSH_CLOSED_DETAIL: BilingualText = {
  zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
  en: 'SSH connection is not open; the transport closed before this step finished. Reconnect to continue.',
}

/** Classify a pipeline failure, so a step that raced the transport away reads as a dropped connection rather than a key decision the user never made. */
export function normalizeConnectFailure(runtime: HostRuntime, error: ThrownError | null): ErrorView {
  const view = toErrorView(error)
  if (runtime.transportLost === true && runtime.ssh?.connected !== true) {
    if (view.code === 'host-key-unknown' || view.code === 'remote-dsh-running') {
      return toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: `reason=ssh-closed phase-code=${view.code}` }))
    }
  }
  if (runtime.ssh?.connected === true) {
    if (
      !(error instanceof RemoteGoError) &&
      /\b(?:not open|closed|ECONNRESET|EPIPE|Channel closed)\b/i.test(String(error?.message ?? ''))
    ) {
      return toErrorView(
        errors.network(SSH_CLOSED_DETAIL, { technical: `reason=ssh-closed cause=${error?.message ?? error}` }),
      )
    }
    return view
  }
  if (view.code === 'internal' || view.code === 'remote-dsh-missing' || view.code === 'remote-node-install-failed') {
    return toErrorView(
      errors.network(SSH_CLOSED_DETAIL, {
        technical: `reason=ssh-closed phase-code=${view.code} cause=${error instanceof Error ? error.message : String(error ?? '')}`,
      }),
    )
  }
  return view
}
