// client/src/toast.ts - the Toast list (region 14); after prompts.ts, before overlay-state.ts.
//#region 14. toast

function Toast(props) {
  const toasts = props && Array.isArray(props.toasts) ? props.toasts : props && props.toast ? [props.toast] : []
  if (toasts.length === 0) return null
  return h(
    'div',
    {
      className: 'drg-toasts',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
      'data-testid': 'toast-region',
    },
    toasts.map((toast, index) =>
      h(
        'div',
        {
          key: toast && toast.id !== undefined ? String(toast.id) : String(index),
          className: 'drg-toast',
          'data-tone': (toast && toast.tone) || 'info',
        },
        toast && toast.text,
      ),
    ),
  )
}
