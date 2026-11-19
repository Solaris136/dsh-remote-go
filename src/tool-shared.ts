/**
 * The building blocks every model-facing tool shares: the one redaction path a result crosses, the
 * projection helpers, and the result/error vocabulary the kernel renders.
 *
 * The tools are separate modules (`tools.ts` owns the list and the reveal entry, `tools-report.ts`
 * the diagnosis report, `tools-exec.ts` the remote command) but they must agree about two things:
 * nothing leaves through a projection that skipped redaction, and a failure is always a structured
 * result the model can report instead of a throw. Owning those here is what keeps a third tool from
 * growing a second, quietly weaker copy.
 *
 * Everything in this module is pure: no transport, no timers, no disk.
 */
import { isRemoteGoError, toErrorView } from './errors.js'
import type { ErrorView } from './errors.js'
import type { ConnectLogView } from './service.js'
import type { DiagnosticsReport } from './diagnostics.js'
import type { HostRuntime } from './host-runtime.js'
import type { HostView } from './host-view.js'
import { redactText } from './redact.js'
import { messageOf } from './util.js'
import type { BilingualText } from './util.js'

/** Shape limits: one free-text field never carries more than this many characters. */
export const TEXT_LIMIT = 400
export const ADDRESS_LIMIT = 200
export const NAME_LIMIT = 120
export const ID_LIMIT = 120

/** A model-facing id or phase code is shorter than a sentence. */
export const CODE_LIMIT = 60

export const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g
export const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * Host identifiers that must never leave a tool. `redactText` covers tokens, passwords,
 * private-key blocks and home directories, but not these two — and a connect failure's `detail`
 * carries them verbatim: `prompts.js` builds the first-use fingerprint prompt (120s timeout,
 * `first-use` is the default policy) and `ssh.js` builds the host-key-changed one, while `auth`
 * failures quote the configured key file.
 *
 * The fingerprint pattern is a flat quantifier, and key paths are found by scanning whitespace-
 * separated tokens (see `isKeyPath`): a nested `(?:[^\s]*[\\/])?` path pattern backtracks
 * quadratically on a long separator-free token, and `address` has no length limit upstream.
 */
const FINGERPRINT_RE = /\bSHA256:[A-Za-z0-9+/=]+/gi
const TOKEN_RE = /[^\s"'`]+/g
const PATH_SEPARATOR_RE = /[\\/]+/
const KEY_FILE_SUFFIX_RE = /\.(?:pem|key|ppk)$/i
/** `id_rsa`, `id_ed25519`, and the backup/copy spellings a failure line quotes (`id_rsa.bak`). */
const KEY_FILE_NAME_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[a-z0-9]+)?$/i
/** OpenSSH host keys are private key files too, and their names carry no `.pem`/`.key` suffix. */
const HOST_KEY_NAME_RE = /^ssh_host_[a-z0-9]+_key(?:\.[a-z0-9]+)?$/i
/** Sentence punctuation that ends on the path: `could not read D:\keys\prod.ppk: ENOENT`. */
const TRAILING_PUNCTUATION_RE = /[.,;:)\]}>"'…。，、）】»]+$/

/** One rendered content block; the tools kernel renders `text` verbatim. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** A structured tool error the model can report instead of the tool throwing. */
export interface ToolError {
  code: string
  message: string
  retryable?: boolean
  hint?: string
}

export const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'Stable error code, e.g. INTERNAL or INVALID_INPUT.' },
    message: { type: 'string', description: 'What failed, in Chinese and English, already redacted.' },
    retryable: { type: 'boolean', description: 'Whether trying again can succeed.' },
    hint: { type: 'string', description: 'One next step for the user.' },
  },
  required: ['code', 'message'],
  additionalProperties: false,
}

/** The logger a tool module reports through; every method is optional (a test passes `{}`). */
export interface ToolLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/** What `execute` receives as its second argument from the kernel; every member is optional. */
export interface ToolExecContext {
  /** The kernel's cooperative cancellation, forwarded to the remote command. */
  signal?: AbortSignal
  /** The agent that issued the call; the reveal state is keyed by it. */
  agent?: unknown
}

/**
 * The step-time activation condition `tools.register` accepts (`ToolRegistrationOptions.when` in
 * `@deepseek-ai/dsh-tools`). The registry calls it once per step, before the step's tool batch, and
 * a `false` result removes the tool from both the model-facing declarations and dispatch — which is
 * exactly what a lazily revealed tool needs.
 */
export interface ToolRegistrationOptions {
  when?: (context: { agent?: unknown; signal?: AbortSignal }) => boolean | Promise<boolean>
}

/** One registry-ready tool definition, i.e. the fields the kernel reads. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  /** Declared only by a tool whose body has a cancellable wait the kernel may outlive. */
  timeoutMs?: number
  isConcurrencySafe: () => boolean
  execute: (args: unknown, context?: ToolExecContext) => Promise<unknown>
}

/** The `tools` service as these modules drive it: register one definition, take the disposer. */
export interface ToolsRegistry {
  register: (definition: ToolDefinition, options?: ToolRegistrationOptions) => () => void
}

/**
 * The service surface the tools read. Deliberately the narrow slice, and every member optional: a
 * tool runs against whatever the Host half mounted, and a stub must not throw here. A tool that
 * needs a member the composition lacks returns a structured "unavailable" answer, not a crash.
 */
export interface ToolService {
  init?: () => Promise<unknown>
  snapshot?: () => { hosts?: HostView[] } | null
  /** The read-only diagnostics checklist (`service.ts` `diagnose`). */
  diagnose?: (id: string) => Promise<DiagnosticsReport>
  /** One host's connect-log cursor view (`service.ts` `logView`). */
  logView?: (id: string) => ConnectLogView | null
  /** The live runtimes, for the host whose SSH link a command reuses. */
  runtimes?: Map<string, HostRuntime>
}

