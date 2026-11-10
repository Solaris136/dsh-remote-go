#!/usr/bin/env bash
# dsh-remote-go · remote runtime status (read-only; runs ON the remote host)
#
# After V0 handover the plugin (or another harness) owns the remote `dsh web`
# lifecycle. This script therefore only INSPECTS: it never starts, stops or
# touches DSH_HOME, and it is safe to run while another process is using the
# isolated runtime.
#
# It reports:
#   - runtime presence + versions (private Node, installed dsh, install record)
#   - disk usage / directory layout
#   - last recorded web run state from run/ (pid/port/log, stale or alive)
#   - every process currently using this runtime's dsh CLI (read-only pgrep)
#   - loopback listeners owned by those processes
#
# Env overrides: DSH_REMOTE_ROOT
set -uo pipefail

ROOT="${DSH_REMOTE_ROOT:-$HOME/.dsh-remote-go}"
NODE_BIN="$ROOT/node/bin/node"
DSH_BIN="$ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
DSH_HOME_DIR="$ROOT/home"
LOG="$ROOT/logs/remote-web.log"
RUN_DIR="$ROOT/run"
PID_FILE="$RUN_DIR/web.pid"
PORT_FILE="$RUN_DIR/web.port"

probe_http() {
  local port="$1" code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  [ -n "$code" ] || code=000
  printf '%s' "$code"
}

redact_url() {
  sed -E 's/(token=)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/\1\2<redacted>/g'
}

runtime_ok=1
printf 'MODE=runtime-only\n'
printf 'ROOT=%s\n' "$ROOT"
printf 'DSH_HOME=%s\n' "$DSH_HOME_DIR"
printf 'LOG=%s\n' "$LOG"

printf '\n== runtime ==================================================\n'
if [ -x "$NODE_BIN" ]; then
  printf 'NODE_OK=1\nNODE_VERSION=%s\nNODE_BIN=%s\n' "$("$NODE_BIN" --version 2>/dev/null)" "$NODE_BIN"
else
  printf 'NODE_OK=0\n'; runtime_ok=0
fi
if [ -x "$NODE_BIN" ] && [ -f "$DSH_BIN" ]; then
  printf 'DSH_OK=1\nDSH_VERSION=%s\nDSH_BIN=%s\n' "$("$NODE_BIN" "$DSH_BIN" --version 2>/dev/null)" "$DSH_BIN"
else
  printf 'DSH_OK=0\n'; runtime_ok=0
fi
printf 'RUNTIME_OK=%s\n' "$runtime_ok"
if [ -f "$RUN_DIR/install.json" ]; then
  printf 'INSTALL_RECORD:\n'; cat "$RUN_DIR/install.json"
fi
printf 'DISK_USAGE:\n'; du -sh "$ROOT/node" "$ROOT/dsh-home" "$ROOT/home" 2>/dev/null || true

printf '\n== recorded web run (last known; may be stale) =============\n'
if [ -f "$PID_FILE" ]; then
  rec_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  rec_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  printf 'RECORDED_PID=%s\nRECORDED_PORT=%s\n' "${rec_pid:-<none>}" "${rec_port:-<none>}"
  printf 'PIDFILE_MTIME=%s\n' "$(stat -c '%y' "$PID_FILE" 2>/dev/null || echo '?')"
  if [ -n "$rec_pid" ] && kill -0 "$rec_pid" 2>/dev/null; then
    printf 'RECORDED_PID_ALIVE=1\n'
    if [ -n "$rec_port" ]; then printf 'RECORDED_PROBE_HTTP=%s\n' "$(probe_http "$rec_port")"; fi
    ps -o pid,ppid,pgid,sid,etimes,rss,args -p "$rec_pid" 2>/dev/null || true
  else
    printf 'RECORDED_PID_ALIVE=0\n'
  fi
else
  printf 'RECORDED_PID=absent (web was stopped; run/ cleared)\n'
fi

printf '\n== processes using this runtime (read-only) ================\n'
mapfile -t runtime_pids < <(pgrep -f "$ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null || true)
printf 'RUNTIME_WEB_PROCESS_COUNT=%s\n' "${#runtime_pids[@]}"
for p in "${runtime_pids[@]}"; do
  printf 'RUNTIME_WEB_PID=%s\n' "$p"
  ps -o pid,ppid,pgid,sid,etimes,rss,args -p "$p" 2>/dev/null || true
  ss -ltnp 2>/dev/null | grep -E "pid=${p}," || printf '  (no loopback listener found)\n'
done

printf '\n== DSH_HOME layout (read-only) =============================\n'
if [ -d "$DSH_HOME_DIR" ]; then
  find "$DSH_HOME_DIR" -maxdepth 3 -mindepth 1 -printf '%y %P\n' 2>/dev/null | sort | head -60
else
  printf '(missing DSH_HOME; run setup-remote.sh once)\n'
fi

printf '\n== log (last 10 lines, token redacted) =====================\n'
if [ -f "$LOG" ]; then
  stat -c 'LOG_MODE=%a LOG_MTIME=%y' "$LOG" 2>/dev/null || true
  tail -n 10 "$LOG" | redact_url
else
  printf '(no log at %s)\n' "$LOG"
fi
