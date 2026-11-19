// client/src/diagnostics.ts - DiagnoseDrawer plus the check ordering/labels/text (region 11); after wizard.ts, before settings.ts.
//#region 11. diagnostics drawer

/** Sort diagnostic checks into the contract's fixed order, unknown ids last. */
function sortDiagnoseChecks(checks: unknown): DiagnoseCheck[] {
  const list: DiagnoseCheck[] = Array.isArray(checks) ? checks.slice() : []
  const rank = (check: DiagnoseCheck) => {
    const index = DIAGNOSE_IDS.indexOf(check && check.id)
    return index < 0 ? DIAGNOSE_IDS.length : index
  }
  return list.sort((a, b) => rank(a) - rank(b))
}

function checkStatusLabel(t: Translate, status: unknown): string {
  if (status === 'pass') return t('diag.checkPass')
  if (status === 'fail') return t('diag.checkFail')
  return t('diag.checkUnknown')
}

/**
 * Plain-text diagnostic report for the clipboard. Redacted by contract;
 * never includes a token or remote URL. `report` is required: the only caller
 * branches on it and calls this with a real report.
 */
function formatDiagnoseText(
  report: DiagnoseReport,
  host: Partial<HostView> | null | undefined,
  t: Translate,
  locale: DictLocale,
): string {
  const lines = ['dsh-remote-go · ' + t('diag.title')]
  const target: Partial<HostView> = host || {}
  const address = displayAddress(target)
  lines.push(t('diag.host') + ': ' + (target.name || target.id || '') + (address ? ' (' + address + ')' : ''))
  if (typeof report.summary === 'string') lines.push('summary: ' + report.summary)
  if (typeof report.generatedAt === 'string') lines.push(t('diag.generatedAt') + ': ' + report.generatedAt)
  lines.push('')
  const checks = sortDiagnoseChecks(report.checks)
  for (const check of checks) {
    const title = resolveText(check.title, locale) || String(check.id || '')
    const detail = resolveText(check.detail, locale)
    lines.push('[' + String(check.status || 'unknown').toUpperCase() + '] ' + title + (detail ? ' — ' + detail : ''))
  }
  lines.push('')
  lines.push(t('diag.redacted'))
  return lines.join('\n')
}

/** The drawer: a failed run shows the same error card the connect window does. */
interface DiagnoseDrawerProps extends LocaleProps {
  host?: Partial<HostView> | null
  status?: string
  report?: DiagnoseReport | null
  error?: unknown
  onClose?: () => void
  onRun?: () => void
}

function DiagnoseDrawer(props: DiagnoseDrawerProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const host = props.host || null
  const status = props.status || 'loading'
  const report = props.report || null
  const [copied, setCopied] = useState(false)
  const layerRef = useRef(null)
  const dialogRef = useRef(null)
  const titleIdRef = useRef('drg-drawer-title')
  // The drawer is a dialog like the modals: one Escape handler for the whole stack, so a
  // drawer under a wizard cannot close first (audit S1-1).
  useDialogLayer({ layerRef, dialogRef, onClose: props.onClose, dismissible: true })

  const handleCopy = async () => {
    const text = report
      ? formatDiagnoseText(report, host, t, locale)
      : [t('diag.failed'), resolveText(toErrorView(props.error).detail, locale)].join('\n')
    const ok = await copyText(text)
    setCopied(ok === true)
  }

  const summaryTone =
    report && report.summary === 'error' ? 'error' : report && report.summary === 'warning' ? 'warn' : 'success'
  const summaryText =
    report && report.summary === 'error'
      ? t('diag.summaryError')
      : report && report.summary === 'warning'
        ? t('diag.summaryWarning')
        : t('diag.summaryOk')

  let content
  if (status === 'loading') {
    content = box('div', 'drg-loading', h(Spinner, { size: 20 }), h('span', null, t('diag.running')))
  } else if (status === 'error') {
    content = h(ErrorCard, {
      t,
      locale,
      error: props.error,
      onRetry: props.onRun,
    })
  } else if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    content = box('p', 'drg-paragraph', t('diag.empty'))
  } else {
    content = box(
      'div',
      'drg-diag',
      box(
        'div',
        'drg-diag-head',
        h(Badge, { tone: summaryTone }, summaryText),
        report.generatedAt
          ? box('span', 'drg-diag-time', t('diag.generatedAt') + ' ' + formatTime(report.generatedAt, locale))
          : null,
      ),
      box(
        'ul',
        'drg-diag-list',
        sortDiagnoseChecks(report.checks).map((check, index) =>
          h(
            'li',
            { key: String(check.id || index), className: 'drg-diag-check', 'data-status': check.status },
            h('span', { className: 'drg-diag-status', 'data-status': check.status }, checkStatusLabel(t, check.status)),
            box(
              'div',
              'drg-diag-check-body',
              box('div', 'drg-diag-check-title', resolveText(check.title, locale) || String(check.id || '')),
              resolveText(check.detail, locale)
                ? box('div', 'drg-diag-check-detail', resolveText(check.detail, locale))
                : null,
            ),
          ),
        ),
      ),
      box('p', 'drg-field-hint', t('diag.redacted')),
      copied ? h(Notice, { tone: 'success' }, t('diag.copyDone')) : null,
    )
  }

  return h(
    'div',
    { className: 'drg-drawer-layer', ref: layerRef },
    h('div', { className: 'drg-drawer-backdrop', onClick: props.onClose, 'aria-hidden': 'true' }),
    h(
      'aside',
      {
        className: 'drg-drawer',
        role: 'dialog',
        'aria-labelledby': titleIdRef.current,
        tabIndex: -1,
        ref: dialogRef,
        'data-testid': 'diagnostics',
      },
      box(
        'div',
        'drg-drawer-head',
        h(
          'div',
          null,
          box('h2', { className: 'drg-drawer-title', id: titleIdRef.current }, t('diag.title')),
          host
            ? box(
                'p',
                'drg-drawer-subtitle',
                (host.name || host.id) + (displayAddress(host) ? ' · ' + displayAddress(host) : ''),
              )
            : null,
        ),
        h(IconButton, { icon: h(IconClose), label: t('diag.close'), onClick: props.onClose }),
      ),
      box('div', 'drg-drawer-body', content),
      box(
        'div',
        'drg-drawer-foot',
        h(
          Button,
          { variant: 'secondary', testId: 'diagnose-rerun', busy: status === 'loading', onClick: props.onRun },
          t('diag.rerun'),
        ),
        h(
          Button,
          { variant: 'primary', testId: 'diagnose-copy', onClick: handleCopy },
          copied ? t('copied') : t('diag.copy'),
        ),
      ),
    ),
  )
}
