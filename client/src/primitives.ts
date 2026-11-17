// client/src/primitives.ts - RemoteIcon/strokeIcon and the small primitives (StatusDot, Badge, Button, IconButton, DownloadCenter, Spinner); after api-client.ts, before dialogs.ts.
//#region 7. icons and small UI primitives

function RemoteIcon(props) {
  const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
  const active = props && props.active === true
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 1.9 : 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    h('rect', { x: 2.5, y: 4, width: 12, height: 9.5, rx: 2 }),
    h('path', { d: 'M5.75 17.5h5' }),
    h('path', { d: 'M8.25 13.5v4' }),
    h('path', { d: 'M17.25 8.5h4.25v5h-4.25z' }),
    h('path', { d: 'M16 11h-2.25' }),
  )
}

function strokeIcon(paths, viewBox?: string) {
  return function Icon(props) {
    const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: viewBox || '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      paths.map((d, index) => h('path', { key: String(index), d })),
    )
  }
}

const IconPlus = strokeIcon(['M12 5v14', 'M5 12h14'])
const IconRefresh = strokeIcon(['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'])
const IconGear = strokeIcon([
  'M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z',
  'M19.4 13.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H4a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H10A1.6 1.6 0 0 0 11 4.09V4a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V10a1.6 1.6 0 0 0 1.47.97H20a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.47.97Z',
])
const IconEdit = strokeIcon(['M4 20h4.5L20 8.5a2.12 2.12 0 0 0-3-3L5.5 17V20Z', 'M14.5 7l2.5 2.5'])
const IconTrash = strokeIcon(['M4 7h16', 'M9 7V5h6v2', 'M6.5 7l1 13h9l1-13', 'M10 11v5', 'M14 11v5'])
const IconPulse = strokeIcon(['M3 12h4l2.5-6 4 12 2.5-6H21'])
const IconClose = strokeIcon(['M6 6l12 12', 'M18 6L6 18'])
const IconCheck = strokeIcon(['M5 12.5l4.5 4.5L19 7'])
const IconAlert = strokeIcon(['M12 3.5 21 19H3L12 3.5Z', 'M12 9.5v4.5', 'M12 17h.01'])

function StatusDot(props) {
  const status = props && typeof props.status === 'string' ? props.status : 'unconfigured'
  const tone = statusOf(status).tone
  const label = props && typeof props.title === 'string' ? props.title : undefined
  return h('span', {
    className: 'drg-dot',
    style: { background: TONE_VARS[tone] },
    title: label,
    'aria-hidden': label === undefined ? 'true' : undefined,
    'data-tone': tone,
  })
}

function Badge(props) {
  const tone = props && typeof props.tone === 'string' ? props.tone : 'idle'
  return h(
    'span',
    {
      className: 'drg-badge',
      'data-tone': tone,
      title: props && props.title,
    },
    props && props.children,
  )
}

function Button(props) {
  const variant = props.variant || 'secondary'
  const className = ['drg-btn', 'drg-btn-' + variant].join(' ')
  const onClick = props.onClick
  return h(
    'button',
    {
      type: 'button',
      className,
      onClick: typeof onClick === 'function' ? onClick : undefined,
      disabled: props.disabled === true || props.busy === true,
      title: props.title,
      'aria-label': props.ariaLabel,
      'data-testid': props.testId,
      'data-busy': props.busy === true ? 'true' : undefined,
    },
    props.busy === true ? h(Spinner, { size: 14 }) : null,
    box('span', 'drg-btn-label', props.children),
  )
}

function IconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: 'drg-iconbtn',
      onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
      disabled: props.disabled === true,
      title: props.label,
      'aria-label': props.label,
      'data-testid': props.testId,
    },
    props.icon,
  )
}

/** Human-readable byte count for the download progress card. */
function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = bytes
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : amount >= 10 ? 0 : 1
  return amount.toFixed(digits) + ' ' + units[unit]
}

/**
 * Draggable stack for the transient download cards. The stack stays anchored to
 * the bottom-right by CSS and is moved with a transform, so dragging never changes
 * layout or the guest behind it. Clamping keeps at least a corner on screen.
 */
function DownloadCenter(props) {
  const jobs = Array.isArray(props.jobs) ? props.jobs : []
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const stackRef = useRef(null)
  const dragRef = useRef(null)

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    const target = event.target
    if (target && typeof target.closest === 'function' && target.closest('button')) return
    if (!stackRef.current || !event.currentTarget) return
    const rect = stackRef.current.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: offset.x,
      y: offset.y,
      rect,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (_captureError) {
      // pointer capture is an enhancement; dragging still works inside the head
    }
    event.preventDefault()
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const x = drag.x + (event.clientX - drag.startX)
    const y = drag.y + (event.clientY - drag.startY)
    const minX = drag.x + (8 - drag.rect.left)
    const maxX = drag.x + (window.innerWidth - 8 - drag.rect.right)
    const minY = drag.y + (8 - drag.rect.top)
    const maxY = drag.y + (window.innerHeight - 8 - drag.rect.bottom)
    setOffset({
      x: Math.min(Math.max(x, Math.min(minX, maxX)), Math.max(minX, maxX)),
      y: Math.min(Math.max(y, Math.min(minY, maxY)), Math.max(minY, maxY)),
    })
    event.preventDefault()
  }

  const onPointerEnd = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      if (event.currentTarget && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch (_releaseError) {
      // already released
    }
  }

  return h(
    'div',
    {
      ref: stackRef,
      className: 'drg-downloads',
      'data-testid': 'dsh-remote-go-downloads',
      style: { transform: 'translate(' + offset.x + 'px, ' + offset.y + 'px)' },
    },
    jobs.map((job) =>
      h(DownloadProgress, {
        key: job.id,
        job,
        t: props.t,
        locale: props.locale,
        onCancel: props.onCancel,
        onDismiss: props.onDismiss,
        onDragStart: onPointerDown,
        onDragMove: onPointerMove,
        onDragEnd: onPointerEnd,
      }),
    ),
  )
}

