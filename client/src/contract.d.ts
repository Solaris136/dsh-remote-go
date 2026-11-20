// client/src/contract.d.ts - the Host's JSON contract (docs/api.md §0) and the client's own inter-module shapes.
// A `.d.ts` so the client build, which concatenates client/src, skips it: no runtime code, dist/client.js unchanged.
// Views, not inputs: src/ produces this JSON and docs/api.md freezes the names, so the guards narrow `unknown`.
// `strict` is off; a member is declared only when the client reads it.

/** The bilingual pair every renderer resolves with `resolveText`. */
type I18nText = { zh: string; en: string }
/** The view every failure surface renders. */
interface ErrorView {
  code: string
  title: I18nText
  detail: I18nText
  nextSteps: I18nText[]
  retryable: boolean
  technical?: string
  /** `invalid-input` answers name the field they refused (`docs/api.md` §1). */
  field?: string
}
type HostStatus =
  | 'unconfigured'
  | 'connecting'
  | 'fingerprint-pending'
  | 'conflict-pending'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'limited'
type ConnectPhase = 'ssh' | 'probe' | 'bootstrap' | 'start' | 'tunnel' | 'verifying' | 'ready'
type Progress = { code: string; params?: Record<string, string | number> }
interface FingerprintView {
  sha256: string
  keyType: string
  status: 'pending' | 'pinned' | 'changed' | 'observed'
  pinned?: string | null
}
interface ConnectLogEntry {
  seq: number
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  phase: ConnectPhase | null
  message: string
  text?: I18nText
  boundary?: true
}
/** `GET /events/logs`'s `log` frame (v2.12): one stream multiplexes every visible host. */
interface ConnectLogFrame {
  hostId: string
  instance: string
  attempt: number
  seq: number
  reset?: true
  visible: boolean
  entries: ConnectLogEntry[]
}
/** `GET /events/logs`'s `log-end` frame: this attempt will produce no further rows. */
type ConnectLogEnd = { hostId: string; attempt: number }
interface RemoteView {
  version: string | null
  uiReady: boolean
  localPort: number | null
  port: number | null
  pid: number | null
  dshHome: string | null
  profile: string | null
  bootstrapLevel: string | null
  nodeVersion: string | null
  nodeSource: 'managed' | null
  startedAt: string | null
  viewRev: number
}
/** `HostView.conflict`: only non-null while `status === 'conflict-pending'`. */
interface HostConflictView {
  detectedAt: string
  processes: { pid: number; command: string }[]
}
/** `HostView.versionParity`: the local/remote version comparison the row renders. */
interface VersionParityView {
  status: 'same' | 'different' | 'unknown'
  local: string | null
  remote: string | null
  same: boolean
  message: I18nText
}
interface HostView {
  id: string
  name: string
  address: string
  addressMasked: string
  username: string | null
  port: number
  authType: 'key' | 'password'
  authKeyPath: string | null
  passwordSaved: boolean
  passwordStorageAvailable: boolean
  jumpHost: string | null
  status: HostStatus
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  warning: I18nText | null
  fingerprint: FingerprintView | null
  conflict: HostConflictView | null
  logs: ConnectLogEntry[]
  logAttempt: number
  logSeq: number
  remote: RemoteView
  keepAlive: 'keep' | 'stop' | 'idle'
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: 'first-use' | 'strict'
  targetVersion: string | null
  versionParity: VersionParityView
  lastOpenedAt: string | null
  createdAt: string
  updatedAt: string
  storeCorrupt: boolean
}
// The job's lifecycle: the Host's three wire phases plus the card's own `saving` (bytes land) and `done` (path known).
// docs/api.md freezes only the wire half; the two local phases are the card's own.
type DownloadPhase = 'preparing' | 'ready' | 'saving' | 'done' | 'error'
interface DownloadJobView {
  id: string
  hostId: string
  path: string
  name: string
  kind: 'file' | 'folder' | null
  phase: DownloadPhase
  totalBytes: number
  doneBytes: number
  totalFiles: number
  doneFiles: number
  ignoredNames?: string[]
  destination: string | null
  startedAt: string
  error: ErrorView | null
}
interface SettingsView {
  defaultPort: number
  defaultAuth: 'key' | 'password'
  defaultKeyPath: string
  connectTimeoutSec: number
  autoReconnect: { enabled: boolean; maxAttempts: number; baseDelayMs: number }
  remoteHeartbeat: { enabled: boolean; intervalSec: number }
  hostKeyPolicy: 'first-use' | 'strict'
  saveTokens: boolean
  language: 'auto' | 'zh' | 'en'
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  bootstrap: { profile: string }
}
interface StateView {
  rev: number
  instance: string
  hostVersion: string | null
  targetVersion: string | null
  hosts: HostView[]
  settings: SettingsView
  activeHostId: string | null
  firstRun: boolean
  passwordStorageAvailable: boolean
  storeCorrupt: boolean
}

