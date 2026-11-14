#!/usr/bin/env bash
# dsh-remote-go · start the isolated remote DSH web server (runs ON the remote host)
#
# Boots `dsh --profile web --no-open --port 0` under an isolated DSH_HOME with setsid+nohup
# so it survives the SSH connection closing. Writes run state to ~/.dsh-remote-go/run/
# (web.pid, web.port, web.token and web.url at mode 600, web.state.json) and logs to
# ~/.dsh-remote-go/logs/remote-web.log.
#
# Idempotent: if the recorded process is alive and answering, it is reused. RESTART=1
# forces a clean restart. Env overrides: DSH_REMOTE_ROOT, RESTART, START_TIMEOUT
set -euo pipefail

umask 077

ROOT="${DSH_REMOTE_ROOT:-$HOME/.dsh-remote-go}"
NODE_BIN="$ROOT/node/bin/node"
DSH_BIN="$ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
DSH_HOME_DIR="$ROOT/home"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/remote-web.log"
RUN_DIR="$ROOT/run"
PID_FILE="$RUN_DIR/web.pid"
PORT_FILE="$RUN_DIR/web.port"
TOKEN_FILE="$RUN_DIR/web.token"
URL_FILE="$RUN_DIR/web.url"
STATE_FILE="$RUN_DIR/web.state.json"
RESTART="${RESTART:-0}"
START_TIMEOUT="${START_TIMEOUT:-180}"
URL_PATTERN='dsh web: https?://[^[:space:]]+[?]token=[^[:space:]]+'

die() { printf 'START_FAILED: %s\n' "$*" >&2; exit 1; }
log_soft() { printf '[start] %s\n' "$*"; }
pid_of() { cat "$PID_FILE" 2>/dev/null || true; }

