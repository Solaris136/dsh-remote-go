// client/src/dialogs.ts - the dialog stack (Escape/focus trap/scroll lock) and Field/TextInput/Select/CheckRow/Notice/Modal/ConfirmDialog/StopRemoteDialog; after primitives.ts, before host-list.ts.
//#region 7a. dialog stack (Escape, focus trap, scroll lock)

const DIALOG_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * One stack for every dialog this plugin draws. Before this, each `Modal` installed its own
 * document `keydown` listener with `useEffect(..., [onClose])`; because `onClose` is a new
 * function on every render, every re-render removed and re-added the listener — and a single
 * Escape that started on the top dialog was handled by the *lower* one before React got to
 * re-register. The window management dialog closed under the wizard, exactly as the audit
 * reproduces (S1-1). Now: one listener on the document, the top layer alone receives Escape,
 * `dismissible:false` swallows it, and the listener never changes during a key event.
 *
 * The same stack owns the rest of the dialog contract (S2-4): initial focus, Tab cycling,
 * focus restoration on unmount, `overflow:hidden` on `<body>`, `aria-modal` on the top dialog
 * only, and `inert` on every lower layer.
 */
function createDialogStack(): DialogStack {
  const layers: DialogLayer[] = []
  let doc: Document | null = null
  let installed = false
  let savedOverflow: string | null = null
  let initialFocus: FocusableElement | null = null

  const top = () => layers[layers.length - 1] || null
  const focusOf = (root: HTMLElement | null | undefined): FocusableElement[] => {
    if (!root || typeof root.querySelectorAll !== 'function') return []
    let list: FocusableElement[] = []
    try {
      list = Array.prototype.slice.call(root.querySelectorAll(DIALOG_FOCUSABLE))
    } catch (_error) {
      return []
    }
    return list.filter((node) => {
      if (!node || node.disabled === true) return false
      if (typeof node.hasAttribute === 'function' && node.hasAttribute('aria-hidden')) return false
      return typeof node.focus === 'function'
    })
  }
  const firstFocusable = (root: HTMLElement | null | undefined): FocusableElement | null => {
    const list = focusOf(root)
    if (list.length === 0) return null
    // A form dialog opens on its first field rather than on its close button.
    return list.find((node) => /^(INPUT|SELECT|TEXTAREA)$/.test(String(node.tagName || ''))) || list[0]
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
    if (value === null) {
      if (typeof node.removeAttribute === 'function') node.removeAttribute(name)
      return
    }
    node.setAttribute(name, value)
  }
  /**
   * True when `node` is rendered inside `root`. A dialog opened *by* another dialog (the
   * stop confirmation lives in the management window) is a DOM descendant of the layer
   * below it, not a sibling of it.
   */
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
      // Making the hosting layer inert would make the nested top dialog inert with it:
      // its buttons and backdrop would stop receiving clicks and focus, which reads as a
      // frozen window. The top dialog's own backdrop is what covers the layer below.
      const hostsTop = !isTop && holds(layer.layer, topDialog)
      if (isTop || hostsTop) {
        if (layer.layer && typeof layer.layer.removeAttribute === 'function') layer.layer.removeAttribute('inert')
      } else {
        setAttr(layer.layer, 'inert', '')
      }
    }
  }
  const trapTab = (layer: DialogLayer, event: KeyboardEvent) => {
    const list = focusOf(layer.dialog)
    if (list.length === 0) {
      event.preventDefault()
      focusNode(layer.dialog)
      return
    }
    const active = doc ? doc.activeElement : null
    // `Document#activeElement` is typed as `Element`; by definition it is the focused element,
    // which is the FocusableElement this stack filters for.
    const index = list.indexOf(active as FocusableElement | null)
    if (index === -1) {
      event.preventDefault()
      focusNode(event.shiftKey ? list[list.length - 1] : list[0])
      return
    }
    if (event.shiftKey && index === 0) {
      event.preventDefault()
      focusNode(list[list.length - 1])
    } else if (!event.shiftKey && index === list.length - 1) {
      event.preventDefault()
      focusNode(list[0])
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const layer = top()
    if (layer === null || !event) return
    if (event.key === 'Escape') {
      // A dialog always owns Escape: even when it may not close, the key must not fall
      // through to the dialog underneath it.
      event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      if (layer.dismissible() === false) return
      layer.close()
      return
    }
    if (event.key === 'Tab') trapTab(layer, event)
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
    // A destructive confirmation names its safe action: focus lands on Cancel, not on the
    // header × or the destructive button.
    const preferred =
      typeof layer.initialFocusTestId === 'string' && layer.initialFocusTestId !== ''
        ? layer.dialog.querySelector<FocusableElement>(`[data-testid="${layer.initialFocusTestId}"]`)
        : null
    // A control the dialog disabled in this frame cannot take focus: fall back to the
    // ordinary first-focusable rule instead of leaving focus outside the dialog.
    const node =
      preferred !== null && preferred !== undefined && preferred.disabled !== true
        ? preferred
        : firstFocusable(layer.dialog)
    if (node !== null) {
      focusNode(node)
      return
    }
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
    // Hand focus back to whatever opened this dialog; a removed trigger (the dialog was
    // opened by a command channel, for example) falls back to the new top dialog.
    const restore = layer.returnFocus || (layers.length === 0 ? initialFocus : null)
    if (restore && restore !== layer.dialog) {
      const stillThere = restore.isConnected !== false
      if (stillThere) focusNode(restore)
    }
    if (layers.length > 0) {
      const active = doc && doc.activeElement
      if (!active || !top().dialog.contains(active)) focusInitial(top())
    } else {
      initialFocus = null
    }
  }

  return {
    push(layer: DialogLayer) {
      if (!layer || !layer.dialog) return () => {}
      const elementDocument = layer.dialog.ownerDocument || (typeof document === 'undefined' ? null : document)
      if (elementDocument === null) return () => {}
      install(elementDocument)
      if (layers.length === 0) {
        // Same `activeElement` widening as above: the focused element of a live document.
        initialFocus = (doc && doc.activeElement ? doc.activeElement : null) as FocusableElement | null
        lockScroll()
      } else {
        layer.returnFocus = (doc && doc.activeElement ? doc.activeElement : null) as FocusableElement | null
      }
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
}

let sharedDialogStack: DialogStack | null = null
function dialogStack(): DialogStack {
  if (sharedDialogStack === null) sharedDialogStack = createDialogStack()
  return sharedDialogStack
}

/**
 * Register one rendered dialog with the shared stack. `onClose` is read through a ref, so a
 * render that creates a new callback does not re-register (the S1-1 trigger).
 */
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
    {
      className: 'drg-field' + (props.wide === true ? ' drg-field-wide' : ''),
    },
    props.label ? box('span', 'drg-field-label', props.label) : null,
    props.children,
    props.hint ? box('span', 'drg-field-hint', props.hint) : null,
    props.error ? h('span', { className: 'drg-field-error', role: 'alert', id: props.errorId }, props.error) : null,
  )
}

