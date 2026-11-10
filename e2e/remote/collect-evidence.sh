#!/usr/bin/env bash
# dsh-remote-go · collect V0 evidence from a running remote instance (read-only).
#
# Prints labelled sections that the local driver saves under evidence/. Also runs
# one isolated startup-timing probe: a second, throwaway DSH_HOME that reuses the
# installed node/dsh runtime through a temp root with symlinks, so the production
# start-remote.sh path is measured without touching the main instance.
#
# Env override: DSH_REMOTE_ROOT (default ~/.dsh-remote-go)
set -uo pipefail

ROOT="${DSH_REMOTE_ROOT:-$HOME/.dsh-remote-go}"
RUN="$ROOT/run"
LOG="$ROOT/logs/remote-web.log"
PID="$(cat "$RUN/web.pid" 2>/dev/null || true)"

section() { printf '\n===== %s =====\n' "$*"; }

section 'A. runtime versions'
NODE_BIN="$ROOT/node/bin/node"
DSH_BIN="$ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
printf 'root=%s\n' "$ROOT"
printf 'node=%s\n' "$("$NODE_BIN" --version 2>/dev/null || echo missing)"
printf 'dsh=%s\n' "$("$NODE_BIN" "$DSH_BIN" --version 2>/dev/null || echo missing)"
printf 'install_record:\n'; cat "$RUN/install.json" 2>/dev/null || echo '(none)'
printf '\ndisk_usage:\n'; du -sh "$ROOT/node" "$ROOT/dsh-home" "$ROOT/home" 2>/dev/null || true
printf '\ndirectory_layout:\n'; find "$ROOT" -maxdepth 2 -mindepth 1 -printf '%y %P\n' 2>/dev/null | sort

section 'B. dsh web process'
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  printf 'pid=%s\n' "$PID"
  ps -o pid,ppid,pgid,sid,stat,etimes,start_time,rss,args -p "$PID" 2>/dev/null || true
  printf '\nlistener:\n'; ss -ltnp 2>/dev/null | grep -E "pid=${PID}," || echo '(none)'
  printf '\nssh_relevant_env:\n'
  tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | grep -E '^(SSH_CONNECTION|SSH_TTY|DSH_HOME|SSH_CLIENT)=' || echo '(none)'
  printf '\nlaunch_environment_source (launchedThroughSsh):\n'
  LE="$ROOT/dsh-home/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js"
  if [ -f "$LE" ]; then grep -n -A 12 -B 2 'launchedThroughSsh' "$LE" | head -50; else echo "(missing $LE)"; fi
  printf '\nprocess_is_session_leader:\n'
  ps -o pid,sid,pgid -p "$PID" 2>/dev/null
else
  printf 'not running (pid file: %s)\n' "${PID:-<none>}"
fi

section 'C. startup log and timing evidence'
if [ -f "$LOG" ]; then
  printf 'log=%s\n' "$LOG"
  printf 'log_mtime=%s\n' "$(stat -c '%y' "$LOG")"
  printf 'pidfile_mtime=%s\n' "$(stat -c '%y' "$RUN/web.pid" 2>/dev/null || echo '(none)')"
  printf 'log_mode=%s pidfile_mode=%s\n' "$(stat -c '%a' "$LOG" 2>/dev/null)" "$(stat -c '%a' "$RUN/web.pid" 2>/dev/null)"
  printf 'log_content_redacted:\n'
  sed -E 's/(token=)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/\1\2<redacted>/g' "$LOG" | head -20
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    now="$(date +%s)"; up="$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ')"
    if [ -n "$up" ]; then
      proc_start=$(( now - up ))
      ready="$(stat -c %Y "$LOG" 2>/dev/null || echo "$proc_start")"
      printf 'derived_process_start_epoch=%s log_ready_epoch=%s startup_seconds=%s\n' \
        "$proc_start" "$ready" "$(( ready - proc_start ))"
    fi
  fi
else
  printf '(no log at %s)\n' "$LOG"
fi

section 'D. DSH_HOME layout (isolated)'
find "$ROOT/home" -maxdepth 3 -mindepth 1 -printf '%y %P\n' 2>/dev/null | sort | head -80

section 'E. isolated startup timing probe (throwaway DSH_HOME, does not touch main instance)'
TMPROOT="$ROOT/.timing-probe"
if [ -d "$TMPROOT" ]; then rm -rf "$TMPROOT"; fi
mkdir -p "$TMPROOT"
ln -s "$ROOT/node" "$TMPROOT/node"
ln -s "$ROOT/dsh-home" "$TMPROOT/dsh-home"
printf 'probe_root=%s (node/dsh-home symlinked, fresh DSH_HOME)\n' "$TMPROOT"
DSH_REMOTE_ROOT="$TMPROOT" START_TIMEOUT=120 bash "$ROOT/scripts/start-remote.sh" 2>&1 | grep -E '^(START_OK|REUSED|PORT|PID|STARTUP_SECONDS|DSH_VERSION|NODE_VERSION|URL_REDACTED|START_FAILED)' || true
TMPPID="$(cat "$TMPROOT/run/web.pid" 2>/dev/null || true)"
TMPPORT="$(cat "$TMPROOT/run/web.port" 2>/dev/null || true)"
if [ -n "$TMPPORT" ]; then
  printf 'probe_probe_http=%s\n' "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$TMPPORT/" 2>/dev/null || echo 000)"
fi
printf 'probe_log:\n'; sed -E 's/(token=)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/\1\2<redacted>/g' "$TMPROOT/logs/remote-web.log" 2>/dev/null | head -10
DSH_REMOTE_ROOT="$TMPROOT" bash "$ROOT/scripts/stop-remote.sh" 2>&1 | grep -E '^(STOP_OK|ALREADY_STOPPED|PID|POST_STOP_PROBE_HTTP)' || true
sleep 1
if [ -n "$TMPPID" ] && kill -0 "$TMPPID" 2>/dev/null; then
  printf 'probe_cleanup=killing_leftover\n'
  kill -KILL -- "-$TMPPID" 2>/dev/null || kill -KILL "$TMPPID" 2>/dev/null || true
fi
rm -rf "$TMPROOT"
printf 'probe_root_removed=yes\n'
