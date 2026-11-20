// client/src/connect-window.ts - ConnectProgress, FingerprintCard, ErrorCard, logClock, ConnectLog, ConnectWindow (region 9); after host-list.ts, before switcher.ts.
//#region 9. takeover surface and carrier helpers

interface ConnectProgressProps extends LocaleProps {
  host?: Partial<HostView> | null
  title?: ReactNode
}

/** The takeover body's progress: the host's current phase, the phase list and the Host's own progress line. */
function ConnectProgress(props: ConnectProgressProps) {
  const t = translatorOf(props)
  const host: Partial<HostView> = props.host || {}
  const current = host.phase ? PHASES.indexOf(host.phase) : -1
  const name = host.name || host.id || ''
  const progressCode = host.progress ? host.progress.code : undefined
  return box(
    'div',
    'drg-progress',
    box(
      'div',
      'drg-progress-head',
      h(Spinner, { size: 22 }),
      box('h2', 'drg-progress-title', props.title || t('viewportConnecting', { name })),
    ),
    h('p', { className: 'drg-progress-line', 'data-progress': progressCode }, progressText(t, host.progress)),
    box(
      'ol',
      'drg-phases',
      PHASES.map((phase, index) => {
        const state = current < 0 ? 'pending' : index < current ? 'done' : index === current ? 'current' : 'pending'
        return h(
          'li',
          { key: phase, className: 'drg-phase', 'data-state': state },
          h(
            'span',
            { className: 'drg-phase-mark', 'aria-hidden': 'true' },
            state === 'done' ? h(IconCheck, { size: 12 }) : null,
          ),
          // PHASES is the contract list, every id has a `phase.<id>` label (i18n.test.ts checks), so this key is sound.
          h('span', null, t(dictionaryKey('phase.' + phase))),
        )
      }),
    ),
  )
}

interface FingerprintCardProps extends LocaleProps {
  host?: Partial<HostView> | null
  busy?: boolean
  error?: unknown
  onAccept?: (remember: boolean) => void
  onReject?: () => void
}

/** The host-key prompt: a changed key is the error tone, an observed one warning, both accepted via `onAccept`. */
function FingerprintCard(props: FingerprintCardProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const host: Partial<HostView> = props.host || {}
  const fingerprint = host.fingerprint && typeof host.fingerprint === 'object' ? host.fingerprint : null
  const changed = fingerprint !== null && fingerprint.status === 'changed'
  const sha256 = fingerprint && typeof fingerprint.sha256 === 'string' ? fingerprint.sha256 : ''
  const keyType = fingerprint && typeof fingerprint.keyType === 'string' ? fingerprint.keyType : ''
  const pinned = fingerprint && typeof fingerprint.pinned === 'string' ? fingerprint.pinned : ''
  const busy = props.busy === true
  return h(
    'div',
    {
      className: 'drg-fingerprint',
      role: 'group',
      'aria-label': t('fingerprintTitle'),
      'data-testid': 'fingerprint-card',
    },
    h(
      'div',
      { className: 'drg-fingerprint-icon', 'data-tone': changed ? 'error' : 'warn', 'aria-hidden': 'true' },
      h(IconAlert, { size: 22 }),
    ),
    box('h2', 'drg-fingerprint-title', changed ? t('fingerprintChanged') : t('fingerprintTitle')),
    box('p', 'drg-fingerprint-body', changed ? t('fingerprintChangedBody') : t('fingerprintBody')),
    box(
      'dl',
      'drg-kv',
      keyType ? h('div', null, h('dt', null, t('fingerprintKeyType')), h('dd', null, h('code', null, keyType))) : null,
      sha256
        ? h('div', null, h('dt', null, t('fingerprintSha')), h('dd', null, box('code', 'drg-break', sha256)))
        : null,
      pinned && changed
        ? h('div', null, h('dt', null, t('fingerprintPinned')), h('dd', null, box('code', 'drg-break', pinned)))
        : null,
    ),
    props.error
      ? h(Notice, { tone: 'error' }, resolveText(toErrorView(props.error).detail, locale) || t('error.actionFailed'))
      : null,
    box(
      'div',
      'drg-row drg-row-wrap',
      h(
        Button,
        {
          variant: 'primary',
          testId: 'fingerprint-accept',
          busy,
          onClick: () => props.onAccept && props.onAccept(true),
        },
        t('fingerprintAccept'),
      ),
      h(
        Button,
        {
          variant: 'secondary',
          testId: 'fingerprint-accept-once',
          disabled: busy,
          onClick: () => props.onAccept && props.onAccept(false),
        },
        t('fingerprintAcceptOnce'),
      ),
      h(
        Button,
        { variant: 'ghost', testId: 'fingerprint-reject', disabled: busy, onClick: props.onReject },
        t('fingerprintReject'),
      ),
    ),
  )
}

