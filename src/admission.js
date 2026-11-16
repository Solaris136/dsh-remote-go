/**
 * DSH's own admission for the routes this plugin serves.
 *
 * The kernel decides whether a request may reach a Host feature at all: its `Host`/`Origin` fence
 * plus browser authentication against a live Peer (`ctx.connection.requestRejection`). This module
 * is the one place that turns that service into a per-request function, so the local API and the
 * same-origin proxy share the gate and both failure modes stay testable.
 */

/**
 * Build the admission gate for one plugin activation.
 *
 * `connection` is optional and has to be read through `ctx.get`: Cordis throws when a plugin reads
 * a service its fiber did not inject, and an older kernel may not provide the service at all. In
 * both cases the gate returns `undefined`, which hands the request to the caller's own fence
 * instead of going dark. A gate that throws while judging a request returns `500` — failing closed,
 * because a check that cannot decide must never admit.
 *
 * @param {object} ctx - plugin context; only `ctx.get` is read, and it may be missing in tests.
 * @param {{ warn?: (...args: any[]) => void }} [logger]
 * @returns {(req: { headers: object }) => (number | undefined)} rejection status, or undefined to admit.
 */
export function createAdmission(ctx, logger = console) {
  const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {}

  return (req) => {
    let connection = null
    try {
      connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null
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
