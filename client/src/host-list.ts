// client/src/host-list.ts - LoadingBlock, EmptyHosts, HostCard and HostListView (region 8); after dialogs.ts, before connect-window.ts.
//#region 8. host list view

interface LoadingBlockProps extends LocaleProps {
  label?: ReactNode
}

function LoadingBlock(props: LoadingBlockProps) {
  const t = translatorOf(props)
  return box('div', 'drg-loading', h(Spinner, { size: 20 }), h('span', null, props.label || t('loading')))
}

interface EmptyHostsProps extends LocaleProps {
  onAdd?: () => void
}

function EmptyHosts(props: EmptyHostsProps) {
  const t = translatorOf(props)
  const icon = h('div', { className: 'drg-empty-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 40 }))
  const add = h(Button, { variant: 'primary', testId: 'host-add-empty', onClick: props.onAdd }, t('addFirstHost'))
  return h(
    'div',
    { className: 'drg-empty', 'data-testid': 'host-list-empty' },
    icon,
    box('h3', 'drg-empty-title', t('emptyTitle')),
    box('p', 'drg-empty-body', t('emptyBody')),
    add,
  )
}

type HostCallback = ((target: Partial<HostView>) => void) | undefined

interface HostCardProps extends LocaleProps {
  host?: Partial<HostView> | null
  busy?: boolean
  onOpen?: (host: Partial<HostView>) => void
  onViewProgress?: (host: Partial<HostView>) => void
  onDisconnect?: (host: Partial<HostView>) => void
  onReconnect?: (host: Partial<HostView>) => void
  onRestart?: (host: Partial<HostView>) => void
  onStopRemote?: (host: Partial<HostView>) => void
  onEdit?: (host: Partial<HostView>) => void
  onDelete?: (host: Partial<HostView>) => void
  onDiagnose?: (host: Partial<HostView>) => void
}

function HostCard(props: HostCardProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const host: Partial<HostView> = props.host || {}
  const busy = props.busy === true
  const meta = statusOf(host.status)
  const statusLabel = t(meta.label)
  const remoteVersion =
    host.remote && typeof host.remote.version === 'string' && host.remote.version.length > 0
      ? host.remote.version
      : t('versionPending')
  const lastOpened = host.lastOpenedAt ? formatTime(host.lastOpenedAt, locale) : t('neverOpened')
  const reason = host.error ? resolveText(host.error.detail, locale) || resolveText(host.error.title, locale) : ''
  // A host stays `connecting` while the web restarts or stops: no "connection lost", and the code names the action.
  const code = host.status === 'connecting' && host.progress ? host.progress.code : ''
  const restarting = code === 'restarting-remote'
  const stopping = code === 'stopping-remote'
  const connecting = host.status === 'connecting'
  const linkBusy = busy || restarting || stopping
  // `remote-unreachable` keeps the SSH session, so restart joins reconnect: both one-shot actions stay available.
  const recoverable = host.status === 'error' && host.error !== null && host.error.code === 'remote-unreachable'
  const restartAvailable = host.status === 'connected' || restarting || recoverable
  const stopAvailable = host.status === 'connected' || restarting || stopping || recoverable
  const parity = host.versionParity || null
  const parityText = parity
    ? resolveText(parity.message, locale) ||
      t('versionDifferent', { remote: parity.remote || '?', local: parity.local || host.targetVersion || '?' })
    : ''
  const fire = (callback?: (target: Partial<HostView>) => void) => () => {
    if (typeof callback === 'function') callback(host)
  }
  /** Clicking the card body is the switcher's gesture: it opens the connecting host's window. */
  // A click that starts inside a button belongs to that button only.
  const openProgress = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as Element | null
    if (target && typeof target.closest === 'function' && target.closest('button')) return
    if (typeof props.onViewProgress === 'function') props.onViewProgress(host)
  }
  const iconButton = (testId: string, icon: ReactNode, label: ReactNode, callback: HostCallback, disabled: boolean) =>
    h(IconButton, { icon, label, testId, onClick: fire(callback), disabled })
  const ghost = (testId: string, label: ReactNode, callback: HostCallback, disabled: boolean, ariaLabel?: string) =>
    h(Button, { variant: 'ghost', testId, ariaLabel, onClick: fire(callback), disabled }, label)
  const stripText = meta.strip === 'alert' ? t('errorReason', { detail: reason || t(meta.hint) }) : t(meta.hint)
  const stripDiagnose = h(
    'button',
    { type: 'button', className: 'drg-linkbtn', onClick: fire(props.onDiagnose) },
    t('cardDiagnose'),
  )
  const stripRow = meta.strip
    ? h(
        'div',
        { className: 'drg-card-strip', role: meta.strip },
        h(IconAlert, { size: 14 }),
        box('span', 'drg-card-strip-text', stripText),
        meta.strip === 'alert' ? stripDiagnose : null,
      )
    : null
  const head = box(
    'div',
    'drg-card-head',
    h(StatusDot, { status: host.status, title: statusLabel }),
    h('h3', { className: 'drg-card-name', title: host.name }, host.name || host.id),
    h(Badge, { tone: meta.tone, title: t(meta.hint) }, statusLabel),
  )
  const address = h('div', { className: 'drg-card-address', title: displayAddress(host) }, displayAddress(host) || '—')
  const progressLine =
    host.status === 'connecting' && host.progress
      ? h('p', { className: 'drg-card-progress', 'data-progress': host.progress.code }, progressText(t, host.progress))
      : null
  const metaRow = (label: ReactNode, value: ReactNode) => h('div', null, h('dt', null, label), h('dd', null, value))
  const metaList = box(
    'dl',
    'drg-card-meta',
    metaRow(t('remoteVersion'), remoteVersion),
    metaRow(t('lastOpened'), lastOpened),
  )
  // Both contract fields are now painted: a shared ~/.dsh warning or a version difference shows on the card.
  const warningNotice = h(Notice, { tone: 'warn', title: t('hostWarnings') }, resolveText(host.warning, locale))
  const warningEl = h('div', { 'data-testid': 'host-warning' }, warningNotice)
  const warning = host.warning ? warningEl : null
  const parityEl = h('div', { 'data-testid': 'host-version-parity' }, h(Notice, { tone: 'warn' }, parityText))
  const parityNotice = parity && parity.status === 'different' ? parityEl : null
  const unknownEl = h('p', { className: 'drg-field-hint', 'data-testid': 'host-version-unknown' }, t('versionUnknown'))
  const unknown = parity && parity.status === 'unknown' ? unknownEl : null
  const primaryLabel = connecting ? t('cardViewProgress') : t(meta.action)
  const openClick = () => (connecting ? fire(props.onViewProgress)() : fire(props.onOpen)())
  const primaryProps = {
    variant: host.status === 'connected' ? 'primary' : 'secondary',
    testId: connecting ? 'host-view-progress' : 'host-open',
    onClick: openClick,
    disabled: connecting ? busy : busy || meta.wait === true,
    busy: busy && host.status !== 'connected' && host.status !== 'connecting',
  }
  const endActions = box(
    'div',
    'drg-card-actions-end',
    iconButton('host-diagnose', h(IconPulse), t('cardDiagnose'), props.onDiagnose, busy),
    // Editing while a link is being built would race the connection's own settings.
    iconButton('host-edit', h(IconEdit), t('cardEdit'), props.onEdit, busy || connecting),
    iconButton('host-delete', h(IconTrash), t('cardDelete'), props.onDelete, busy || connecting),
  )
  const actions = box(
    'div',
    'drg-card-actions',
    h(Button, primaryProps, primaryLabel),
    host.status === 'connected' ? ghost('host-disconnect', t('cardDisconnect'), props.onDisconnect, busy) : null,
    restartAvailable
      ? ghost(
          'host-restart',
          restarting ? t('cardRestarting') : t('cardRestart'),
          props.onRestart,
          linkBusy,
          t('cardRestartName'),
        )
      : null,
    stopAvailable
      ? ghost(
          'host-stop-remote',
          stopping ? t('cardStopping') : t('cardStopRemote'),
          props.onStopRemote,
          linkBusy,
          t('cardStopRemoteName'),
        )
      : null,
    meta.retry === true ? ghost('host-reconnect', t('cardReconnect'), props.onReconnect, busy) : null,
    endActions,
  )
  const cardProps = {
    className: 'drg-host-card',
    'data-status': host.status,
    'data-testid': 'host-card',
    'data-host-id': host.id,
    // The body is a click target while the link is being built (the visible button stays the AT path).
    'data-interactive': connecting ? 'true' : undefined,
    onClick: connecting ? openProgress : undefined,
  }
  return h('li', cardProps, stripRow, head, address, progressLine, metaList, warning, parityNotice, unknown, actions)
}

interface HostListViewProps extends LocaleProps {
  state?: StateView | null
  loading?: boolean
  error?: unknown
  busyHostId?: string | null
  mode?: StreamMode
  onRetryLive?: (() => void) | null
  onAdd?: () => void
  onRefresh?: () => void
  onOpenSettings?: () => void
  onOpenHost?: (host: Partial<HostView>) => void
  onViewProgress?: (host: Partial<HostView>) => void
  onDisconnectHost?: (host: Partial<HostView>) => void
  onReconnectHost?: (host: Partial<HostView>) => void
  onRestartHost?: (host: Partial<HostView>) => void
  onStopRemote?: (host: Partial<HostView>) => void
  onEditHost?: (host: Partial<HostView>) => void
  onDeleteHost?: (host: Partial<HostView>) => void
  onDiagnoseHost?: (host: Partial<HostView>) => void
}

function HostListView(props: HostListViewProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const state = props.state || null
  const loading = props.loading === true
  const error = props.error || null
  const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
  // Every host keeps its card: it carries the phase and the way back to the connect window; a stale one is never drawn.
  const visibleHosts = hosts.filter((host) => Boolean(host))
  const connected = hosts.filter((host) => host && host.status === 'connected').length
  const busyHostId = props.busyHostId || null
  // Stopping a remote DSH is destructive, so the card only confirms; the dialog owns busy until the Host answers.
  const [pendingStop, setPendingStop] = useState<Partial<HostView> | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const requestStop = (host: Partial<HostView> | null | undefined) => {
    if (host) setPendingStop(host)
  }
  const confirmStop = () => {
    if (pendingStop === null || stopBusy) return
    const host = pendingStop
    setStopBusy(true)
    const settle = () => {
      setStopBusy(false)
      setPendingStop(null)
    }
    Promise.resolve(typeof props.onStopRemote === 'function' ? props.onStopRemote(host) : null).then(settle, settle)
  }
  const card = (host: Partial<HostView>) =>
    h(HostCard, {
      key: host.id,
      t,
      locale,
      host,
      busy: busyHostId === host.id,
      onOpen: props.onOpenHost,
      onViewProgress: props.onViewProgress,
      onDisconnect: props.onDisconnectHost,
      onReconnect: props.onReconnectHost,
      onRestart: props.onRestartHost,
      onStopRemote: requestStop,
      onEdit: props.onEditHost,
      onDelete: props.onDeleteHost,
      onDiagnose: props.onDiagnoseHost,
    })
  const list = h('ul', { className: 'drg-host-list', 'data-testid': 'host-list' }, visibleHosts.map(card))
  const summary = box(
    'div',
    'drg-summary',
    h(StatusDot, { status: connected > 0 ? 'connected' : 'idle' }),
    h('span', null, t('summary', { connected, total: hosts.length })),
  )
  const stopDialog = h(StopRemoteDialog, {
    key: 'stop-remote:' + (pendingStop ? pendingStop.id : ''),
    t,
    busy: stopBusy,
    onConfirm: confirmStop,
    onCancel: () => !stopBusy && setPendingStop(null),
  })
  const stopDialogNode = pendingStop !== null ? stopDialog : null
  const body = box('div', 'drg-host-body', summary, visibleHosts.length > 0 ? list : null, stopDialogNode)
  const retryProps = {
    variant: 'secondary',
    testId: 'live-reconnect',
    onClick: props.onRetryLive,
    disabled: typeof props.onRetryLive !== 'function',
  }
  const lostText =
    props.mode === 'reconnecting'
      ? t('liveReconnecting')
      : t('liveStreamLostBody', { seconds: Math.round(POLL_INTERVAL_MS / 1000) })
  // The stream died and the panel is polling: say so instead of stale numbers, and offer to restore live updates.
  // It stays up while a reconnect is in flight: only an actual `open` or first frame clears it.
  const liveBanner =
    props.mode === 'polling' || props.mode === 'reconnecting'
      ? box(
          'div',
          'drg-live-banner',
          h(Notice, { tone: 'warn', title: t('liveStreamLostTitle') }, lostText),
          h(Button, retryProps, t('liveReconnect')),
        )
      : null
  let content
  if (state === null && error !== null) {
    content = h(ErrorCard, {
      t,
      locale,
      error: toErrorView(error),
      onRetry: props.onRefresh ? () => props.onRefresh() : undefined,
    })
  } else if (state === null) {
    content = h(LoadingBlock, { t, label: t('loading') })
  } else if (hosts.length === 0) {
    content = h(EmptyHosts, { t, onAdd: props.onAdd })
  } else {
    content = body
  }
  const title = box('h1', 'drg-page-title', t('hostsTitle'))
  const subtitle = box('p', 'drg-page-subtitle', t('panelSubtitle'))
  const heading = box('div', 'drg-page-heading', title, subtitle)
  const plus = h(IconPlus, { size: 14 })
  const refreshIcon = h(IconRefresh, { size: 14 })
  const addLabel = h('span', null, t('addHost'))
  const refreshLabel = h('span', null, t('refresh'))
  const addButton = h(Button, { variant: 'primary', testId: 'host-add', onClick: props.onAdd }, plus, addLabel)
  const refreshButton = h(
    Button,
    { variant: 'ghost', testId: 'host-refresh', onClick: props.onRefresh, busy: loading },
    refreshIcon,
    refreshLabel,
  )
  const settingsButton = h(IconButton, {
    icon: h(IconGear),
    label: t('settings'),
    testId: 'host-settings',
    onClick: props.onOpenSettings,
  })
  const header = box(
    'header',
    'drg-page-head',
    heading,
    box('div', 'drg-page-actions', addButton, refreshButton, settingsButton),
  )
  return box('div', 'drg-page drg-host-page', header, content, liveBanner)
}