is_alive() {
  local pid
  pid="$(pid_of)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

probe_http() {
  local port="$1" code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  [ -n "$code" ] || code=000
  printf '%s' "$code"
}

url_from_log() {
  [ -f "$LOG" ] || return 1
  grep -Eo "$URL_PATTERN" "$LOG" 2>/dev/null | tail -n 1 | sed -E 's/^dsh web: //' || return 1
}

port_from_url() { printf '%s' "$1" | sed -E 's#^https?://[^/]*:([0-9]+)/.*#\1#'; }
token_from_url() { printf '%s' "$1" | sed -E 's#.*[?&]token=([^&[:space:]]+).*#\1#'; }

# Persist port/token/url (mode 600) from one authenticated startup URL.
write_runtime_files() {
  local url="$1" port token
  port="$(port_from_url "$url")"
  token="$(token_from_url "$url")"
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$token" ] || return 1
  printf '%s' "$port" > "$PORT_FILE"
  printf '%s' "$token" > "$TOKEN_FILE"
  printf '%s\n' "$url" > "$URL_FILE"
  chmod 600 "$TOKEN_FILE" "$URL_FILE" 2>/dev/null || true
  return 0
}

emit_state() {
  local reused="$1" port="$2" pid="$3" elapsed="$4" token_len="$5" token_prefix="$6" http_code="$7"
  # The state record is written by the private Node, so the caller needs no jq.
  PORT="$port" PID="$pid" REUSED="$reused" ELAPSED="$elapsed" \
  TOKEN_LEN="$token_len" TOKEN_PREFIX="$token_prefix" HTTP_CODE="$http_code" \
  STATE_FILE="$STATE_FILE" LOG="$LOG" ROOT="$ROOT" DSH_HOME="$DSH_HOME_DIR" \
  TOKEN_FILE="$TOKEN_FILE" NODE_BIN="$NODE_BIN" DSH_BIN="$DSH_BIN" \
  SSH_CONNECTION_ARG="${SSH_CONNECTION:-}" SSH_TTY_ARG="${SSH_TTY:-}" \
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const e = process.env;
    fs.writeFileSync(e.STATE_FILE, JSON.stringify({
      reused: e.REUSED === "1", pid: Number(e.PID), port: Number(e.PORT),
      reachableHttpStatus: Number(e.HTTP_CODE), startupSeconds: Number(e.ELAPSED),
      tokenLength: Number(e.TOKEN_LEN), tokenPrefix: e.TOKEN_PREFIX, tokenFile: e.TOKEN_FILE,
      log: e.LOG, root: e.ROOT, dshHome: e.DSH_HOME, nodeBin: e.NODE_BIN, dshBin: e.DSH_BIN,
      sshConnection: e.SSH_CONNECTION_ARG, sshTty: e.SSH_TTY_ARG, startedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  ' 2>/dev/null || true

  local node_ver dsh_ver
  node_ver="$("$NODE_BIN" --version 2>/dev/null || printf 'unknown')"
  dsh_ver="$("$NODE_BIN" "$DSH_BIN" --version 2>/dev/null || printf 'unknown')"
  printf 'START_OK\nREUSED=%s\nPORT=%s\nPID=%s\nLOG=%s\nDSH_HOME=%s\nSTATE_FILE=%s\nTOKEN_FILE=%s\nTOKEN_LEN=%s\nTOKEN_PREFIX=%s\nREMOTE_PROBE_HTTP=%s\nSTARTUP_SECONDS=%s\nSSH_CONNECTION=%s\nSSH_TTY=%s\nNODE_VERSION=%s\nDSH_VERSION=%s\nURL_REDACTED=%s\n' \
    "$reused" "$port" "$pid" "$LOG" "$DSH_HOME_DIR" "$STATE_FILE" "$TOKEN_FILE" \
    "$token_len" "$token_prefix" "$http_code" "$elapsed" \
    "${SSH_CONNECTION:-<unset>}" "${SSH_TTY:-<unset>}" "$node_ver" "$dsh_ver" \
    "http://127.0.0.1:${port}/?token=${token_prefix}...(len=${token_len})"
}

# --- reuse path -----------------------------------------------------------
if [ "$RESTART" != "1" ] && is_alive; then
  pid="$(pid_of)"
  url="$(url_from_log || true)"
  if [ -z "$url" ]; then
    printf 'START_FAILED: process %s is alive but no "dsh web:" URL was found in %s\n' "$pid" "$LOG" >&2
    exit 1
  fi
  port="$(port_from_url "$url")"
  if [ -n "$port" ] && [ "$(probe_http "$port")" != "000" ]; then
    write_runtime_files "$url" || die "could not persist runtime files from log URL"
    token="$(cat "$TOKEN_FILE")"
    log_soft "reusing running server pid=$pid port=$port"
    emit_state 1 "$port" "$pid" 0 "${#token}" "${token:0:6}" "$(probe_http "$port")"
    exit 0
  fi
  log_soft "recorded process $pid is not answering on port ${port:-?}; restarting"
fi

# --- stop stale process ---------------------------------------------------
if is_alive; then
  pid="$(pid_of)"
  log_soft "stopping stale process pid=$pid"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$TOKEN_FILE" "$URL_FILE" "$STATE_FILE"

[ -x "$NODE_BIN" ] || die "missing node at $NODE_BIN (run setup-remote.sh first)"
[ -f "$DSH_BIN" ] || die "missing dsh cli at $DSH_BIN (run setup-remote.sh first)"

mkdir -p "$LOG_DIR" "$RUN_DIR" "$DSH_HOME_DIR"
if [ -f "$LOG" ]; then mv -f "$LOG" "$LOG.prev"; fi
: > "$LOG"
chmod 600 "$LOG" 2>/dev/null || true

started_at="$(date +%s)"
printf '# dsh-remote-go start %s DSH_HOME=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DSH_HOME_DIR" >> "$LOG"
log_soft "booting: DSH_HOME=$DSH_HOME_DIR $NODE_BIN $DSH_BIN --profile web --no-open --port 0"
setsid env DSH_HOME="$DSH_HOME_DIR" bash -c 'echo $$ > "$1"; shift; exec "$@"' _ \
  "$PID_FILE" "$NODE_BIN" "$DSH_BIN" --profile web --no-open --port 0 \
  >>"$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true

# --- wait for the startup URL line ----------------------------------------
# The child writes its pid file as its first action, so a missing pid file in the first
# seconds is not an exit.
elapsed=0
url=""
while [ "$elapsed" -lt "$START_TIMEOUT" ]; do
  url="$(url_from_log || true)"
  if [ -n "$url" ]; then break; fi
  if [ "$elapsed" -ge 3 ] && [ -f "$PID_FILE" ] && ! is_alive; then
    printf 'START_FAILED: dsh web exited before printing its URL\n' >&2
    tail -n 60 "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
if [ -z "$url" ]; then
  printf 'START_FAILED: timed out after %ss waiting for "dsh web:" line\n' "$START_TIMEOUT" >&2
  tail -n 60 "$LOG" >&2 || true
  exit 1
fi
is_alive || die "the server printed its URL but the recorded process is not alive"
write_runtime_files "$url" || die "could not parse/persist runtime files from URL: $url"

pid="$(pid_of)"
port="$(cat "$PORT_FILE")"
token="$(cat "$TOKEN_FILE")"
http_code="$(probe_http "$port")"
node_ver="$("$NODE_BIN" --version 2>/dev/null || printf 'unknown')"
dsh_ver="$("$NODE_BIN" "$DSH_BIN" --version 2>/dev/null || printf 'unknown')"
total_elapsed=$(( $(date +%s) - started_at ))
printf '# dsh-remote-go up pid=%s port=%s dsh=%s node=%s in %ss\n' \
  "$pid" "$port" "$dsh_ver" "$node_ver" "$total_elapsed" >> "$LOG"
log_soft "up: pid=$pid port=$port dsh=$dsh_ver node=$node_ver in ${total_elapsed}s (probe http=$http_code)"
emit_state 0 "$port" "$pid" "$total_elapsed" "${#token}" "${token:0:6}" "$http_code"