function TextInput(props: TextInputProps) {
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
    onChange:
      typeof props.onChange === 'function'
        ? (event: ReactChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)
        : undefined,
    onKeyDown: typeof props.onKeyDown === 'function' ? props.onKeyDown : undefined,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.invalid === true ? 'true' : undefined,
    'aria-describedby': props.describedBy,
  })
}

function Select(props: SelectProps) {
  const options = Array.isArray(props.options) ? props.options : []
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
      onChange:
        typeof props.onChange === 'function'
          ? (event: ReactChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)
          : undefined,
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
  return h(
    Field,
    { label, hint: spec.hint ? t(spec.hint) : undefined, error, errorId },
    spec.options
      ? h(Select, {
          value: draft[spec.key],
          ariaLabel: label,
          testId: spec.testId,
          invalid: Boolean(error),
          describedBy: errorId,
          options: spec.options.map(([value, key]) => ({ value, label: t(key) })),
          onChange,
        })
      : h(TextInput, {
          type: spec.kind,
          value: draft[spec.key],
          placeholder: spec.placeholder ? t(spec.placeholder) : undefined,
          ariaLabel: label,
          testId: spec.testId,
          invalid: Boolean(error),
          describedBy: errorId,
          onChange,
        }),
  )
}

function CheckRow(props: CheckRowProps) {
  return box(
    'label',
    'drg-check',
    h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      disabled: props.disabled === true,
      'data-testid': props.testId,
      onChange:
        typeof props.onChange === 'function'
          ? (event: ReactChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked)
          : undefined,
    }),
    h('span', null, props.label),
  )
}

function Notice(props: NoticeProps) {
  const tone = props.tone || 'info'
  return h(
    'div',
    {
      className: 'drg-notice',
      'data-tone': tone,
      role: tone === 'error' ? 'alert' : 'status',
      'data-testid': props.testId,
    },
    h(
      'span',
      { className: 'drg-notice-icon', 'aria-hidden': 'true' },
      tone === 'success' ? h(IconCheck) : h(IconAlert),
    ),
    box(
      'div',
      'drg-notice-body',
      props.title ? box('div', 'drg-notice-title', props.title) : null,
      props.children !== undefined && props.children !== null ? box('div', 'drg-notice-text', props.children) : null,
    ),
  )
}

