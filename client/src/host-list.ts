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
  return h(
    'div',
    { className: 'drg-empty', 'data-testid': 'host-list-empty' },
    h('div', { className: 'drg-empty-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 40 })),
    box('h3', 'drg-empty-title', t('emptyTitle')),
    box('p', 'drg-empty-body', t('emptyBody')),
    h(
      Button,
      {
        variant: 'primary',
        testId: 'host-add-empty',
        onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
      },
      t('addFirstHost'),
    ),
  )
}

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
  const primaryDisabled = busy || meta.wait === true
  // A restart of the managed remote web is visible on the card itself: the host is
  // `connecting` (not `disconnected`) while it runs, so no "connection lost" shows up.
  const restarting =
    host.status === 'connecting' && host.progress !== null && host.progress.code === 'restarting-remote'
  // The explicit stop is the same kind of one-shot link action, under its own progress code.
  const stopping = host.status === 'connecting' && host.progress !== null && host.progress.code === 'stopping-remote'
  // A connecting host's primary action is not "connect" (it is already doing that): it is the way
  // back to the window that prints the progress and the log, after the user closed it.
  const connecting = host.status === 'connecting'
  /**
   * Clicking the card is the same gesture as the switcher's host item: it opens the connecting
   * host's window. The card's own controls (restart, stop, diagnose, edit, delete) keep their own
   * action - a click that starts inside a button belongs to that button only.
   */
  const openProgress = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as Element | null
    if (target && typeof target.closest === 'function' && target.closest('button')) return
    if (typeof props.onViewProgress === 'function') props.onViewProgress(host)
  }
  // `remote-unreachable` keeps the SSH session on purpose, so a restart is the other way
  // back besides reconnecting (docs/design.md §5.6).
  const recoverable = host.status === 'error' && host.error !== null && host.error.code === 'remote-unreachable'
  const restartAvailable = host.status === 'connected' || restarting || recoverable
  const stopAvailable = host.status === 'connected' || restarting || stopping || recoverable

  return h(
    'li',
    {
      className: 'drg-host-card',
      'data-status': host.status,
      'data-testid': 'host-card',
      'data-host-id': host.id,
      // The card body is a click target while the link is being built, so a click anywhere on the
      // host opens its progress window (the visible button stays the keyboard/AT path).
      'data-interactive': connecting ? 'true' : undefined,
      onClick: connecting ? openProgress : undefined,
    },
    meta.strip
      ? h(
          'div',
          { className: 'drg-card-strip', role: meta.strip },
          h(IconAlert, { size: 14 }),
          box(
            'span',
            'drg-card-strip-text',
            meta.strip === 'alert' ? t('errorReason', { detail: reason || t(meta.hint) }) : t(meta.hint),
          ),
          meta.strip === 'alert'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'drg-linkbtn',
                  onClick: typeof props.onDiagnose === 'function' ? () => props.onDiagnose(host) : undefined,
                },
                t('cardDiagnose'),
              )
            : null,
        )
      : null,
    box(
      'div',
      'drg-card-head',
      h(StatusDot, { status: host.status, title: statusLabel }),
      h('h3', { className: 'drg-card-name', title: host.name }, host.name || host.id),
      h(Badge, { tone: meta.tone, title: t(meta.hint) }, statusLabel),
    ),
    h('div', { className: 'drg-card-address', title: displayAddress(host) }, displayAddress(host) || '—'),
    host.status === 'connecting' && host.progress
      ? h('p', { className: 'drg-card-progress', 'data-progress': host.progress.code }, progressText(t, host.progress))
      : null,
    box(
      'dl',
      'drg-card-meta',
      h('div', null, h('dt', null, t('remoteVersion')), h('dd', null, remoteVersion)),
      h('div', null, h('dt', null, t('lastOpened')), h('dd', null, lastOpened)),
    ),
    // Both fields were already in the contract but never painted: a Host that warns about a
    // shared ~/.dsh or reports a version difference now says so on its card (audit S3).
    host.warning
      ? h(
          'div',
          { 'data-testid': 'host-warning' },
          h(Notice, { tone: 'warn', title: t('hostWarnings') }, resolveText(host.warning, locale)),
        )
      : null,
    host.versionParity && host.versionParity.status === 'different'
      ? h(
          'div',
          { 'data-testid': 'host-version-parity' },
          h(
            Notice,
            { tone: 'warn' },
            resolveText(host.versionParity.message, locale) ||
              t('versionDifferent', {
                remote: host.versionParity.remote || '?',
                local: host.versionParity.local || host.targetVersion || '?',
              }),
          ),
        )
      : null,
    host.versionParity && host.versionParity.status === 'unknown'
      ? h('p', { className: 'drg-field-hint', 'data-testid': 'host-version-unknown' }, t('versionUnknown'))
      : null,
    box(
      'div',
      'drg-card-actions',
      h(
        Button,
        {
          variant: host.status === 'connected' ? 'primary' : 'secondary',
          testId: connecting ? 'host-view-progress' : 'host-open',
          onClick: () => {
            if (connecting) {
              if (typeof props.onViewProgress === 'function') props.onViewProgress(host)
              return
            }
            if (typeof props.onOpen === 'function') props.onOpen(host)
          },
          disabled: connecting ? busy : primaryDisabled,
          busy: busy && host.status !== 'connected' && host.status !== 'connecting',
        },
        connecting ? t('cardViewProgress') : t(meta.action),
      ),
      host.status === 'connected'
        ? h(
            Button,
            {
              variant: 'ghost',
              testId: 'host-disconnect',
              onClick: () => props.onDisconnect && props.onDisconnect(host),
              disabled: busy,
            },
            t('cardDisconnect'),
          )
        : null,
      restartAvailable
        ? h(
            Button,
            {
              variant: 'ghost',
              testId: 'host-restart',
              ariaLabel: t('cardRestartName'),
              onClick: () => props.onRestart && props.onRestart(host),
              disabled: busy || restarting || stopping,
            },
            restarting ? t('cardRestarting') : t('cardRestart'),
          )
        : null,
      stopAvailable
        ? h(
            Button,
            {
              variant: 'ghost',
              testId: 'host-stop-remote',
              ariaLabel: t('cardStopRemoteName'),
              onClick: () => props.onStopRemote && props.onStopRemote(host),
              disabled: busy || restarting || stopping,
            },
            stopping ? t('cardStopping') : t('cardStopRemote'),
          )
        : null,
      meta.retry === true
        ? h(
            Button,
            {
              variant: 'ghost',
              testId: 'host-reconnect',
              onClick: () => props.onReconnect && props.onReconnect(host),
              disabled: busy,
            },
            t('cardReconnect'),
          )
        : null,
      box(
        'div',
        'drg-card-actions-end',
        h(IconButton, {
          icon: h(IconPulse),
          label: t('cardDiagnose'),
          testId: 'host-diagnose',
          onClick: () => props.onDiagnose && props.onDiagnose(host),
          disabled: busy,
        }),
        h(IconButton, {
          icon: h(IconEdit),
          label: t('cardEdit'),
          testId: 'host-edit',
          onClick: () => props.onEdit && props.onEdit(host),
          // Editing while a link is being built would race the connection's own settings.
          disabled: busy || host.status === 'connecting',
        }),
        h(IconButton, {
          icon: h(IconTrash),
          label: t('cardDelete'),
          testId: 'host-delete',
          onClick: () => props.onDelete && props.onDelete(host),
          disabled: busy || host.status === 'connecting',
        }),
      ),
    ),
  )
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
  // Every host keeps its card, a connecting one included: the card carries the phase, the
  // progress line and the way back to the connect window the user may have closed
  // (docs/design.md §4.1). A stale Host with no status is the only thing this list never draws.
  const visibleHosts = hosts.filter((host) => Boolean(host))
  const connected = hosts.filter((host) => host && host.status === 'connected').length
  const total = hosts.length
  const busyHostId = props.busyHostId || null
  // Stopping a remote DSH is destructive, so the card action only opens a confirmation;
  // the dialog owns the busy state until the Host answers.
  const [pendingStop, setPendingStop] = useState<Partial<HostView> | null>(null)
  const [stopBusy, setStopBusy] = useState(false)

  const requestStop = (host: Partial<HostView> | null | undefined) => {
    if (host) setPendingStop(host)
  }
  const confirmStop = () => {
    if (pendingStop === null || stopBusy) return
    const host = pendingStop
    setStopBusy(true)
    const work = typeof props.onStopRemote === 'function' ? props.onStopRemote(host) : null
    Promise.resolve(work).then(
      () => {
        setStopBusy(false)
        setPendingStop(null)
      },
      () => {
        setStopBusy(false)
        setPendingStop(null)
      },
    )
  }

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
    content = box(
      'div',
      'drg-host-body',
      box(
        'div',
        'drg-summary',
        h(StatusDot, { status: connected > 0 ? 'connected' : 'idle' }),
        h('span', null, t('summary', { connected, total })),
      ),
      visibleHosts.length > 0
        ? h(
            'ul',
            { className: 'drg-host-list', 'data-testid': 'host-list' },
            visibleHosts.map((host) =>
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
              }),
            ),
          )
        : null,
      pendingStop !== null
        ? h(StopRemoteDialog, {
            key: 'stop-remote:' + pendingStop.id,
            t,
            busy: stopBusy,
            onConfirm: confirmStop,
            onCancel: () => {
              if (stopBusy) return
              setPendingStop(null)
            },
          })
        : null,
    )
  }

  // The stream died and the panel is polling: say so instead of silently showing stale
  // numbers, and offer the one action that can restore live updates (audit S2-1). The banner
  // also stays up while a reconnect attempt is in flight (`reconnecting`): only an actual
  // `open`/first frame clears it.
  const liveDegraded = props.mode === 'polling' || props.mode === 'reconnecting'
  const liveBanner = liveDegraded
    ? box(
        'div',
        'drg-live-banner',
        h(
          Notice,
          { tone: 'warn', title: t('liveStreamLostTitle') },
          props.mode === 'reconnecting'
            ? t('liveReconnecting')
            : t('liveStreamLostBody', { seconds: Math.round(POLL_INTERVAL_MS / 1000) }),
        ),
        h(
          Button,
          {
            variant: 'secondary',
            testId: 'live-reconnect',
            onClick: props.onRetryLive,
            disabled: typeof props.onRetryLive !== 'function',
          },
          t('liveReconnect'),
        ),
      )
    : null

  return box(
    'div',
    'drg-page drg-host-page',
    box(
      'header',
      'drg-page-head',
      box(
        'div',
        'drg-page-heading',
        box('h1', 'drg-page-title', t('hostsTitle')),
        box('p', 'drg-page-subtitle', t('panelSubtitle')),
      ),
      box(
        'div',
        'drg-page-actions',
        h(
          Button,
          {
            variant: 'primary',
            testId: 'host-add',
            onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
          },
          h(IconPlus, { size: 14 }),
          h('span', null, t('addHost')),
        ),
        h(
          Button,
          {
            variant: 'ghost',
            testId: 'host-refresh',
            onClick: props.onRefresh,
            busy: loading,
          },
          h(IconRefresh, { size: 14 }),
          h('span', null, t('refresh')),
        ),
        h(IconButton, {
          icon: h(IconGear),
          label: t('settings'),
          testId: 'host-settings',
          onClick: props.onOpenSettings,
        }),
      ),
    ),
    content,
    liveBanner,
  )
}
