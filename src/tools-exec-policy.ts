/**
 * The read-mode command policy of `remote_exec`: which commands may run when the caller did not ask
 * for write mode.
 *
 * Why this is its own module: it is the one part of `remote_exec` that is a security decision rather
 * than plumbing, so it is reviewed, tested and reasoned about on its own. It depends on nothing —
 * a command string in, the offending token (or `null`) out — which also means the tool module stays
 * a projection layer.
 *
 * Why it is a best effort: a POSIX shell is Turing-complete (quoting, builtins, globbing, `$(…)`,
 * aliases, wrapper scripts on the remote PATH), so no word list can prove a command is read-only.
 * This stops accidents and the obvious prompt-injection shapes; it is not a sandbox. The real
 * boundary is that commands only run on a host the human already connected, plus the write switch in
 * the plugin config.
 *
 * Two rules keep the list honest as programs gain flags:
 *   - a program that can mutate through an ordinary operand is not allowlisted at all (`date`,
 *     `hostname`), because no token list tells the read form from the write form;
 *   - the programs that mutate through an option are narrowed per token, and the long options are
 *     matched by **prefix**, because glibc's `getopt_long` accepts any unambiguous abbreviation
 *     (`file --comp` reaches `--compile`, `journalctl --rot` reaches `--rotate`).
 */

/**
 * The programs read mode may run. Every entry is an inspection tool that does not normally write;
 * `systemctl`, `journalctl`, `file`, `ss`, `df` and `ps` are additionally narrowed by the guards
 * below. `date` and `hostname` are deliberately absent: both are settable through an ordinary
 * operand (`date 010100002020`, `hostname attacker`), and no word list tells the two forms apart.
 */
const READ_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'stat',
  'file',
  'du',
  'df',
  'free',
  'ps',
  'pgrep',
  'uptime',
  'uname',
  'whoami',
  'id',
  'pwd',
  'which',
  'echo',
  'printf',
  'ss',
  'netstat',
  'lsof',
  'journalctl',
  'systemctl',
])

/** The only `systemctl` verbs read mode allows: each one asks the state, none changes it. */
const SYSTEMCTL_READ_RE = /^(?:status|is-active|is-enabled|is-failed|show|cat|list-units|list-timers|--version)$/

/**
 * The long options that turn an allowed program into a mutation, matched by **prefix**: glibc's
 * `getopt_long` accepts any unambiguous abbreviation, so `file --comp` reaches `--compile`,
 * `journalctl --rot` reaches `--rotate` and `ss --dia` reaches `--diag`. A token is refused when its
 * option name is a prefix of one of these (three characters is the shortest unambiguous prefix).
 */
const DANGEROUS_LONG_OPTIONS: Record<string, string[]> = {
  file: ['compile'],
  ss: ['diag', 'kill'],
  df: ['sync'],
  journalctl: [
    'vacuum-time',
    'vacuum-size',
    'vacuum-files',
    'rotate',
    'flush',
    'sync',
    'relinquish-var',
    'setup-keys',
    'update-catalog',
  ],
}

/**
 * The short flags with the same effect, checked per token because a short flag can carry its
 * argument glued to it (`-s@0`) and `file -C` takes no argument at all. `ps` has no mutating flag;
 * what it has is the standalone `e` command modifier, which appends every process's environment —
 * a disclosure this read surface must not offer.
 */
const DANGEROUS_SHORT_FLAGS: Record<string, RegExp> = {
  file: /^-[A-Za-z]*C/,
  ss: /^-[A-Za-z]*[KD]/,
}

/**
 * The two redirections that only silence a stream and cannot write anything. They are stripped
 * before the redirect check so the everyday `ls /nope 2>/dev/null` stays usable; every other
 * redirect operator is refused.
 */
const DEV_NULL_RE = /2?>>?\s*\/dev\/null/g
const STDERR_MERGE_RE = /2>&1/g

/** The separators a compound line is split on; each resulting piece needs its own allowed program. */
const SEGMENT_RE = /[;|]+|&&/

/** The offending token of one segment, or `null` when the segment is a read. */
function dangerousToken(program: string, tokens: string[]): string | null {
  const longs = DANGEROUS_LONG_OPTIONS[program] ?? []
  for (const token of tokens.slice(1)) {
    if (token.startsWith('--')) {
      const name = (token.slice(2).split('=')[0] ?? '').toLowerCase()
      if (name.length >= 3 && longs.some((option) => option.startsWith(name))) return token
      continue
    }
    if (program === 'ps' && token === 'e') return token
    const shortFlags = DANGEROUS_SHORT_FLAGS[program]
    if (shortFlags !== undefined && shortFlags.test(token)) return token
  }
  return null
}

/**
 * The read-mode policy. It returns the offending program or token, or `null` when the command is
 * one of the shapes the allowlist accepts.
 *
 * The order mirrors the risk: a newline/redirect/substitution can hide a whole program behind a
 * harmless first word, so those are found before any token is trusted. Assignments are not
 * stripped either — `FOO=bar ls` is refused *because* its first token is not a program, which is
 * what makes a leading `PATH=… cmd` (or any wrapper) impossible to smuggle through.
 */
export function readOnlyViolation(command: string): string | null {
  if (command.trim() === '') return 'empty'
  if (/[\n\r\u0000]/.test(command)) return '\\n'
  const stripped = command.replace(DEV_NULL_RE, '').replace(STDERR_MERGE_RE, '')
  if (stripped.includes('>')) return '>'
  // `<` is input redirection: no read command on the list needs it, and in bash it can open a TCP
  // socket (`cat </dev/tcp/host/port`), so it is refused with the other redirect operators.
  if (stripped.includes('<')) return '<'
  if (stripped.includes('`')) return '`'
  if (stripped.includes('$(')) return '$('
  const segments = stripped
    .split(SEGMENT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  if (segments.length === 0) return 'empty'
  for (const segment of segments) {
    // A lone `&` backgrounds the first program and runs whatever follows it: it starts a program
    // the first token does not name, so it is a refusal (`<(` is already caught by the `<` rule).
    if (segment.includes('&')) return '&'
    const tokens = segment.split(/\s+/)
    const program = tokens[0]
    if (!READ_PROGRAMS.has(program)) return program
    if (program === 'systemctl' && !SYSTEMCTL_READ_RE.test(tokens[1] ?? '')) return tokens[1] ?? 'systemctl'
    const dangerous = dangerousToken(program, tokens)
    if (dangerous !== null) return dangerous
  }
  return null
}
