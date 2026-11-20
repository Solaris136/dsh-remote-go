// client/src/manage-window.ts - ManageWindow, the remote host manager dialog; after overlay-state.ts, before plugin-overlay.ts.
interface ManageWindowProps extends LocaleProps {
  open?: boolean
  view?: string
  host?: HostView | null
  state?: StateView | null
  loading?: boolean
  error?: ErrorView | null
  busyHostId?: string | null
  mode?: StreamMode
  fingerprintBusy?: boolean
  onRetryLive?: (() => void) | null
  onClose?: () => void
  onShowList?: () => void
  onAdd?: () => void
  onRefresh?: () => void
  onOpenSettings?: () => void
  onOpenHost?: (host: HostView) => void
  onViewProgress?: (host: HostView) => void
  onDisconnectHost?: (host: HostView) => void
  onReconnectHost?: (host: HostView) => void
  onRestartHost?: (host: HostView) => void
  onStopRemoteHost?: (host: HostView) => void
  onEditHost?: (host: HostView) => void
  onDeleteHost?: (host: HostView) => void
  onDiagnoseHost?: (host: HostView) => void
  onAcceptFingerprint?: (host: HostView, remember: boolean) => void
  onRejectFingerprint?: (host: HostView) => void
  onRetry?: (host: HostView) => void
  onDiagnose?: (host: HostView) => void
}
function ManageWindow(props: ManageWindowProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  if (props.open !== true) return null
  const host = props.host || null
  const connecting = props.view === 'connect' && host !== null && statusOf(host.status).window === true
  return h(
    'div',
    { className: 'drg-manage-window', 'data-testid': 'manage-window' },
    h(
      Modal,
      { wide: true, onClose: props.onClose, closeLabel: t('cancel'), ariaLabel: t('hostsTitle') },
      // The host list reads a subset under its own names; only `onStopRemote` is renamed, so the rest pass through.
      connecting
        ? h(ConnectWindow, {
            t,
            locale,
            host,
            fingerprintBusy: props.fingerprintBusy === true,
            onAcceptFingerprint: (remember: boolean) => props.onAcceptFingerprint(host, remember),
            onRejectFingerprint: () => props.onRejectFingerprint(host),
            onBack: typeof props.onShowList === 'function' ? props.onShowList : props.onClose,
            onRetry: () => props.onRetry(host),
            onDiagnose: () => props.onDiagnose(host),
          })
        : h(HostListView, { ...props, onStopRemote: props.onStopRemoteHost }),
    ),
  )
}
