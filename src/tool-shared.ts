/** The building blocks every model-facing tool shares: the one redaction path a result crosses, the projection helpers
 * and the result/error vocabulary the kernel renders. Keeping them here stops a third tool from growing a quietly
 * weaker copy of either invariant (everything is redacted; a failure is a structured answer, never a throw). Pure. */
import { isRemoteGoError, toErrorView, type ErrorView } from './errors.js'
import type { ConnectLogView } from './service.js'
import type { DiagnosticsReport } from './diagnostics.js'
import type { HostRuntime } from './host-runtime.js'
import type { HostView } from './host-view.js'
import { redactText } from './redact.js'
import { messageOf } from './util.js'
import type { BilingualText } from './util.js'

/** Shape limits: one free-text field never carries more than this many characters. */
export const TEXT_LIMIT = 400,
  ADDRESS_LIMIT = 200,
  NAME_LIMIT = 120,
  ID_LIMIT = 120
/** A model-facing id or phase code is shorter than a sentence. */
export const CODE_LIMIT = 60
export const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g
export const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
// `redactText` covers tokens and key blocks but not host fingerprints or key-file paths, and a
// connect failure quotes both. The patterns stay flat on purpose: a nested path pattern backtracks
// quadratically on a long separator-free token, and `address` has no length limit upstream.
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
export interface ToolLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}
export interface ToolExecContext {
  signal?: AbortSignal // the kernel's cooperative cancellation, forwarded to the remote command
  agent?: unknown // the agent that issued the call; the reveal state is keyed by it
}
/** Evaluated once per step, before the tool batch: a `false` result hides the tool from declarations and dispatch alike. */
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
export interface ToolsRegistry {
  register: (definition: ToolDefinition, options?: ToolRegistrationOptions) => () => void
}
/** Every member is optional: a tool runs against whatever the Host half mounted, and a missing one is an answer, not a crash. */
export interface ToolService {
  init?: () => Promise<unknown>
  snapshot?: () => { hosts?: HostView[] } | null
  diagnose?: (id: string) => Promise<DiagnosticsReport> // the read-only diagnostics checklist
  logView?: (id: string) => ConnectLogView | null // one host's connect-log cursor view
  runtimes?: Map<string, HostRuntime> // the live runtimes, whose SSH link a command reuses
}
export function truncate(text: string, limit: number): string {
  const points = Array.from(text)
  if (points.length <= limit) return text
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}
/** Whether one token names a private-key location. `.ssh` must be a whole path segment, so a host name like
 * `box.ssh.example.com` stays readable; the key-file suffixes and OpenSSH `id_*` / host-key names count because those
 * are what a failed connect quotes. */
function isKeyPath(token: string): boolean {
  // The trailing punctuation belongs to the sentence, not to the path.
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
/** Redact and shorten one free-text value; a non-string or blank value is dropped, so a projected field is either a
 * bounded redacted string or absent. The input is cut before any regular expression runs — it is caller- or
 * remote-controlled and this projection is synchronous, so its cost must not scale with a field nobody reads past the
 * first few hundred characters. */
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
/** Turn anything the service throws into a result the model can report, so only an indescribable defect throws. */
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
/** The live view of one host; a snapshot that throws is the same "no answer" a projection must survive. */
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
