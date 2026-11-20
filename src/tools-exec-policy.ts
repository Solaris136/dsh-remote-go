/** The read-mode command policy of `remote_exec`: what may run when the caller did not ask for write mode. Its own
 * module because it is a security decision rather than plumbing, and best effort rather than a sandbox — a POSIX shell
 * is Turing-complete, so it stops accidents and obvious injection shapes. The boundary is the human plus the switch. */
/** The programs read mode may run: inspection tools that do not normally write, six further narrowed by the guards
 * below. `date`/`hostname` are deliberately absent — an ordinary operand mutates them, and no token list helps. */
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
/** The long options that turn an allowed program into a mutation, matched by **prefix** because glibc's `getopt_long`
 * accepts any unambiguous abbreviation (`file --comp` reaches `--compile`); three characters is the shortest name that
 * already refuses. */
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
/** The short flags with the same effect, checked per token because one can carry its argument glued to it (`-s@0`)
 * while `file -C` takes none; `ps` has no mutating flag, but its standalone `e` modifier appends every process's
 * environment. */
const DANGEROUS_SHORT_FLAGS: Record<string, RegExp> = {
  file: /^-[A-Za-z]*C/,
  ss: /^-[A-Za-z]*[KD]/,
}
/** The two redirections that only silence a stream, stripped so `ls /nope 2>/dev/null` stays usable. */
const DEV_NULL_RE = /2?>>?\s*\/dev\/null/g
const STDERR_MERGE_RE = /2>&1/g
/** The separators a compound line is split on; each resulting piece needs its own allowed program. */
const SEGMENT_RE = /[;|]+|&&/
/** The read-mode policy: the offending program or token, or `null` when the command is one of the shapes the allowlist
 * accepts. The order mirrors the risk: a newline, redirect or substitution can hide a program behind a harmless first
 * word. Assignments are not stripped either — `FOO=bar ls` is refused *because* its first token is not a program, which
 * blocks a leading `PATH=… cmd`. */
export function readOnlyViolation(command: string): string | null {
  if (command.trim() === '') return 'empty'
  if (/[\n\r\u0000]/.test(command)) return '\\n'
  const stripped = command.replace(DEV_NULL_RE, '').replace(STDERR_MERGE_RE, '')
  if (stripped.includes('>')) return '>'
  // `<` is input redirection, and in bash it can open a TCP socket (`cat </dev/tcp/host/port`).
  if (stripped.includes('<')) return '<'
  if (stripped.includes('`')) return '`'
  if (stripped.includes('$(')) return '$('
  const segments = stripped
    .split(SEGMENT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  if (segments.length === 0) return 'empty'
  for (const segment of segments) {
    // A lone `&` backgrounds the first program and runs whatever follows, so the segment starts a
    // program its first token does not name (`<(` is already caught by the `<` rule).
    if (segment.includes('&')) return '&'
    const tokens = segment.split(/\s+/)
    const program = tokens[0]
    if (!READ_PROGRAMS.has(program)) return program
    if (program === 'systemctl' && !SYSTEMCTL_READ_RE.test(tokens[1] ?? '')) return tokens[1] ?? 'systemctl'
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
  }
  return null
}