// ---- the rest of the frozen endpoints --------------------------------------------------------

/** `GET /ssh/aliases` row: an alias `~/.ssh/config` offers to the wizard. */
type SshAliasEntry = { alias: string; host: string; user: string | null; port: number; source: string }
/** `GET /ssh/aliases`'s `knownHosts` summary; `null` when the file has none to report. */
type KnownHostsSummary = { entries: number; hashed: number; hosts: string[] }
/** `GET /keyfile/list?path=` row: one entry of the private-key chooser. */
type KeyFileEntry = { name: string; path: string; isDirectory: boolean }
/** `GET /keyfile/list?path=`: the listing the key picker renders and pages through. */
interface KeyFileListing {
  path: string
  parent: string | null
  entries: KeyFileEntry[]
  truncated: boolean
  defaultKeyPath: string
  defaultDir: string
}
/** `POST /hosts/:id/diagnose`'s report; `summary` drives the card's tone. */
interface DiagnoseCheck {
  id: string
  title: I18nText
  status: 'pass' | 'warn' | 'fail' | 'skip'
  detail: I18nText
}
interface DiagnoseRestart {
  at: string
  kind: 'local-restart' | 'remote-reattach'
  fromPort: number | null
  toPort: number | null
  pid: number | null
  reason: string
  source: 'registry' | 'log'
}
interface DiagnoseReport {
  summary: 'ok' | 'warning' | 'error'
  checks: DiagnoseCheck[]
  restarts: DiagnoseRestart[]
  redacted: boolean
  generatedAt: string
  logs: string[]
}
/** `POST /hosts/:id/connect`'s request body: the password is one-shot unless remembered. */
type ConnectRequest = { password?: string; rememberPassword?: boolean }
/** `POST /hosts/:id/password`'s request body: set the saved password, or clear the record. */
type SavePasswordRequest = { password?: string; clear?: boolean }
/** `POST /hosts/:id/restart`'s answer, as far as the overlay reads it. */
type RestartResult = { accepted?: boolean; reason?: string }
/** `POST /settings`'s patch: every branch may arrive on its own (the Host deep-merges it). */
interface SettingsPatch {
  defaultPort?: number
  defaultAuth?: 'key' | 'password'
  defaultKeyPath?: string
  connectTimeoutSec?: number
  autoReconnect?: Partial<SettingsView['autoReconnect']>
  remoteHeartbeat?: Partial<SettingsView['remoteHeartbeat']>
  hostKeyPolicy?: 'first-use' | 'strict'
  saveTokens?: boolean
  language?: 'auto' | 'zh' | 'en'
  logLevel?: 'error' | 'warn' | 'info' | 'debug'
  bootstrap?: Partial<SettingsView['bootstrap']>
}
/** `GET /ssh/aliases`: the config aliases plus the known-hosts summary. */
type SshAliasesResult = { aliases: SshAliasEntry[]; knownHosts: KnownHostsSummary | null }
/** The JSON envelope every endpoint answers with; `apiRequest` throws unless `ok === true`. */
type ApiEnvelope = { ok?: boolean; error?: LocalErrorView }
/** `subscribeState`'s disposer, which also carries the banner's manual retry. */
interface StateStreamDispose {
  (): void
  reconnect(): void
}
/** The connect-log channel's internal mode; only `off` matters to the panel, and it is silent. */
type ConnectLogMode = 'idle' | 'live' | 'off' | 'reconnecting'
/** A download handler, swapped per render through a ref (`DownloadHandler` in plugin-overlay). */
type DownloadJobHandler = (job: DownloadJobView) => void
/** `useRemoteState`'s surface: the tree, the stream's status and the merge entry points. */
interface RemoteState {
  state: StateView | null
  error: ErrorView | null
  loading: boolean
  mode: StreamMode
  refresh: () => Promise<void>
  patch: (updater: (current: StateView) => StateView) => void
  reconnectStream: () => void
  applyLog: (frame: ConnectLogFrame) => void
  applyLogEnd: (end: ConnectLogEnd) => void
}

