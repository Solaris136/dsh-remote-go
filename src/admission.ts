/**
 * DSH's own admission for the routes this plugin serves.
 *
 * The kernel decides whether a request may reach a Host feature at all: its `Host`/`Origin` fence
 * plus browser authentication against a live Peer (`ctx.connection.requestRejection`). This module
 * is the one place that turns that service into a per-request function, so the local API and the
 * same-origin proxy share the gate and both failure modes stay testable.
 */

/** The part of one request the kernel's admission reads; an `IncomingMessage` satisfies it as is. */
export interface AdmissionRequest {
  headers: Record<string, string | string[] | undefined>
}

/**
 * The `connection` service, narrowed to the one member this gate calls.
 *
 * The lookup itself is the kernel's untyped reflection (`ctx.get`), so this declares the minimum
 * shape the gate uses and nothing else: a kernel that has the service but no admission member
 * degrades to the caller's own fence, exactly like one that has no service at all.
 */
export interface ConnectionAdmission {
  requestRejection?: (req: AdmissionRequest) => number
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
 * instead of going dark. A gate that throws while judging a request returns `500` — failing closed,
 * because a check that cannot decide must never admit.
 */
export function createAdmission(ctx: AdmissionContext, logger: AdmissionLogger = console): Admission {
  const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {}

  return (req) => {
    let connection: ConnectionAdmission | null = null
    try {
      // `ctx.get` is the kernel's untyped lookup: this one assertion names the shape the gate
      // calls, and the `typeof` check below re-verifies the only member it reads before use.
      connection = typeof ctx?.get === 'function' ? (ctx.get('connection') as ConnectionAdmission | null) : null
    } catch (error) {
      // A failed lookup says nothing about this request, so the caller's own fence decides it.
      warn('[dsh-remote-go] DSH connection lookup failed; the local fence stays the only gate:', error)
      return undefined
    }
    if (!connection || typeof connection.requestRejection !== 'function') return undefined
    try {
      return connection.requestRejection(req)
    } catch (error) {
      warn('[dsh-remote-go] DSH connection admission failed; rejecting the request:', error)
      return 500
    }
  }
}