/** The three follow-up actions an error offers: the error card takes them, the connect window only forwards them. */
interface ErrorActions {
  onRetry?: () => void
  onDiagnose?: () => void
  onBack?: () => void
}

interface ErrorCardProps extends LocaleProps, ErrorActions {
  error?: unknown
}

/** The failure body: the error view's title, detail and next steps, and only the actions this error offers. */
function ErrorCard(props: ErrorCardProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const view = toErrorView(props.error)
  const title = resolveText(view.title, locale) || t('error.actionFailed')
  const detail = resolveText(view.detail, locale)
  const steps = resolveTextList(view.nextSteps, locale)
  return h(
    'div',
    { className: 'drg-error-card', role: 'alert', 'data-testid': 'error-card' },
    h('div', { className: 'drg-error-icon', 'aria-hidden': 'true' }, h(IconAlert, { size: 24 })),
    box('h2', 'drg-error-title', title),
    detail ? box('p', 'drg-error-detail', detail) : null,
    steps.length > 0
      ? box(
          'div',
          'drg-error-steps',
          box('div', 'drg-section-label', t('next')),
          h(
            'ul',
            null,
            steps.map((step, index) => h('li', { key: String(index) }, step)),
          ),
        )
      : null,
    box(
      'div',
      'drg-row drg-row-wrap',
      // A non-retryable error must not offer Retry: the Host said the same request would fail again.
      view.retryable !== false && typeof props.onRetry === 'function'
        ? h(Button, { variant: 'primary', testId: 'error-retry', onClick: props.onRetry }, t('retry'))
        : null,
      typeof props.onDiagnose === 'function'
        ? h(Button, { variant: 'secondary', testId: 'error-diagnose', onClick: props.onDiagnose }, t('diagnose'))
        : null,
      typeof props.onBack === 'function'
        ? h(Button, { variant: 'ghost', testId: 'error-back', onClick: props.onBack }, t('back'))
        : null,
    ),
  )
}