// ---- the carrier layer (the guest / frame that shows a remote UI) ---------------------------

/** What `showOverlay` is called with: every member arrives from the overlay's own state. */
interface CarrierShowOptions {
  hostId?: string
  url?: string
  message?: string
  localLabel?: string
  viewRev?: number | null
}
// One warm carrier: the two backends fill different halves, so only the shared members are required.
// `strict` is off, so an absent optional reads as `undefined`, exactly like the old implicit `any`.
interface CarrierEntry {
  kind: 'desktop' | 'web'
  backend: CarrierBackend
  hostId: string
  root: HTMLElement
  url: string
  /** The attach revision the current navigation belongs to (`RemoteView.viewRev`). */
  viewRev?: number | null
  rowInstalled: boolean
  ready: boolean
  readyWaiters: ((value: boolean) => void)[]
  revealToken: number
  /** Host-row poll interval (desktop) or reveal timer (web): one handle per entry. */
  timer: TimerHandle | null
  /** Install retries for the current document; the pool's retry chain increments it. */
  installAttempts?: number
  installTimer?: TimerHandle | null
  /** Set when the guest's document failed to load; the next reveal retries it once. */
  failed?: boolean
  /** The localized line a frame shows when the document is not the DSH UI. */
  notDshMessage?: string
  /** Desktop guest only. */
  lease?: string
  view?: WebviewElement
  grip?: HTMLElement | null
  caption?: { height: number } | null
  captionApplied?: boolean
  sidebarCollapsed?: boolean | null
  sidebarStart?: string
  /** Browser frame only. */
  frame?: HTMLIFrameElement
  errorLayer?: CarrierErrorLayer
  loadGuard?: CarrierLoadGuard | null
}
/** The one-shot "the document never committed" timer behind a framed carrier. */
interface CarrierLoadGuard {
  arm(): void
  cancel(): void
  dispose(): void
}
/** The per-surface operations the pool drives; both backends implement exactly this. */
interface CarrierBackend {
  kind: 'desktop' | 'web'
  create(
    hostId: string,
    url: string,
    message: unknown,
    options: CarrierShowOptions,
  ): Promise<CarrierEntry | null> | CarrierEntry
  load(entry: CarrierEntry, url: string): void | Promise<void>
  pushRow(entry: CarrierEntry, payload: unknown): void
  waitReady(entry: CarrierEntry): Promise<unknown>
  dispose(entry: CarrierEntry): unknown
  poll: ((entry: CarrierEntry) => void) | null
}
/** The live guests, most recently shown first (`carrierPool`). */
interface CarrierPool {
  entries: CarrierEntry[]
  current: string | null
  wanted: string | null
  /** The entry whose host-row poll is armed (`stopHostRowPoll` clears it). */
  poll: CarrierEntry | null
}
/** What an untrusted guest page sends: every member is `unknown` until a `typeof` check reads it. */
interface GuestIntentLike {
  action?: unknown
  kind?: unknown
  path?: unknown
  name?: unknown
  id?: unknown
  text?: unknown
  tone?: unknown
  url?: unknown
  code?: unknown
  hostId?: unknown
  target?: unknown
  collapsed?: unknown
  start?: unknown
}
/** What `sanitizeGuestIntent` lets through, after the allow-list and the host override. */
interface SafeGuestIntent {
  action?: string
  target?: string
  hostId?: string
  kind?: string
  path?: string
  name?: string
  id?: string
  text?: unknown
  tone?: unknown
  url?: unknown
  code?: unknown
}
/** The rail report a guest queues: `{ collapsed, start }` from `mountSidebarMirror`. */
type GuestSidebarReport = { collapsed: unknown; start?: unknown }

