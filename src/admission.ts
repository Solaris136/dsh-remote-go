/** DSH's own admission for the routes this plugin serves: `Host`/`Origin` fence plus browser authentication against a
 * live Peer. Read through `kernel-adapter.ts`: `ok` decides, `absent` hands over to the caller's fence, `changed` is
 * 500 — a check that cannot decide must never admit. */
import { createKernelAdapter } from './kernel-adapter.js'
export interface AdmissionRequest {
  headers: Record<string, string | string[] | undefined>
}
export interface AdmissionContext {
  get?: (name: string) => unknown
}
export interface AdmissionLogger {
  warn?: (...args: unknown[]) => void
}
export type Admission = (req: AdmissionRequest) => number | undefined

export function createAdmission(ctx: AdmissionContext, logger: AdmissionLogger = console): Admission {
  const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {}
  const kernel = createKernelAdapter(ctx)

  return (req) => {
    const result = kernel.requestRejection(req)
    if (result.state === 'ok') return result.value ?? undefined
    if (result.state === 'absent') {
      if (result.reason === 'lookup-failed') {
        warn('[dsh-remote-go] DSH connection lookup failed; the local fence stays the only gate:', result.detail)
      }
      return undefined
    }
    warn('[dsh-remote-go] DSH connection admission failed; rejecting the request:', result.detail)
    return 500
  }
}
