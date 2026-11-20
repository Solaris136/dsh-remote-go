// client/src/prompts.ts - PasswordPrompt, passwordEnterSubmits and RemoteConflictPrompt (region 13); after settings.ts, before toast.ts.
//#region 13. password prompt

/** Whether Enter submits this password: an IME also confirms with Enter, while the word is still being composed. */
// Submitting there sends half a password, which reads as a failed login rather than a keystroke never made.
// The synthetic event carries no `isComposing`, so the native one is the source; Safari clears it, hence `229`.
interface PasswordKeyEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: PasswordKeyEvent
}

function passwordEnterSubmits(event: PasswordKeyEvent): boolean {
  if (!event || event.key !== 'Enter') return false
  // The synthetic event need not carry these: fall back to it when React handed out no native one.
  const native = event.nativeEvent || event
  // 229 is the value every engine that loses `isComposing` reports for a composing key event.
  return native.isComposing !== true && event.isComposing !== true && native.keyCode !== 229 && event.keyCode !== 229
}

/** What the password prompt submits: the one-shot password and whether to remember it. */
interface PasswordSubmission {
  password: string
  remember: boolean
}

/** The password prompt's props. */
interface PasswordPromptProps extends LocaleProps {
  host?: Partial<HostView> | null
  busy?: boolean
  error?: unknown
  storageAvailable?: boolean
  onSubmit?: (submission: PasswordSubmission) => void
  onCancel?: () => void
}

function PasswordPrompt(props: PasswordPromptProps) {
  const t = translatorOf(props)
  const host: Partial<HostView> = props.host || {}
  const [password, setPassword] = useState('')
  // Remembering is the default; the box lets a borrowed or shared machine opt out.
  const [remember, setRemember] = useState(props.storageAvailable === true)
  const [localError, setLocalError] = useState('')
  // A failure from the previous connect attempt clears as soon as the password is edited.
  const [errorCleared, setErrorCleared] = useState(false)
  const busy = props.busy === true
  const canRemember = props.storageAvailable === true
  const serverError = errorCleared || typeof props.error !== 'string' ? '' : props.error
  const name = host.name || host.id || ''
  const submit = () => {
    // Enter can fire faster than React disables the field, so the guard is in the handler: one prompt posts once.
    if (busy) return
    if (String(password).trim() === '') {
      setLocalError(t('passwordPromptRequired'))
      return
    }
    setLocalError('')
    if (typeof props.onSubmit === 'function') props.onSubmit({ password, remember: canRemember && remember })
  }
  const onRemember = (event: ReactChangeEvent<HTMLInputElement>) => setRemember(event.target.checked === true)
  const tick = h('input', { type: 'checkbox', checked: remember, onChange: onRemember })
  const remembered = h('span', null, t('passwordPromptRemember'))
  const rememberLabel = h('label', { className: 'drg-check', 'data-testid': 'password-remember' }, tick, remembered)
  const forgetHint = host.passwordSaved === true ? box('p', 'drg-field-hint', t('passwordPromptForgetHint')) : null
  const rememberBox = box('div', 'drg-remember', rememberLabel, forgetHint)
  return h(
    Modal,
    {
      title: t('passwordPromptTitle'),
      onClose: props.onCancel,
      closeLabel: t('cancel'),
      testId: 'password-prompt',
      busy,
      // The answer arrives into this prompt, so it must not vanish under the request in flight.
      dismissible: !busy,
      footer: footerRow(
        h(Button, { variant: 'ghost', onClick: props.onCancel, disabled: busy }, t('cancel')),
        h(Button, { variant: 'primary', testId: 'password-submit', busy, onClick: submit }, t('passwordPromptSubmit')),
      ),
    },
    box('p', 'drg-paragraph', t(canRemember ? 'passwordPromptBody' : 'passwordPromptBodyNoStorage', { name })),
    h(
      Field,
      { label: t('passwordPromptLabel'), error: localError || serverError, errorId: 'password-prompt-error' },
      h(TextInput, {
        type: 'password',
        value: password,
        placeholder: t('wizard.passwordPlaceholder'),
        autoComplete: 'off',
        testId: 'password-input',
        ariaLabel: t('passwordPromptLabel'),
        disabled: busy,
        invalid: localError !== '' || (!errorCleared && typeof props.error === 'string'),
        describedBy: 'password-prompt-error',
        onChange: (value: string) => {
          setPassword(value)
          setErrorCleared(true)
          if (localError !== '') setLocalError('')
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (passwordEnterSubmits(event)) submit()
        },
      }),
    ),
    canRemember ? rememberBox : box('p', 'drg-field-hint', t('passwordPromptNoStorage')),
  )
}

/** The remote already runs a DSH this plugin did not start: the choices are explicit, the pipeline waits. */
interface RemoteConflictPromptProps extends LocaleProps {
  host?: HostView | null
  busy?: boolean
  error?: ReactNode
  onResolve?: (host: Partial<HostView>, action: string) => void
}

function RemoteConflictPrompt(props: RemoteConflictPromptProps) {
  const t = translatorOf(props)
  const host: Partial<HostView> = props.host || {}
  const conflict: Partial<HostConflictView> = host.conflict && typeof host.conflict === 'object' ? host.conflict : {}
  const processes: HostConflictView['processes'] = Array.isArray(conflict.processes) ? conflict.processes : []
  const busy = props.busy === true
  const resolve = (action: string) => {
    if (busy) return
    if (typeof props.onResolve === 'function') props.onResolve(host, action)
  }
  const cancel = () => resolve('cancel')
  const rows = processes.map((process: { pid: number; command: string }) =>
    h(
      'li',
      { key: String(process.pid) },
      h('code', null, `pid ${process.pid}`),
      ' ',
      h('span', null, process.command || ''),
    ),
  )
  return h(
    Modal,
    {
      title: t('conflictTitle'),
      onClose: cancel,
      closeLabel: t('cancel'),
      testId: 'remote-conflict-prompt',
      wide: true,
      busy,
      dismissible: !busy,
      footer: footerRow(
        h(
          Button,
          { variant: 'ghost', onClick: cancel, disabled: busy, testId: 'conflict-cancel' },
          t('conflictCancel'),
        ),
        h(
          Button,
          { variant: 'danger', onClick: () => resolve('stop'), busy, testId: 'conflict-stop' },
          t('conflictStop'),
        ),
        h(
          Button,
          { variant: 'primary', onClick: () => resolve('alongside'), busy, testId: 'conflict-alongside' },
          t('conflictAlongside'),
        ),
      ),
    },
    box('p', 'drg-paragraph', t('conflictBody', { name: host.name || host.id || '', count: processes.length })),
    box('ul', 'drg-conflict-processes', rows),
    box('p', 'drg-field-hint', t('conflictHint')),
    props.error ? h(Notice, { tone: 'error' }, props.error) : null,
    busy ? box('p', 'drg-field-hint', t('conflictBusy')) : null,
  )
}
