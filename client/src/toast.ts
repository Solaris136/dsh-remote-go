// client/src/toast.ts - the Toast list (region 14); after prompts.ts, before overlay-state.ts.
type ToastProps = { toasts?: ToastEntry[]; toast?: ToastEntry }
function Toast(props: ToastProps) {
  const toasts = props && Array.isArray(props.toasts) ? props.toasts : props && props.toast ? [props.toast] : []
  if (toasts.length === 0) return null
  const item = (toast: ToastEntry, index: number) => {
    const key = String(toast && toast.id !== undefined ? toast.id : index)
    return h('div', { key, className: 'drg-toast', 'data-tone': (toast && toast.tone) || 'info' }, toast && toast.text)
  }
  return h(
    'div',
    {
      className: 'drg-toasts',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
      'data-testid': 'toast-region',
    },
    toasts.map(item),
  )
}
