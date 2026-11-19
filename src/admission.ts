/**
 * DSH's own admission for the routes this plugin serves.
 *
 * The kernel decides whether a request may reach a Host feature at all: its `Host`/`Origin` fence
 * plus browser authentication against a live Peer (`ctx.connection.requestRejection`). This module
 * is the one place that turns that service into a per-request function, so the local API and the
 * same-origin proxy share the gate and both failure modes stay testable.
 *
 * The service itself is read through `kernel-adapter.ts`, which reports the three states this gate
 * has to treat differently: `ok` lets the kernel decide, `absent` hands the request to the caller's
 * own fence (exactly like a kernel that never had the service), and `changed` — a moved member, a
 * judgement that throws, a verdict that is not a status — is **rejected with 500**. A check that
 * cannot decide must never admit (invariant B9).
 */
import { createKernelAdapter } from './kernel-adapter.js'

/** The part of one request the kernel's admission reads; an `IncomingMessage` satisfies it as is. */
export interface AdmissionRequest {
  headers: Record<string, string | string[] | undefined>
}

/** The plugin context; only the untyped service lookup is read, and a test may omit it entirely. */
export interface AdmissionContext {
  get?: (name: string) => unknown
}

/** A logger with a `warn`, as `console` and the Host half's logger both are. */
export interface AdmissionLogger {
  warn?: (...args: unknown[]) => void
}

/** One request's verdict: the status to reject with, or `undefined` to admit it. */
export type Admission = (req: AdmissionRequest) => number | undefined

/**
 * Build the admission gate for one plugin activation.
 *
 * `connection` is optional and has to be read through `ctx.get`: Cordis throws when a plugin reads
 * a service its fiber did not inject, and an older kernel may not provide the service at all. In
 * both cases the gate returns `undefined`, which hands the request to the caller's own fence
 * instead of going dark. A gate that cannot judge the request returns `500` — failing closed,
 * because a check that cannot decide must never admit.
 * @param ctx - the plugin context (only `get` is read, and a test passes a fake).
 * @param logger - the warning sink; a lookup failure is warned, a missing optional service is not.
 * @returns the per-request gate.
 */
export function createAdmission(ctx: AdmissionContext, logger: AdmissionLogger = console): Admission {
  const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {}
  const kernel = createKernelAdapter(ctx)

  return (req) => {
    const result = kernel.requestRejection(req)
    if (result.state === 'ok') return result.value ?? undefined
    if (result.state === 'absent') {
      // A lookup that threw is worth a warning (the plugin may be running against a kernel whose
      // reflection moved); a service this composition never had is the documented fallback.
      if (result.reason === 'lookup-failed') {
        warn('[dsh-remote-go] DSH connection lookup failed; the local fence stays the only gate:', result.detail)
      }
      return undefined
    }
    warn('[dsh-remote-go] DSH connection admission failed; rejecting the request:', result.detail)
    return 500
  }
}
