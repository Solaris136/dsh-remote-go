/**
 * The artifact half of the managed Node install: the remote scripts that find the official
 * tarball's SHA-256, download it verified and unpack it under `$DSH_HOME/remote-go/node`, plus
 * the parsers for their stdout. Everything here is pure (no transport), so `node-runtime.ts`
 * runs these scripts and owns the install/reuse orchestration.
 */
import type { RemoteLayout } from '../layout.js'
import { shellQuote } from '../util.js'

export const NODE_DIST_BASES: readonly string[] = Object.freeze([
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
])

/** One verified release: where the checksum came from and what the tarball must hash to. */
export interface NodeRelease {
  base: string
  version: string
  sha256: string
  file: string
}

/**
 * Pick the downloader both install scripts share: curl when present, else wget.
 * Exit 9 is the "neither tool" contract the caller maps to `no-fetch`.
 */
const FETCH_PROLOGUE = `if command -v curl >/dev/null 2>&1; then
  FETCH=curl
elif command -v wget >/dev/null 2>&1; then
  FETCH=wget
else
  printf 'FAILED\\tno-fetch\\n'
  exit 9
fi`

/** What the checksum script needs: where to cache, which version/arch, which mirrors. */
export interface NodeChecksumInput {
  downloadDir: string
  version: string
  arch: string
  bases?: readonly string[]
}

export function buildNodeChecksumScript(input: NodeChecksumInput): string {
  const bases = (input.bases ?? NODE_DIST_BASES).map((base) => shellQuote(base)).join(' ')
  return `set -u
DL=${shellQuote(input.downloadDir)}
VERSION=${shellQuote(input.version)}
FILE="node-v$VERSION-linux-${input.arch}.tar.gz"
mkdir -p "$DL" || exit 3
${FETCH_PROLOGUE}
fetch() {
  URL=$1
  OUT=$2
  if [ "$FETCH" = curl ]; then
    curl -fsSL --connect-timeout 10 --max-time 60 -o "$OUT" "$URL" 2>/dev/null
  else
    wget -q -T 30 -t 1 -O "$OUT" "$URL" 2>/dev/null
  fi
}
for BASE in ${bases}; do
  TMP="$DL/.shasums.$$"
  if fetch "$BASE/v$VERSION/SHASUMS256.txt" "$TMP"; then
    LINE=$(grep -F "  $FILE" "$TMP" | head -n 1 || true)
    if [ -n "$LINE" ]; then
      SHA=$(printf '%s\\n' "$LINE" | awk '{print $1}')
      if [ "\${#SHA}" -eq 64 ]; then
        printf 'CHECKSUM\\t%s\\t%s\\n' "$BASE" "$SHA"
        rm -f "$TMP"
        exit 0
      fi
    fi
  fi
  rm -f "$TMP"
done
exit 5
`
}

export function parseNodeChecksumOutput(
  stdout: unknown,
  input: { version: string; arch: string; bases?: readonly string[] },
): NodeRelease | null {
  const file = `node-v${input.version}-linux-${input.arch}.tar.gz`
  const allowed = input.bases ?? NODE_DIST_BASES
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const parts = rawLine.split('\t')
    if (parts[0] !== 'CHECKSUM' || parts.length < 3) continue
    const [, base, sha256] = parts
    if (!allowed.includes(base)) continue
    if (!/^[0-9a-f]{64}$/.test(sha256)) continue
    return { base, version: input.version, sha256, file }
  }
  return null
}

/** What the install script needs: the layout, the verified release and the mirrors to try. */
export interface NodeInstallInput {
  layout: RemoteLayout
  release: NodeRelease
  bases?: readonly string[]
}

export function buildNodeInstallScript(input: NodeInstallInput): string {
  const bases = (input.bases ?? NODE_DIST_BASES).map((base) => shellQuote(base)).join(' ')
  const { release } = input
  return `set -eu
NODE_DIR=${shellQuote(input.layout.nodeDir)}
DL=${shellQuote(input.layout.downloadDir)}
VERSION=${shellQuote(release.version)}
SHA=${shellQuote(release.sha256)}
FILE=${shellQuote(release.file)}
BINDIR="$NODE_DIR/v$VERSION"
mkdir -p "$NODE_DIR" "$DL" || exit 3
if [ -x "$BINDIR/bin/node" ] && [ "$("$BINDIR/bin/node" -v 2>/dev/null || true)" = "v$VERSION" ]; then
  printf 'READY\\t%s\\n' "$BINDIR"
  exit 0
fi
${FETCH_PROLOGUE}
verify() {
  TARGET=$1
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$SHA" "$TARGET" | sha256sum -c - >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$SHA" "$TARGET" | shasum -a 256 -c - >/dev/null 2>&1
  elif command -v openssl >/dev/null 2>&1; then
    GOT=$(openssl dgst -sha256 "$TARGET" 2>/dev/null | sed 's/.*= //')
    [ "$GOT" = "$SHA" ]
  else
    return 127
  fi
}
TARBALL="$DL/$FILE"
if [ -f "$TARBALL" ] && verify "$TARBALL"; then
  echo "STEP\\treuse"
else
  OK=0
  for BASE in ${bases}; do
    PART="$TARBALL.part.$$"
    rm -f "$PART"
    printf 'STEP\\tdownload\\t%s\\n' "$BASE"
    if [ "$FETCH" = curl ]; then
      curl -fsSL --connect-timeout 15 --max-time 600 -o "$PART" "$BASE/v$VERSION/$FILE" &
    else
      wget -q -T 60 -t 3 -O "$PART" "$BASE/v$VERSION/$FILE" &
    fi
    PID=$!
    while kill -0 "$PID" 2>/dev/null; do
      printf 'BYTES\\t%s\\n' "$(wc -c < "$PART" 2>/dev/null || echo 0)"
      sleep 2
    done
    if wait "$PID" && verify "$PART"; then
      mv "$PART" "$TARBALL"
      OK=1
      break
    fi
    printf 'FAILED\\tchecksum\\t%s\\n' "$BASE"
    rm -f "$PART"
  done
  if [ "$OK" -ne 1 ]; then
    echo "FAILED\\tdownload"
    exit 6
  fi
fi
echo "STEP\\textract"
TMPX="$NODE_DIR/.extract.$$"
rm -rf "$TMPX"
mkdir -p "$TMPX"
if ! tar -xzf "$TARBALL" -C "$TMPX" --strip-components=1; then
  echo "FAILED\\textract"
  rm -rf "$TMPX"
  exit 7
fi
if [ ! -x "$TMPX/bin/node" ]; then
  echo "FAILED\\textract"
  rm -rf "$TMPX"
  exit 7
fi
GOT=$("$TMPX/bin/node" -v 2>/dev/null || true)
if [ "$GOT" != "v$VERSION" ]; then
  echo "FAILED\\tverify"
  rm -rf "$TMPX"
  exit 8
fi
rm -rf "$BINDIR"
mv "$TMPX" "$BINDIR"
rm -f "$TARBALL"
for OLD in "$NODE_DIR"/v*; do
  [ -d "$OLD" ] || continue
  [ "$OLD" = "$BINDIR" ] && continue
  rm -rf "$OLD"
done
printf 'READY\\t%s\\n' "$BINDIR"
`
}
