#!/usr/bin/env bash
# dsh-remote-go · V0 remote bootstrap (runs ON the remote test host)
#
# Creates an isolated, repeatable environment under ~/.dsh-remote-go:
#   1. official Node v24.22.2 linux-x64 tarball, sha256-verified against SHASUMS256.txt
#   2. @deepseek-ai/dsh@<exact version> installed into a private npm prefix
#      (no global install, no root)
#   3. prints verified `dsh --version`
#
# Idempotent: re-running skips finished steps unless FORCE=1.
# Logs: ~/.dsh-remote-go/logs/setup.log
#
# Env overrides: DSH_REMOTE_ROOT, NODE_VERSION, DSH_VERSION, FORCE
set -euo pipefail

ROOT="${DSH_REMOTE_ROOT:-$HOME/.dsh-remote-go}"
NODE_VERSION="${NODE_VERSION:-24.22.2}"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.1}"
FORCE="${FORCE:-0}"

NODE_DIR="$ROOT/node"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_TAR="$ROOT/${NODE_DIST}.tar.xz"
SHASUMS="$ROOT/SHASUMS256.txt"
DSH_PREFIX="$ROOT/dsh-home"
DSH_PKG="$DSH_PREFIX/node_modules/@deepseek-ai/dsh"
DSH_BIN="$DSH_PKG/lib/bin.js"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/setup.log"
RUN_DIR="$ROOT/run"

mkdir -p "$ROOT" "$LOG_DIR" "$RUN_DIR"

log() { printf '[setup] %s\n' "$*"; }