// ---- the host switcher row ------------------------------------------------------------------

type SwitcherLabels = { local: string; addHost: string; manage: string; exit: string }
type SwitcherHost = { id: string; name: string; address: string; status: string }
type SwitcherPayload = { current: string; hosts: SwitcherHost[]; labels: SwitcherLabels }
/** The receipt a capability intent may return (or a promise of one). */
interface IntentReceipt {
  ok?: boolean
  then?: (onfulfilled: (value: IntentReceipt) => unknown, onrejected?: (reason: unknown) => unknown) => unknown
  catch?: (onrejected: (reason: unknown) => unknown) => unknown
}
/** The switcher's one dispatch entry point; `plugin.ts` assigns it, `guest-host-row.ts` calls it. */
type SwitcherDispatch = (intent: SafeGuestIntent) => IntentReceipt | boolean | undefined
/** The row's live state: the local DOM copy and every push read this object. */
interface SwitcherState {
  current: string
  hosts: HostView[]
  labels: SwitcherLabels
  dispatch: SwitcherDispatch | null
  labelsOf: (() => SwitcherLabels) | null
  installed: boolean
}
/** `updateSwitcher`'s patch: any subset, validated member by member. */
type SwitcherPatch = { hosts?: HostView[]; current?: unknown; labels?: Partial<SwitcherLabels> }
/** The `/state` feed's connection mode, as the fallback banner spells it. */
type StreamMode = 'idle' | 'live' | 'polling' | 'reconnecting'
/** `subscribeState`'s callbacks: every one is optional at the call site. */
interface StateStreamHandlers {
  onState?: (state: StateView) => void
  onStatus?: (mode: StreamMode) => void
  onError?: (error: unknown) => void
  onDownload?: (job: DownloadJobView) => void
}

// ---- the client's own shared shapes ----------------------------------------------------------

/** The status table's row: `TONE_VARS` key plus the dictionary keys `statusOf` derives. */
type Tone = 'idle' | 'info' | 'success' | 'warn' | 'error' | 'limited'
interface StatusEntry {
  tone: Tone
  action: DictKey
  connect?: boolean
  wait?: boolean
  window?: boolean
  retry?: boolean
  strip?: string
}
/** What `STATUS[status]` plus its derived label/hint keys looks like to a renderer. */
interface StatusView extends StatusEntry {
  label: DictKey
  hint: DictKey
}
type ToastEntry = { id: number | string; text: ReactNode; tone: Tone }
/** `t()` with a runtime-built key: `progress.<code>` comes from the contract, not the dictionary. */
type LooseTranslate = (key: string, params?: DictParams) => string
/** The wizard's draft: a host being added or edited, before any request is made. */
type HostDraft = { mode: 'add' | 'edit'; host: HostLike | null }
/** A queued command from an injected guest page or the switcher row. */
type ToolRequest =
  { kind: 'download'; hostId: string; path: string; name: string } | { kind: 'notice'; text: string; tone: Tone }
