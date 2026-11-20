/** Stopping a remote DSH web instance: resolve the pid to signal, terminate it, and drop `run/web.json` only after
 * the stop is confirmed, so the next connect still adopts a surviving process instead of starting a second one. */
import type { RemoteLayout } from '../layout.js'
import { remotePortOwnerPid } from '../remote-proc.js'
import type { SshPort } from '../ssh-port.js'
import { isPid, messageOf, shellQuote } from '../util.js'
import { readRunRegistry } from './registry.js'
import { readWebLineFromLog } from './resolve.js'

export interface StopRemoteWebResult {
  ok: boolean
  reason?: string
  output: string
}

export async function stopRemoteWeb(
  ssh: SshPort,
  layout: RemoteLayout,
  options: { pid?: unknown } = {},
): Promise<StopRemoteWebResult> {
  let pid = Number(options.pid ?? 0)
  if (!isPid(pid)) pid = Number((await readRunRegistry(ssh, layout))?.pid ?? 0)
  if (!isPid(pid)) {
    const line = await readWebLineFromLog(ssh, layout)
    const owner = line && isPid(line.port) ? Number(await remotePortOwnerPid(ssh, line.port)) : 0
    pid = isPid(owner) ? owner : 0
  }
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
    if (output.includes('NO-TARGET')) return { ok: false, reason: 'no-target', output }
    if (output.includes('ALIVE:')) return { ok: false, reason: 'alive', output }
    if (result.code !== 0) return { ok: false, reason: 'not-confirmed', output }
    return { ok: true, output }
  } catch (error) {
    // swallow-ok: a throw here is a transport failure, reported as an unconfirmed stop so the caller
    return { ok: false, reason: 'error', output: messageOf(error) }
  }
}
