// client/src/dialogs.ts - the dialog stack (Escape/focus trap/scroll lock) and Field/TextInput/Select/CheckRow/Notice/Modal/ConfirmDialog/StopRemoteDialog; after primitives.ts, before host-list.ts.
//#region 7a. dialog stack (Escape, focus trap, scroll lock)

const DIALOG_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
/** One stack for every dialog: a per-Modal keydown keyed on `onClose` let one Escape be handled by the lower dialog, */
// as it is new every render; one document listener serves the top layer, and `dismissible:false` swallows the key.
// It owns initial focus, Tab cycling, focus restoration, the scroll lock, `aria-modal` on top and `inert` below.
function createDialogStack(): DialogStack {
  const layers: DialogLayer[] = []
  let doc: Document | null = null
  let installed = false
  let savedOverflow: string | null = null
  let initialFocus: FocusableElement | null = null
  const top = () => layers[layers.length - 1] || null
  const activeElement = () => (doc && doc.activeElement ? doc.activeElement : null) as FocusableElement | null
  const hidden = (node: FocusableElement) => typeof node.hasAttribute === 'function' && node.hasAttribute('aria-hidden')
  const focusOf = (root: HTMLElement | null | undefined): FocusableElement[] => {
    if (!root || typeof root.querySelectorAll !== 'function') return []
    try {
      const list: FocusableElement[] = Array.prototype.slice.call(root.querySelectorAll(DIALOG_FOCUSABLE))
      return list.filter((node) => node && node.disabled !== true && !hidden(node) && typeof node.focus === 'function')
    } catch (_error) {
      return []
    }
  }
  const focusNode = (node: FocusableElement | null | undefined) => {
    try {
      node.focus()
    } catch (_error) {
      // swallow-ok: a detached node cannot take focus; the dialog itself still opens
    }
  }
  const setAttr = (node: HTMLElement | null | undefined, name: string, value: string | null) => {
    if (!node || typeof node.setAttribute !== 'function') return
    if (value !== null) return node.setAttribute(name, value)
    if (typeof node.removeAttribute === 'function') node.removeAttribute(name)
  }
  /** True when `node` renders inside `root`: a nested dialog is a DOM descendant of the layer below it. */
  // The stop confirmation in the management window is that case.
  const holds = (root: HTMLElement | null | undefined, node: HTMLElement | null | undefined) => {
    if (!root || !node || root === node) return false
    try {
      return typeof root.contains === 'function' && root.contains(node) === true
    } catch (_error) {
      return false
    }
  }
  const sync = () => {
    const active = top()
    const topDialog = active === null ? null : active.dialog
    for (const layer of layers) {
      const isTop = layer === active
      setAttr(layer.dialog, 'aria-modal', isTop ? 'true' : null)
      // An inert hosting layer would freeze a nested top dialog: its buttons and backdrop stop receiving clicks.
      const hostsTop = !isTop && holds(layer.layer, topDialog)
      if (isTop || hostsTop) {
        if (layer.layer && typeof layer.layer.removeAttribute === 'function') layer.layer.removeAttribute('inert')
      } else setAttr(layer.layer, 'inert', '')
    }
  }
  const trapTab = (layer: DialogLayer, event: KeyboardEvent) => {
    const list = focusOf(layer.dialog)
    if (list.length === 0) {
      event.preventDefault()
      return focusNode(layer.dialog)
    }
    // `Document#activeElement` is typed as `Element`; by definition it is the focused one.
    const index = list.indexOf(activeElement())
    if (index === -1) {
      event.preventDefault()
      return focusNode(event.shiftKey ? list[list.length - 1] : list[0])
    }
    if (!event.shiftKey && index !== list.length - 1) return
    if (event.shiftKey && index !== 0) return
    event.preventDefault()
    focusNode(event.shiftKey ? list[list.length - 1] : list[0])
  }
  const firstFocusable = (root: HTMLElement | null | undefined): FocusableElement | null => {
    const list = focusOf(root)
    // A form dialog opens on its first field rather than on its close button.
    return list.find((node) => /^(INPUT|SELECT|TEXTAREA)$/.test(String(node.tagName || ''))) || list[0] || null
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const layer = top()
    if (layer === null || !event) return
    if (event.key === 'Tab') return trapTab(layer, event)
    if (event.key !== 'Escape') return
    // A dialog always owns Escape: even when it may not close, the key must not fall through.
    event.preventDefault()
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    if (layer.dismissible() !== false) layer.close()
  }
  const install = (target: Document | null | undefined) => {
    if (installed || !target) return
    doc = target
    doc.addEventListener('keydown', onKeyDown, true)
    installed = true
  }
  const uninstall = () => {
    if (!installed || !doc) return
    doc.removeEventListener('keydown', onKeyDown, true)
    installed = false
    doc = null
  }
  const lockScroll = () => {
    if (!doc || !doc.body || !doc.body.style) return
    savedOverflow = doc.body.style.overflow
    doc.body.style.overflow = 'hidden'
  }
  const unlockScroll = () => {
    if (!doc || !doc.body || !doc.body.style) return
    doc.body.style.overflow = savedOverflow === null ? '' : savedOverflow
    savedOverflow = null
  }
  const focusInitial = (layer: DialogLayer) => {
    // A destructive confirmation names its safe action: focus lands on Cancel, not on the header ×.
    const id =
      typeof layer.initialFocusTestId === 'string' && layer.initialFocusTestId !== '' ? layer.initialFocusTestId : ''
    const preferred = id === '' ? null : layer.dialog.querySelector<FocusableElement>(`[data-testid="${id}"]`)
    // A control the dialog disabled in this frame cannot take focus: fall back to the ordinary rule.
    const node = preferred && preferred.disabled !== true ? preferred : firstFocusable(layer.dialog)
    if (node !== null) return focusNode(node)
    setAttr(layer.dialog, 'tabindex', '-1')
    focusNode(layer.dialog)
  }
  const remove = (layer: DialogLayer) => {
    const index = layers.indexOf(layer)
    if (index < 0) return
    layers.splice(index, 1)
    sync()
    if (layers.length === 0) {
      unlockScroll()
      uninstall()
    }
    // Hand focus back to whatever opened it; a removed trigger falls back to the new top dialog.
    const restore = layer.returnFocus || (layers.length === 0 ? initialFocus : null)
    if (restore && restore !== layer.dialog && restore.isConnected !== false) focusNode(restore)
    if (layers.length > 0) {
      const active = doc && doc.activeElement
      if (!active || !top().dialog.contains(active)) focusInitial(top())
    } else initialFocus = null
  }
  const stack: DialogStack = {
    push(layer: DialogLayer) {
      if (!layer || !layer.dialog) return () => {}
      const owner = layer.dialog.ownerDocument || (typeof document === 'undefined' ? null : document)
      if (owner === null) return () => {}
      install(owner)
      const active = activeElement()
      if (layers.length === 0) {
        initialFocus = active
        lockScroll()
      } else layer.returnFocus = active
      layers.push(layer)
      sync()
      focusInitial(layer)
      return () => remove(layer)
    },
    remove,
    top,
    size: () => layers.length,
    /** @internal test seam */
    keydown: onKeyDown,
  }
  return stack
}