export function truncate(text: string, limit: number): string {
  const points = Array.from(text)
  if (points.length <= limit) return text
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/**
 * Whether one token names a private-key location. `.ssh` must be a whole path segment, so a host
 * name like `box.ssh.example.com` stays readable; a `.pem` / `.key` / `.ppk` file or an OpenSSH
 * `id_*` key counts too, because those are the key files a failed connect quotes.
 */
function isKeyPath(token: string): boolean {
  // The trailing punctuation belongs to the sentence, not to the path: without this trim a message
  // like `could not read D:\keys\prod.ppk: ENOENT` would keep its key path.
  const lowered = token.replace(TRAILING_PUNCTUATION_RE, '').toLowerCase()
  const segments = lowered.split(PATH_SEPARATOR_RE)
  if (segments.includes('.ssh')) return true
  if (KEY_FILE_SUFFIX_RE.test(lowered)) return true
  const name = segments[segments.length - 1] ?? ''
  return KEY_FILE_NAME_RE.test(name) || HOST_KEY_NAME_RE.test(name)
}

/** Replace host identifiers: the whole `SHA256:<base64>` token (prefix included) and key paths. */
export function redactHostSecrets(text: string): string {
  return text
    .replace(FINGERPRINT_RE, '<fingerprint redacted>')
    .replace(TOKEN_RE, (token) => (isKeyPath(token) ? '<private-key path>' : token))
}

/**
 * Redact and shorten one free-text value. A value that is not a non-empty string is dropped, so a
 * projected field is either a bounded redacted string or absent — never `undefined` in the result.
 *
 * The input is cut before any regular expression runs: a host field is caller- or remote-controlled
 * (an address in hosts.json, a remote error line) and this projection is synchronous, so its cost
 * must not scale with a field nobody will even see past the first few hundred characters.
 */
export function safeText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== 'string') return null
  const bounded = value.slice(0, Math.max(limit * 4, 1024))
  const cleaned = redactHostSecrets(redactText(bounded.replace(ANSI_RE, '').replace(CONTROL_RE, ''))).trim()
  if (cleaned === '') return null
  return truncate(cleaned, limit)
}

/** A bilingual line the way the Client renders it: Chinese first, English after. */
export function pairText(pair: BilingualText | null | undefined): string {
  const zh = typeof pair?.zh === 'string' ? pair.zh.trim() : ''
  const en = typeof pair?.en === 'string' ? pair.en.trim() : ''
  if (zh !== '' && en !== '') return `${zh} / ${en}`
  return zh !== '' ? zh : en
}

/** Error codes read as one vocabulary: the tools own UPPER_SNAKE, service codes are converted. */
export function upperCode(code: unknown): string {
  const text = typeof code === 'string' && code !== '' ? code : 'internal'
  return text.replaceAll('-', '_').toUpperCase()
}

export function toolError(
  code: string,
  message: unknown,
  options: { retryable?: unknown; hint?: unknown } = {},
): ToolError {
  const out: ToolError = { code, message: safeText(message, TEXT_LIMIT) ?? code }
  if (typeof options.retryable === 'boolean') out.retryable = options.retryable
  const hint = safeText(options.hint, TEXT_LIMIT)
  if (hint !== null) out.hint = hint
  return out
}

/**
 * Turn anything the service throws into a structured result, so a broken store or an unknown host
 * id is an answer the model can report instead of a throw. Only a defect this module cannot
 * describe would throw.
 */
export function serviceError(error: unknown): ToolError {
  if (isRemoteGoError(error)) {
    const view = toErrorView(error)
    const next = Array.isArray(view.nextSteps) ? view.nextSteps : []
    return toolError(upperCode(view.code), pairText(view.detail), {
      retryable: view.retryable === true,
      hint: pairText(next[0]),
    })
  }
  return toolError('INTERNAL', `插件内部异常 / internal plugin error: ${messageOf(error)}`, {
    retryable: true,
    hint: '重试一次；若仍失败请查看 DSH 日志。 / Retry once; if it keeps failing, check the DSH log.',
  })
}

/** One failure line: the code plus the bilingual reason, redacted and bounded. */
export function describeViewError(error: ErrorView | null | undefined): string | null {
  if (!error || typeof error !== 'object') return null
  const code = safeText(error.code, CODE_LIMIT) ?? 'error'
  const reason = safeText(pairText(error.detail), TEXT_LIMIT)
  return reason === null ? code : `${code}: ${reason}`
}

export function renderText(lines: string[]): TextBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The one failure line a tool's `render` prints: the code plus the hint, or a generic fallback. */
export function renderFailure(value: unknown): string {
  const result = (value ?? {}) as { error?: unknown }
  const error = (result.error ?? null) as ToolError | null
  if (!error || typeof error !== 'object') return 'error'
  const text = `${error.code ?? 'error'}: ${error.message ?? ''}`.trim()
  return error.hint ? `${text} — ${error.hint}` : text
}

/**
 * The live view of one host, or `null` when the composition cannot answer. A snapshot that throws
 * is the same "no answer" case: a projection must never take the tool down with it.
 */
export function hostViewOf(service: ToolService | null | undefined, id: string): HostView | null {
  try {
    const state = service?.snapshot?.()
    const views: HostView[] = Array.isArray(state?.hosts) ? state.hosts : []
    for (const view of views) if (view?.id === id) return view
    return null
  } catch {
    // swallow-ok: a broken snapshot is answered as "the host is unknown" by the caller
    return null
  }
}