let modalSequence = 0

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

function Modal(props: ModalProps) {
  const onClose = props.onClose
  const layerRef = useRef(null)
  const dialogRef = useRef(null)
  const titleIdRef = useRef(null)
  if (titleIdRef.current === null) {
    modalSequence += 1
    titleIdRef.current = 'drg-dialog-title-' + modalSequence
  }
  // `dismissible:false` while the dialog's own request is in flight: Escape and the backdrop
  // are ignored so a busy connect/delete cannot be left running behind a closed UI (S2-5).
  const dismissible = typeof onClose === 'function' && props.dismissible !== false
  // A destructive confirmation opens on its safe action instead of the header ×: the dialog
  // names the button by test id, so the dialog stack can focus it without a second ref.
  useDialogLayer({ layerRef, dialogRef, onClose, dismissible, initialFocusTestId: props.initialFocusTestId })
  // A dialog whose title is drawn by its own body (the host-management window) still
  // needs the close affordance, but not an empty header strip above the page title.
  const bare = !props.title && !props.subtitle
  return h(
    'div',
    { className: 'drg-modal-layer', ref: layerRef },
    h('div', {
      className: 'drg-modal-backdrop',
      onClick: dismissible ? onClose : undefined,
      'aria-hidden': 'true',
      'data-dismissible': dismissible ? undefined : 'false',
    }),
    h(
      'div',
      {
        className: 'drg-modal' + (props.wide === true ? ' drg-modal-wide' : ''),
        role: 'dialog',
        'aria-labelledby': props.title ? titleIdRef.current : undefined,
        'aria-label': !props.title && props.ariaLabel ? props.ariaLabel : undefined,
        'aria-busy': props.busy === true ? 'true' : undefined,
        tabIndex: -1,
        ref: dialogRef,
        'data-testid': props.testId,
        'data-bare': bare ? 'true' : undefined,
      },
      box(
        'div',
        'drg-modal-head',
        box(
          'div',
          'drg-modal-titles',
          props.title ? h('h2', { className: 'drg-modal-title', id: titleIdRef.current }, props.title) : null,
          props.subtitle ? box('p', 'drg-modal-subtitle', props.subtitle) : null,
        ),
        typeof onClose === 'function'
          ? h(IconButton, {
              icon: h(IconClose),
              label: props.closeLabel || 'Close',
              // The header × is part of the same dismissal contract as Escape and the
              // backdrop: while the dialog's request is in flight it is disabled too
              // (review blocker 3).
              disabled: !dismissible,
              onClick: dismissible ? onClose : undefined,
            })
          : null,
      ),
      box('div', 'drg-modal-body', props.children),
      props.footer ? box('div', 'drg-modal-foot', props.footer) : null,
    ),
  )
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

function ConfirmDialog(props: ConfirmDialogProps) {
  return h(
    Modal,
    {
      title: props.title,
      onClose: props.onCancel,
      closeLabel: props.cancelLabel,
      testId: props.testId,
      busy: props.busy === true,
      dismissible: props.busy !== true,
      // A destructive confirmation focuses Cancel, so Enter cannot confirm it by accident.
      initialFocusTestId: props.cancelTestId,
      footer: footerRow(
        h(
          Button,
          {
            variant: 'secondary',
            testId: props.cancelTestId,
            onClick: props.onCancel,
            disabled: props.busy === true,
          },
          props.cancelLabel,
        ),
        h(
          Button,
          { variant: 'danger', testId: props.confirmTestId, onClick: props.onConfirm, busy: props.busy === true },
          props.confirmLabel,
        ),
      ),
    },
    box('p', 'drg-paragraph', props.body),
  )
}

/**
 * The confirmation for the destructive stop action: one line on what happens, plus what
 * survives (the host, its settings and credentials).
 */
interface StopRemoteDialogProps extends LocaleProps {
  busy?: boolean
  onConfirm?: () => void
  onCancel?: () => void
}

function StopRemoteDialog(props: StopRemoteDialogProps) {
  const t = translatorOf(props)
  return h(ConfirmDialog, {
    title: t('stopRemoteTitle'),
    body: t('stopRemoteBody'),
    confirmLabel: props.busy === true ? t('stopRemoteBusy') : t('stopRemoteConfirm'),
    cancelLabel: t('cancel'),
    busy: props.busy === true,
    testId: 'stop-remote-dialog',
    confirmTestId: 'stop-remote-confirm',
    cancelTestId: 'stop-remote-cancel',
    onConfirm: props.onConfirm,
    onCancel: props.onCancel,
  })
}