/** The local clock time a log line was written at (empty for a timestamp that cannot be read). */
function logClock(iso: unknown): string {
  const when = typeof iso === 'string' && iso !== '' ? new Date(iso) : null
  if (when === null || Number.isNaN(when.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds())
}

/** The connect phases that own a log line; an unknown id prints as itself. */
const CONNECT_LOG_PHASES = new Set(['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'verifying', 'ready'])
/** A line's text: the Host's bilingual line when present, otherwise the raw message. */
function connectLogText(entry: ConnectLogEntry, locale: DictLocale): string {
  const localized = resolveText(entry.text, locale)
  return localized !== '' ? localized : String(entry.message ?? '')
}

function connectLogPhaseLabel(t: LooseTranslate, phase: string): string {
  return CONNECT_LOG_PHASES.has(phase) ? t('connectLogPhase.' + phase) : String(phase)
}

interface ConnectLogProps extends LocaleProps {
  host?: Partial<HostView> | null
}

/** Follows the tail until the user scrolls away; `data-boundary` marks where the current attempt began. */
function ConnectLog(props: ConnectLogProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const host: Partial<HostView> = props.host || {}
  const entries: ConnectLogEntry[] = Array.isArray(host.logs) ? host.logs : []
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !follow.current) return
    body.scrollTop = body.scrollHeight
  }, [lastSeq, entries.length])
  const onScroll = () => {
    const body = bodyRef.current
    if (!body) return
    // 2px slack: fractional scroll heights never land exactly on the bottom.
    follow.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 2
  }
  return h(
    'section',
    { className: 'drg-connect-log', 'data-testid': 'connect-log' },
    box(
      'div',
      'drg-connect-log-head',
      box('span', 'drg-connect-log-title', t('connectLogTitle')),
      // "Closing keeps it running" is only true while a connection is still in flight.
      host.status === 'error' ? null : box('span', 'drg-connect-log-hint', t('connectLogHint')),
      box('span', 'drg-connect-log-count', t('connectLogCount', { count: entries.length })),
    ),
    h(
      'div',
      {
        className: 'drg-connect-log-body',
        ref: bodyRef,
        role: 'log',
        tabIndex: 0,
        onScroll,
        'aria-label': t('connectLogTitle'),
      },
      entries.length === 0
        ? h('p', { className: 'drg-connect-log-empty', 'data-testid': 'connect-log-empty' }, t('connectLogEmpty'))
        : entries.map((entry) => {
            const phase = typeof entry.phase === 'string' ? entry.phase : ''
            return h(
              'div',
              {
                key: String(entry.seq),
                className: 'drg-connect-log-line',
                'data-level': entry.level || 'info',
                'data-phase': phase === '' ? undefined : phase,
                'data-boundary': entry.boundary === true ? 'true' : undefined,
                'data-testid': 'connect-log-line',
              },
              h('span', { className: 'drg-connect-log-time', 'aria-hidden': 'true' }, logClock(entry.at)),
              // The phase each line was written in: scrolling back shows where it stopped.
              phase === '' ? null : box('span', 'drg-connect-log-phase', connectLogPhaseLabel(t, phase)),
              box('span', 'drg-connect-log-text', connectLogText(entry, locale)),
            )
          }),
    ),
  )
}

interface ConnectWindowProps extends LocaleProps, ErrorActions {
  host?: HostView | null
  fingerprintBusy?: boolean
  onAcceptFingerprint?: (remember: boolean) => void
  onRejectFingerprint?: () => void
}

/** The takeover body: the host's warning and version parity above one of the three link states, then the log. */
function ConnectWindow(props: ConnectWindowProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const host: Partial<HostView> = props.host || {}
  const status = host.status
  // A restart keeps the same host and link: its title says so instead of "connecting".
  const restarting = status === 'connecting' && host.progress !== null && host.progress.code === 'restarting-remote'
  return h(
    React.Fragment,
    null,
    host.warning ? h(Notice, { tone: 'warn', title: t('hostWarnings') }, resolveText(host.warning, locale)) : null,
    host.versionParity && host.versionParity.status === 'different'
      ? h(
          Notice,
          { tone: 'warn' },
          resolveText(host.versionParity.message, locale) ||
            t('versionDifferent', {
              remote: host.versionParity.remote || '?',
              local: host.versionParity.local || host.targetVersion || '?',
            }),
        )
      : null,
    h(
      'div',
      { className: 'drg-manage-live', 'data-testid': 'manage-live' },
      status === 'fingerprint-pending'
        ? h(FingerprintCard, {
            t,
            locale,
            host,
            busy: props.fingerprintBusy === true,
            onAccept: (remember: boolean) => props.onAcceptFingerprint(remember === true),
            onReject: props.onRejectFingerprint,
          })
        : status === 'error'
          ? h(ErrorCard, {
              t,
              locale,
              error: host.error,
              onRetry: props.onRetry,
              onDiagnose: props.onDiagnose,
              onBack: props.onBack,
            })
          : h(ConnectProgress, {
              t,
              host,
              title: restarting ? t('progressRestartingTitle', { name: host.name || host.id || '' }) : undefined,
            }),
    ),
    h(ConnectLog, { t, host }),
  )
}