// The overlay's one-slot panel request: `kind` stays a plain string because `createPanelRequestStore` validates it.
type PanelRequest = { kind: string; hostId?: string }
type WizardOpenInput = { mode?: string; host?: HostLike | null }
/** `createStore`: one-slot change notification, `subscribe` returns its release. */
interface Store {
  emit(): void
  subscribe(listener: () => void): () => void
}
/** The panel-request slot the overlay host subscribes to (see `createPanelRequestStore`). */
interface PanelRequestStore {
  request(hostId: unknown): void
  requestIntent(intent: PanelRequest | null | undefined): void
  take(): PanelRequest | null
  subscribe: (listener: () => void) => () => void
}
/** The wizard's open/close/current slot, usable from any page. */
interface WizardStore {
  open(next: WizardOpenInput | null | undefined): void
  close(): void
  current(): HostDraft | null
  subscribe: (listener: () => void) => () => void
}
/** What a guest page may ask for: a download, or a line for the shell's toast. */
interface ToolRequestInput {
  hostId?: unknown
  kind?: unknown
  path?: unknown
  name?: unknown
  text?: unknown
  tone?: unknown
}
/** The command queue drained by the overlay host. */
interface ToolRequestStore {
  requestDownload(request: ToolRequestInput | null | undefined): void
  requestNotice(request: ToolRequestInput | null | undefined): void
  take(): ToolRequest | null | undefined
  subscribe: (listener: () => void) => () => void
}

// ---- the card's own job view, and the overlay host's per-render state ------------------------

