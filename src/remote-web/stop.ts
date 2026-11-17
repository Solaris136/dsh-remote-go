/**
 * Stopping a remote DSH web instance: resolve the pid to signal (explicit, run registry, then the
 * readiness line's port owner), terminate it and drop `run/web.json` only after the stop is
 * confirmed. A failed stop keeps the record, so the next connect still adopts the surviving
 * process instead of starting a second one beside it (M4).
 */
import type { RemoteLayout } from '../layout.js'
import { remotePortOwnerPid } from '../remote-proc.js'
import type { SshTransport } from '../ssh.js'
import { isPid, messageOf, shellQuote } from '../util.js'
import { readRunRegistry } from './registry.js'
import { readWebLineFromLog } from './resolve.js'

/** What a stop reports: confirmed, or why it was not. */
export interface StopRemoteWebResult {
  ok: boolean
  reason?: string
  output: string
}

/**
 * The pid a readiness line in the log belongs to, as a last resort for a stop whose pid is
 * unknown. The log only names the port; `/proc` proves which process listens on it (M4).
 */
async function pidFromReadinessLine(ssh: SshTransport, layout: RemoteLayout): Promise<number> {
  const line = await readWebLineFromLog(ssh, layout)
  if (!line || !isPid(line.port)) return 0
  const owner = await remotePortOwnerPid(ssh, line.port)
  return isPid(Number(owner)) ? Number(owner) : 0
}

export async function stopRemoteWeb(
  ssh: SshTransport,
  layout: RemoteLayout,
  options: { pid?: unknown } = {},
): Promise<StopRemoteWebResult> {
  let pid = Number(options.pid ?? 0)
  if (!isPid(pid)) {
    // The run registry is the primary record; a partially written one still names a pid, and
    // the readiness line's port owner is the last resort (M4).
    const registry = await readRunRegistry(ssh, layout)
    pid = Number(registry?.pid ?? 0)
  }
  if (!isPid(pid)) pid = await pidFromReadinessLine(ssh, layout)
  // The registry is removed only after the stop is confirmed: a failed stop must leave the
  // record in place, otherwise the next connect adopts nothing and a second instance starts
  // next to the surviving one (M4). It is also removed only when it names *this* pid: a
  // record that belongs to another instance (a re-attach) is not ours to delete.
  const script = `set -u
umask 077
RUN=${shellQuote(layout.runFile)}
PID=${isPid(pid) ? pid : 0}
if [ "$PID" -eq 0 ] && [ -f "$RUN" ]; then
  PID=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$RUN" | head -n 1)
fi
PID="\${PID:-0}"
if [ "$PID" -eq 0 ]; then
  echo "NO-TARGET"
  exit 5
fi
drop_own_record() {
  if [ ! -f "$RUN" ]; then return 0; fi
  REC_PID=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$RUN" 2>/dev/null | head -n 1)
  if [ "\${REC_PID:-}" = "$PID" ]; then rm -f "$RUN"; fi
}
if ! kill -0 "$PID" 2>/dev/null; then
  echo "GONE:$PID"
  drop_own_record
  exit 0
fi
kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
n=0
while [ "$n" -lt 20 ]; do
  kill -0 "$PID" 2>/dev/null || break
  n=$((n+1))
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  n=0
  while [ "$n" -lt 10 ]; do
    kill -0 "$PID" 2>/dev/null || break
    n=$((n+1))
    sleep 0.5
  done
fi
if kill -0 "$PID" 2>/dev/null; then
  echo "ALIVE:$PID"
  exit 6
fi
drop_own_record
echo "STOPPED:$PID"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 40_000 })
    const output = result.stdout.trim()
    // An explicit pid that is already gone means the same thing as no target at all: there
    // is nothing left to signal (the caller can clear the stale registry).
    if (output.includes('NO-TARGET')) return { ok: false, reason: 'no-target', output }
    if (output.includes('ALIVE:')) return { ok: false, reason: 'alive', output }
    if (result.code !== 0) return { ok: false, reason: 'not-confirmed', output }
    return { ok: true, output }
  } catch (error) {
    // swallow-ok: a throw here is a transport failure, reported as an unconfirmed stop so the
    // caller keeps the run registry instead of adopting nothing on the next connect
    return { ok: false, reason: 'error', output: messageOf(error) }
  }
}