node_ok() {
  [ -x "$NODE_DIR/bin/node" ] || return 1
  [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" = "v${NODE_VERSION}" ]
}

dsh_ok() {
  [ -f "$DSH_BIN" ] || return 1
  [ -f "$DSH_PKG/package.json" ] || return 1
  local ver
  ver="$("$NODE_DIR/bin/node" -e 'console.log(require(process.argv[1]).version)' "$DSH_PKG/package.json" 2>/dev/null || true)"
  [ "$ver" = "$DSH_VERSION" ]
}

install_node() {
  if [ "$FORCE" != "1" ] && node_ok; then
    log "node v${NODE_VERSION} already installed at $NODE_DIR (skip)"
    return 0
  fi
  log "installing Node v${NODE_VERSION} into $NODE_DIR"

  if [ "$FORCE" = "1" ] || [ ! -f "$SHASUMS" ]; then
    log "downloading SHASUMS256.txt"
    curl -fsSL --retry 3 --retry-delay 2 \
      -o "${SHASUMS}.partial" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
    mv -f "${SHASUMS}.partial" "$SHASUMS"
  fi

  if [ "$FORCE" = "1" ] || [ ! -f "$NODE_TAR" ]; then
    log "downloading ${NODE_DIST}.tar.xz"
    curl -fsSL --retry 3 --retry-delay 2 \
      -o "${NODE_TAR}.partial" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"
    mv -f "${NODE_TAR}.partial" "$NODE_TAR"
  fi

  local expected actual
  expected="$(awk -v f="${NODE_DIST}.tar.xz" '$2 == f { print $1 }' "$SHASUMS" | head -n 1)"
  if [ -z "$expected" ]; then
    log "ERROR: no sha256 entry for ${NODE_DIST}.tar.xz in $SHASUMS"
    return 1
  fi
  actual="$(sha256sum "$NODE_TAR" | awk '{ print $1 }')"
  if [ "$actual" != "$expected" ]; then
    log "ERROR: sha256 mismatch for $NODE_TAR"
    log "  expected=$expected"
    log "  actual  =$actual"
    rm -f "$NODE_TAR"
    return 1
  fi
  log "sha256 OK ($actual)"

  rm -rf "$ROOT/node.extract"
  mkdir -p "$ROOT/node.extract"
  tar -xJf "$NODE_TAR" -C "$ROOT/node.extract" --strip-components=1
  [ -x "$ROOT/node.extract/bin/node" ] || { log "ERROR: extracted tree has no executable bin/node"; return 1; }
  rm -rf "$NODE_DIR"
  mv "$ROOT/node.extract" "$NODE_DIR"
  log "node installed: $("$NODE_DIR/bin/node" --version)"
}

install_dsh() {
  if [ "$FORCE" != "1" ] && dsh_ok; then
    log "dsh@${DSH_VERSION} already installed at $DSH_PKG (skip)"
    return 0
  fi
  log "npm install --prefix $DSH_PREFIX @deepseek-ai/dsh@${DSH_VERSION}"
  mkdir -p "$DSH_PREFIX"
  # npm's shebang is `#!/usr/bin/env node`, so expose the private Node on PATH.
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install \
    --prefix "$DSH_PREFIX" \
    "@deepseek-ai/dsh@${DSH_VERSION}" \
    --no-audit --no-fund --no-progress --loglevel=warn
  dsh_ok || { log "ERROR: expected dsh@${DSH_VERSION} after npm install"; return 1; }

  # npm >= 11.16 gates dependency install scripts behind `allow-scripts`.
  # The only script this stack actually needs is a chmod on node-pty's bundled
  # spawn-helper (native .node binaries are already ship-with-package prebuilds),
  # so run that idempotent postinstall body directly instead of approving all
  # dependency scripts.
  local helper_script="$DSH_PREFIX/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs"
  if [ -f "$helper_script" ]; then
    PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/node" "$helper_script" \
      && log "ran dsh-subprocess-local ensure-spawn-helper (node-pty spawn-helper chmod)"
  fi
  local spawn_helper
  for spawn_helper in \
    "$DSH_PREFIX/node_modules/node-pty/prebuilds/${NODE_PLATFORM:-linux-x64}/spawn-helper" \
    "$DSH_PREFIX/node_modules/node-pty/build/Release/spawn-helper"; do
    if [ -f "$spawn_helper" ]; then chmod 755 "$spawn_helper" 2>/dev/null || true; fi
  done
}

write_install_record() {
  local node_ver npm_ver dsh_ver size_kb
  node_ver="$("$NODE_DIR/bin/node" --version)"
  npm_ver="$(PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" --version)"
  dsh_ver="$("$NODE_DIR/bin/node" "$DSH_BIN" --version)"
  size_kb="$(du -sk "$ROOT/node" "$DSH_PREFIX" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')"
  INSTALL_NODE_VERSION="$node_ver" INSTALL_NPM_VERSION="$npm_ver" \
  INSTALL_DSH_VERSION="$dsh_ver" INSTALL_ROOT="$ROOT" \
  INSTALL_LOG="$LOG" INSTALL_SIZE_KB="$size_kb" \
  INSTALL_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$NODE_DIR/bin/node" -e '
    const fs = require("node:fs");
    const record = {
      root: process.env.INSTALL_ROOT,
      nodeVersion: process.env.INSTALL_NODE_VERSION,
      npmVersion: process.env.INSTALL_NPM_VERSION,
      dshVersion: process.env.INSTALL_DSH_VERSION,
      log: process.env.INSTALL_LOG,
      installedSizeKb: Number(process.env.INSTALL_SIZE_KB),
      installedAt: process.env.INSTALL_AT,
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(record, null, 2) + "\n");
  ' "$RUN_DIR/install.json"
  printf 'SETUP_OK\n'
  printf 'NODE_VERSION=%s\n' "$node_ver"
  printf 'NPM_VERSION=%s\n' "$npm_ver"
  printf 'DSH_VERSION=%s\n' "$dsh_ver"
  printf 'DSH_BIN=%s\n' "$DSH_BIN"
  printf 'NODE_BIN=%s\n' "$NODE_DIR/bin/node"
  printf 'ROOT=%s\n' "$ROOT"
  printf 'INSTALL_FILE=%s\n' "$RUN_DIR/install.json"
  printf 'LOG=%s\n' "$LOG"
}

main() {
  local started
  started="$(date +%s)"
  log "root=$ROOT node=$NODE_VERSION dsh=$DSH_VERSION force=$FORCE"
  install_node
  install_dsh
  local dsh_ver
  dsh_ver="$("$NODE_DIR/bin/node" "$DSH_BIN" --version)"
  if [ "$dsh_ver" != "$DSH_VERSION" ]; then
    log "ERROR: version check failed: got '$dsh_ver', want '$DSH_VERSION'"
    return 1
  fi
  log "verified: dsh --version = $dsh_ver"
  write_install_record
  log "done in $(( $(date +%s) - started ))s"
}

set +e
main "$@" 2>&1 | tee -a "$LOG"
status="${PIPESTATUS[0]}"
set -e
exit "$status"