let sharedDialogStack: DialogStack | null = null
function dialogStack(): DialogStack {
  if (sharedDialogStack === null) sharedDialogStack = createDialogStack()
  return sharedDialogStack
}

/** Register a dialog with the stack; `onClose` goes through a ref, so a per-render callback does not re-register. */
function useDialogLayer(options: DialogLayerOptions) {
  const closeRef = useRef(options.onClose)
  closeRef.current = options.onClose
  const dismissibleRef = useRef(options.dismissible !== false)
  dismissibleRef.current = options.dismissible !== false
  useEffect(() => {
    const layer = options.layerRef && options.layerRef.current
    const dialog = options.dialogRef && options.dialogRef.current
    if (!layer || !dialog) return undefined
    return dialogStack().push({
      layer,
      dialog,
      initialFocusTestId: options.initialFocusTestId,
      dismissible: () => dismissibleRef.current,
      close: () => {
        const close = closeRef.current
        if (typeof close === 'function') close()
      },
    })
  }, [])
}

function Field(props: FieldProps) {
  return h(
    'label',
    { className: 'drg-field' + (props.wide === true ? ' drg-field-wide' : '') },
    props.label ? box('span', 'drg-field-label', props.label) : null,
    props.children,
    props.hint ? box('span', 'drg-field-hint', props.hint) : null,
    props.error ? h('span', { className: 'drg-field-error', role: 'alert', id: props.errorId }, props.error) : null,
  )
}

