#!/usr/bin/env bash
# dsh-remote-go · OPTIONAL remote helper: loopback SSH alias to this same host.
#
# Adds a `Host self` entry (127.0.0.1, current user, generated ed25519 key) to
# ~/.ssh/config with the matching authorized_keys entry. This is only for future
# "nested" experiments where a remote DSH embeds another DSH through an SSH
# tunnel that terminates on the same machine. Idempotent.
#
# It never touches ~/.dsh-remote-go or any running DSH process.
set -uo pipefail

SSH_DIR="$HOME/.ssh"
KEY="$SSH_DIR/id_ed25519"
PUBFILE="$SSH_DIR/id_ed25519.pub"
AUTH="$SSH_DIR/authorized_keys"
CFG="$SSH_DIR/config"
USER_NAME="$(id -un)"
MARKER='# dsh-remote-go: nested self-SSH alias (loopback login for nested-embed tests)'

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR" 2>/dev/null || true

if [ ! -f "$KEY" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "dsh-remote-go-self@$(hostname)" -f "$KEY"
  printf 'GENERATED_KEY=%s\n' "$KEY"
else
  printf 'REUSED_KEY=%s\n' "$KEY"
fi
chmod 600 "$KEY" 2>/dev/null || true
chmod 644 "$PUBFILE" 2>/dev/null || true

touch "$AUTH"
chmod 600 "$AUTH"
PUB="$(cat "$PUBFILE")"
if grep -qF "$PUB" "$AUTH"; then
  printf 'AUTHORIZED_KEY=already-present\n'
else
  printf '%s\n' "$PUB" >> "$AUTH"
  printf 'AUTHORIZED_KEY=added\n'
fi

touch "$CFG"
chmod 600 "$CFG"
if grep -qF "$MARKER" "$CFG"; then
  printf 'SSH_CONFIG=already-present\n'
else
  cat >> "$CFG" <<EOF
$MARKER
Host self
    HostName 127.0.0.1
    User $USER_NAME
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
EOF
  printf 'SSH_CONFIG=added\n'
fi

printf 'SSHD_LISTEN:\n'
ss -ltn 2>/dev/null | grep -E '(:22\b|127\.0\.0\.1:22)' || echo '(no listener on 22 found)'

printf 'SELF_SSH_TEST:\n'
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$SSH_DIR/known_hosts" self \
  'printf "SELF_OK host=%s user=%s ssh_connection=%s\n" "$(hostname)" "$(whoami)" "${SSH_CONNECTION:-<unset>}"' 2>&1
printf 'SELF_SSH_EXIT=%s\n' "$?"