// One download card: the Host's frame is full, this keeps a merged map, so every member but `id` is optional.
// A partial frame merges onto the previous one, and the card adds the local `done` phase.
interface DownloadCardView {
  id: string
  phase: DownloadPhase
  hostId?: string
  path?: string
  name?: string
  kind?: 'file' | 'folder' | null
  totalBytes?: number
  doneBytes?: number
  totalFiles?: number
  doneFiles?: number
  ignoredNames?: string[]
  destination?: string | null
  startedAt?: string
  error?: ErrorView | null
}
/** The launch URL kept for one attach: host, both URLs and the `viewRev` they belong to. */
type RemoteUrlState = { hostId: string; url: string; webUrl: string; viewRev: number | null }
/** An open password prompt: which host, why, and the last failure to show in it. */
type PasswordPromptState = { host: HostLike; intent: 'open' | 'reconnect'; error: string | null; busy?: boolean }
type DiagnoseState = {
  host: HostLike
  status: 'loading' | 'done' | 'error'
  report: DiagnoseReport | null
  error: ErrorView | null
}
/** The overlay host's props: its stores, its initial snapshot and the shell's picker. */
interface PluginOverlayProps extends LocaleProps {
  initialState?: StateView | null
  pickDirectory?: () => unknown
  panelStore?: PanelRequestStore | null
  wizardStore?: WizardStore | null
  toolStore?: ToolRequestStore | null
}
/** What `createOverlayActions` gets each render, rebuilt so every command closure reads the state of its own render. */
interface OverlayActionDeps {
  props: PluginOverlayProps
  t: Translate
  locale: DictLocale
  notify: (text: ReactNode, tone?: Tone) => void
  errorMessage: (error: unknown) => string
  remote: RemoteState
  downloadJobsRef: { current: Record<string, DownloadCardView> }
  setDownloadJobs: (next: Record<string, DownloadCardView>) => void
  downloadPolls: { current: Map<string, TimerHandle> }
  downloadRemoval: { current: Map<string, TimerHandle> }
  downloadHandlerRef: { current: DownloadJobHandler }
  target: string | null
  setTarget: (value: string | null | ((current: string | null) => string | null)) => void
  setManageOpen: (open: boolean | ((current: boolean) => boolean)) => void
  setManageView: (view: string) => void
  setConnectHostId: (id: string | null) => void
  setRemoteUrl: (value: RemoteUrlState | null | ((current: RemoteUrlState | null) => RemoteUrlState | null)) => void
  setBusyHostId: (id: string | null) => void
  diagnose: DiagnoseState | null
  setDiagnose: (value: DiagnoseState | null | ((current: DiagnoseState | null) => DiagnoseState | null)) => void
  pendingDelete: HostLike | null
  setPendingDelete: (value: HostLike | null) => void
  deleting: boolean
  setDeleting: (value: boolean) => void
  deleteArmed: boolean
  setDeleteArmed: (value: boolean) => void
  setPasswordPrompt: (
    value: PasswordPromptState | null | ((current: PasswordPromptState | null) => PasswordPromptState | null),
  ) => void
  setConflictBusy: (value: boolean) => void
  setFingerprintBusy: (value: boolean) => void
  hostsRef: { current: HostView[] }
  pendingSwitch: { current: string | null }
  pendingIntent: { current: PanelRequest | null }
}
// A host as an action receives it: `HostView` is assignable and the rest is read defensively as `Partial<HostView>`.
type HostLike = Partial<HostView> & { id: string }
type GuestReceipt = { id?: unknown; ok?: unknown; reason?: unknown }
/** A guest click/contextmenu event: same as the DOM's, with the target the scripts walk. */
interface GuestMouseEvent extends MouseEvent {
  target: EventTarget & Element
}
/** A guest keydown event: same as the DOM's, with the target the scripts walk. */
interface GuestKeyboardEvent extends KeyboardEvent {
  target: EventTarget & Element
}
/** One focus candidate: form controls and links have `focus`, a plain `Element` does not. */
interface FocusableElement extends Element {
  focus(): void
  disabled?: boolean
}
/** One pushed dialog. `returnFocus` is filled by the stack when it opens. */
interface DialogLayer {
  layer: HTMLElement
  dialog: HTMLElement
  initialFocusTestId?: string
  dismissible: () => boolean
  close: () => void
  returnFocus?: FocusableElement | null
}
/** What `useDialogLayer` is called with: the two refs plus the dialog's dismissal contract. */
interface DialogLayerOptions {
  layerRef: { current: HTMLElement | null }
  dialogRef: { current: HTMLElement | null }
  onClose?: (() => void) | null
  dismissible?: boolean
  initialFocusTestId?: string
}
/** The shared stack `dialogStack()` hands back. */
interface DialogStack {
  push(layer: DialogLayer): () => void
  remove(layer: DialogLayer): void
  top(): DialogLayer | null
  size(): number
  keydown(event: KeyboardEvent): void
}
interface ModalProps {
  wide?: boolean
  title?: ReactNode
  subtitle?: ReactNode
  onClose?: (() => void) | null
  closeLabel?: ReactNode
  testId?: string
  busy?: boolean
  dismissible?: boolean
  initialFocusTestId?: string
  ariaLabel?: string
  footer?: ReactNode
  children?: ReactNode
}
interface ConfirmDialogProps {
  title?: ReactNode
  body?: ReactNode
  testId?: string
  busy?: boolean
  cancelTestId?: string
  confirmTestId?: string
  cancelLabel?: ReactNode
  confirmLabel?: ReactNode
  onCancel?: () => void
  onConfirm?: () => void
}
interface StopRemoteDialogProps extends LocaleProps {
  busy?: boolean
  onConfirm?: () => void
  onCancel?: () => void
}
/** The label/field wrapper `formRow` and every form uses. */
interface FieldProps {
  wide?: boolean
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  errorId?: string
  children?: ReactNode
}
interface TextInputProps {
  type?: string
  value?: unknown
  placeholder?: string
  list?: string
  disabled?: boolean
  autoComplete?: string
  testId?: string
  onChange?: (value: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
  ariaLabel?: string
  invalid?: boolean
  describedBy?: string
}
type SelectOption = { value: string; label: string }
interface SelectProps {
  options?: SelectOption[]
  value?: unknown
  disabled?: boolean
  ariaLabel?: string
  invalid?: boolean
  describedBy?: string
  testId?: string
  onChange?: (value: string) => void
}
/** One form row's description: which draft key it edits and how it renders. */
interface FormRowSpec {
  key: string
  label: string
  hint?: string
  error?: string
  testId?: string
  kind?: string
  placeholder?: string
  options?: string[][]
  after?: (value: string) => void
}
interface CheckRowProps {
  checked?: boolean
  disabled?: boolean
  testId?: string
  label?: ReactNode
  onChange?: (checked: boolean) => void
}
interface NoticeProps {
  tone?: 'info' | 'success' | 'warn' | 'error'
  title?: ReactNode
  testId?: string
  children?: ReactNode
}