function TextInput(props: TextInputProps) {
  const change = (event: ReactChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)
  return h('input', {
    className: 'drg-input',
    type: props.type || 'text',
    value: props.value === undefined || props.value === null ? '' : String(props.value),
    placeholder: props.placeholder,
    list: props.list,
    disabled: props.disabled === true,
    autoComplete: props.autoComplete || 'off',
    spellCheck: false,
    'data-testid': props.testId,
    onChange: typeof props.onChange === 'function' ? change : undefined,
    onKeyDown: typeof props.onKeyDown === 'function' ? props.onKeyDown : undefined,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.invalid === true ? 'true' : undefined,
    'aria-describedby': props.describedBy,
  })
}

function Select(props: SelectProps) {
  const options = Array.isArray(props.options) ? props.options : []
  const change = (event: ReactChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)
  return h(
    'select',
    {
      className: 'drg-select',
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      disabled: props.disabled === true,
      'aria-label': props.ariaLabel,
      'aria-invalid': props.invalid === true ? 'true' : undefined,
      'aria-describedby': props.describedBy,
      'data-testid': props.testId,
      onChange: typeof props.onChange === 'function' ? change : undefined,
    },
    options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

/** One form field from a spec; `after` runs alongside the patch (touched/dirty flags). */
function formRow(
  t: LooseTranslate,
  draft: Record<string, unknown>,
  patch: (patch: Record<string, unknown>) => void,
  spec: FormRowSpec,
): ReactElement {
  const label = t(spec.label)
  const error = spec.error ? t(spec.error) : undefined
  const errorId = error && spec.testId ? spec.testId + '-error' : undefined
  const onChange = (next: string) => {
    patch({ [spec.key]: next })
    if (spec.after) spec.after(next)
  }
  const shared = { ariaLabel: label, testId: spec.testId, invalid: Boolean(error), describedBy: errorId, onChange }
  const value = draft[spec.key]
  const control = spec.options
    ? h(Select, {
        ...shared,
        value,
        options: spec.options.map(([optionValue, key]) => ({ value: optionValue, label: t(key) })),
      })
    : h(TextInput, {
        ...shared,
        type: spec.kind,
        value,
        placeholder: spec.placeholder ? t(spec.placeholder) : undefined,
      })
  // `key` matters when a caller renders rows from a `.map`: the draft key is the row's identity.
  return h(Field, { key: spec.key, label, hint: spec.hint ? t(spec.hint) : undefined, error, errorId }, control)
}

function CheckRow(props: CheckRowProps) {
  const change = (event: ReactChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked)
  return box(
    'label',
    'drg-check',
    h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      disabled: props.disabled === true,
      'data-testid': props.testId,
      onChange: typeof props.onChange === 'function' ? change : undefined,
    }),
    h('span', null, props.label),
  )
}

function Notice(props: NoticeProps) {
  const tone = props.tone || 'info'
  const attrs = { className: 'drg-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' }
  const icon = h(
    'span',
    { className: 'drg-notice-icon', 'aria-hidden': 'true' },
    tone === 'success' ? h(IconCheck) : h(IconAlert),
  )
  const hasText = props.children !== undefined && props.children !== null
  const body = box(
    'div',
    'drg-notice-body',
    props.title ? box('div', 'drg-notice-title', props.title) : null,
    hasText ? box('div', 'drg-notice-text', props.children) : null,
  )
  return h('div', { ...attrs, 'data-testid': props.testId }, icon, body)
}

let modalSequence = 0

