#!/usr/bin/env bash
# dsh-remote-go · stop the isolated remote DSH web server (runs ON the remote host)
#
# Sends SIGTERM to the recorded process group, escalates to SIGKILL after a
# grace period, and clears the run-state files. Idempotent: a stopped server is
# reported as already-stopped, not an error.
#
# Env overrides: DSH_REMOTE_ROOT, STOP_TIMEOUT (seconds, default 20)
set -euo pipefail

ROOT="${DSH_REMOTE_ROOT:-$HOME/.dsh-remote-go}"
RUN_DIR="$ROOT/run"
PID_FILE="$RUN_DIR/web.pid"
PORT_FILE="$RUN_DIR/web.port"
TOKEN_FILE="$RUN_DIR/web.token"
URL_FILE="$RUN_DIR/web.url"
STATE_FILE="$RUN_DIR/web.state.json"
STOP_TIMEOUT="${STOP_TIMEOUT:-20}"

probe_http() {
  local port="$1" code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  [ -n "$code" ] || code=000
  printf '%s' "$code"
}

clear_state() {
  rm -f "$PID_FILE" "$PORT_FILE" "$TOKEN_FILE" "$URL_FILE" "$STATE_FILE"
}

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
port="$(cat "$PORT_FILE" 2>/dev/null || true)"

if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  clear_state
  printf 'STOP_OK\n'
  printf 'ALREADY_STOPPED=1\n'
  printf 'PID=%s\n' "${pid:-<none>}"
  exit 0
fi

printf '[stop] sending SIGTERM to process group of pid %s\n' "$pid"
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

waited=0
while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt $((STOP_TIMEOUT * 5)) ]; do
  sleep 0.2
  waited=$((waited + 1))
done

killed=0
if kill -0 "$pid" 2>/dev/null; then
  printf '[stop] pid %s still alive after %ss; sending SIGKILL\n' "$pid" "$STOP_TIMEOUT"
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  killed=1
  sleep 1
fi

post_code="000"
if [ -n "$port" ]; then post_code="$(probe_http "$port")"; fi

alive=0
if kill -0 "$pid" 2>/dev/null; then alive=1; fi

clear_state

printf 'STOP_OK\n'
printf 'ALREADY_STOPPED=0\n'
printf 'PID=%s\n' "$pid"
printf 'SIGKILL_ESCALATED=%s\n' "$killed"
printf 'PROCESS_STILL_ALIVE=%s\n' "$alive"
printf 'POST_STOP_PROBE_HTTP=%s\n' "$post_code"