/**
 * Bottom-right download card. It is transient (one per active job), shows a real
 * determinate bar once the Host has an inventory, and stays indeterminate while a
 * folder is still being enumerated. The header is the drag handle.
 */
function DownloadProgress(props) {
  const t = translatorOf(props)
  const job = props.job
  if (!job) return null
  const total = Number(job.totalBytes) || 0
  const done = Math.min(Number(job.doneBytes) || 0, total || Number.MAX_SAFE_INTEGER)
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
  const preparing = job.phase === 'preparing'
  const failed = job.phase === 'error'
  const donePhase = job.phase === 'done'
  const name = job.name || job.path || 'download'
  const title = failed
    ? t('downloadFailed')
    : preparing
      ? t('downloadPreparing', { name })
      : t('downloadSaved', { name })
  const detail = failed && job.error ? resolveText(job.error.detail, localeOf(props)) : ''
  const meta = []
  if (total > 0) meta.push(formatBytes(done) + ' / ' + formatBytes(total))
  if (Number(job.totalFiles) > 0) {
    meta.push(t('downloadFiles', { done: Number(job.doneFiles) || 0, total: Number(job.totalFiles) || 0 }))
  }
  const cancellable = (preparing || job.phase === 'ready') && typeof props.onCancel === 'function'
  const dismissible = (failed || donePhase) && typeof props.onDismiss === 'function'
  const progressText =
    total > 0
      ? percent + '%' + (meta.length > 0 ? ' · ' + meta.join(' · ') : '')
      : preparing
        ? t('downloadInProgress')
        : title
  return h(
    'div',
    {
      className: 'drg-download' + (failed ? ' drg-download-error' : ''),
      'data-testid': 'dsh-remote-go-download',
      'data-phase': job.phase,
    },
    h(
      'div',
      {
        className: 'drg-download-head',
        title: t('downloadDrag'),
        onPointerDown: props.onDragStart,
        onPointerMove: props.onDragMove,
        onPointerUp: props.onDragEnd,
        onPointerCancel: props.onDragEnd,
      },
      h(
        'span',
        { className: 'drg-download-grip', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 10, height: 14, viewBox: '0 0 10 14', fill: 'currentColor', focusable: 'false' },
          [2, 7, 12].map((cy) => [2, 8].map((cx) => h('circle', { key: cx + '-' + cy, cx, cy, r: 1.1 }))),
        ),
      ),
      // The visible title is the drag handle's label; the live region below announces it
      // once, and buttons stay outside the status so a screen reader is not told to press
      // Cancel as part of the status (audit S3).
      h('span', { className: 'drg-download-title', title, 'aria-hidden': 'true' }, title),
      cancellable
        ? h(
            'button',
            {
              type: 'button',
              className: 'drg-download-action',
              onClick: () => props.onCancel(job),
            },
            t('downloadCancel'),
          )
        : null,
      dismissible
        ? h(
            'button',
            {
              type: 'button',
              className: 'drg-download-action',
              onClick: () => props.onDismiss(job),
            },
            t('downloadClose'),
          )
        : null,
    ),
    h(
      'div',
      {
        className: 'drg-download-status drg-sr-only',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      },
      title + (detail ? ' · ' + detail : ''),
    ),
    h(
      'div',
      {
        className: 'drg-download-track',
        'data-indeterminate': percent === 0 && preparing ? 'true' : undefined,
        role: 'progressbar',
        'aria-label': t('downloadProgress', { name }),
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': total > 0 ? percent : undefined,
        'aria-valuetext': progressText,
      },
      h('span', {
        className: 'drg-download-fill',
        style: { width: (total > 0 ? percent : preparing ? 35 : 100) + '%' },
      }),
    ),
    h(
      'div',
      { className: 'drg-download-meta', 'aria-hidden': 'true' },
      h('span', null, meta.filter(Boolean).join(' · ')),
      total > 0 ? h('span', null, percent + '%') : null,
    ),
    detail ? h('p', { className: 'drg-download-detail', 'aria-hidden': 'true' }, detail) : null,
  )
}

function Spinner(props) {
  return h('span', {
    className: 'drg-spinner',
    style: {
      width: props && props.size ? props.size + 'px' : '16px',
      height: props && props.size ? props.size + 'px' : '16px',
    },
    'aria-hidden': 'true',
  })
}