function Modal(props: ModalProps) {
  const onClose = props.onClose
  const layerRef = useRef(null)
  const dialogRef = useRef(null)
  const titleIdRef = useRef(null)
  if (titleIdRef.current === null) {
    modalSequence += 1
    titleIdRef.current = 'drg-dialog-title-' + modalSequence
  }
  // `dismissible:false` while a request runs: Escape and backdrop are ignored, so busy work cannot outlive the UI.
  const dismissible = typeof onClose === 'function' && props.dismissible !== false
  // A destructive confirmation opens on its safe action, not the header ×: the stack focuses by test id, no extra ref.
  useDialogLayer({ layerRef, dialogRef, onClose, dismissible, initialFocusTestId: props.initialFocusTestId })
  // A dialog whose body draws the title still needs the close affordance, but not an empty header strip above it.
  const bare = !props.title && !props.subtitle
  const backdrop = {
    className: 'drg-modal-backdrop',
    onClick: dismissible ? onClose : undefined,
    'aria-hidden': 'true',
    'data-dismissible': dismissible ? undefined : 'false',
  }
  const aria = {
    role: 'dialog',
    'aria-labelledby': props.title ? titleIdRef.current : undefined,
    'aria-label': !props.title && props.ariaLabel ? props.ariaLabel : undefined,
  }
  const dialogAttrs = {
    className: 'drg-modal' + (props.wide === true ? ' drg-modal-wide' : ''),
    ...aria,
    'aria-busy': props.busy === true ? 'true' : undefined,
    tabIndex: -1,
    ref: dialogRef,
    'data-testid': props.testId,
    'data-bare': bare ? 'true' : undefined,
  }
  const titleEl = props.title ? h('h2', { className: 'drg-modal-title', id: titleIdRef.current }, props.title) : null
  const subtitleEl = props.subtitle ? box('p', 'drg-modal-subtitle', props.subtitle) : null
  const titles = box('div', 'drg-modal-titles', titleEl, subtitleEl)
  // The header × shares the Escape/backdrop dismissal contract: while a request is in flight it is disabled too.
  const closeIcon = h(IconClose)
  const closeLabel = props.closeLabel || 'Close'
  const closeAttrs = {
    icon: closeIcon,
    label: closeLabel,
    disabled: !dismissible,
    onClick: dismissible ? onClose : undefined,
  }
  const close = typeof onClose === 'function' ? h(IconButton, closeAttrs) : null
  const head = box('div', 'drg-modal-head', titles, close)
  const foot = props.footer ? box('div', 'drg-modal-foot', props.footer) : null
  return h(
    'div',
    { className: 'drg-modal-layer', ref: layerRef },
    h('div', backdrop),
    h('div', dialogAttrs, head, box('div', 'drg-modal-body', props.children), foot),
  )
}

function ConfirmDialog(props: ConfirmDialogProps) {
  const busy = props.busy === true
  const footer = footerRow(
    h(
      Button,
      { variant: 'secondary', testId: props.cancelTestId, onClick: props.onCancel, disabled: busy },
      props.cancelLabel,
    ),
    h(Button, { variant: 'danger', testId: props.confirmTestId, onClick: props.onConfirm, busy }, props.confirmLabel),
  )
  // A destructive confirmation focuses Cancel, so Enter cannot confirm it by accident.
  const modal = { title: props.title, onClose: props.onCancel, closeLabel: props.cancelLabel, testId: props.testId }
  return h(
    Modal,
    { ...modal, busy, dismissible: !busy, initialFocusTestId: props.cancelTestId, footer },
    box('p', 'drg-paragraph', props.body),
  )
}

/** The confirmation for the destructive stop action: what happens, and what survives. */
function StopRemoteDialog(props: StopRemoteDialogProps) {
  const t = translatorOf(props)
  const busy = props.busy === true
  return h(ConfirmDialog, {
    title: t('stopRemoteTitle'),
    body: t('stopRemoteBody'),
    confirmLabel: busy ? t('stopRemoteBusy') : t('stopRemoteConfirm'),
    cancelLabel: t('cancel'),
    busy,
    testId: 'stop-remote-dialog',
    confirmTestId: 'stop-remote-confirm',
    cancelTestId: 'stop-remote-cancel',
    onConfirm: props.onConfirm,
    onCancel: props.onCancel,
  })
}
