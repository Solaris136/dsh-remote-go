// client/src/prompts.ts - PasswordPrompt, passwordEnterSubmits and RemoteConflictPrompt (region 13); after settings.ts, before toast.ts.
//#region 13. password prompt

/**
 * Whether an Enter keypress means "submit this password".
 *
 * Enter is also how a CJK input method confirms a candidate, and that Enter arrives while the word
 * is still being composed: submitting there sends half a password, which reads to the user as a
 * failed login rather than as a keystroke they never made. React's synthetic event does not carry
 * `isComposing`, so the native event is the only source; Safari additionally sends the composing
 * Enter after clearing `isComposing`, which is why the keyed `229` value is checked as well (MWG
 * `ime-safe-enter-submit`, its first strategy). Anything that is not an Enter is not a submit.
 */
/** The Enter gate sees a React synthetic event or a native one, so it names both shapes. */
interface PasswordKeyEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: PasswordKeyEvent
}

function passwordEnterSubmits(event: PasswordKeyEvent): boolean {
  if (!event || event.key !== 'Enter') return false
  // The synthetic event is not required to expose these: fall back to it only when React handed
  // out no native one (a test double, or a host that wrapped the event).
  const native = event.nativeEvent || event
  if (native.isComposing === true || event.isComposing === true) return false
  // 229 is the value every engine that loses `isComposing` reports for a composing key event.
  return native.keyCode !== 229 && event.keyCode !== 229
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
  // Remembering is the default: the user asked for a password they type once to be reused
  // later. It stays escapable for a borrowed or shared machine.
  const [remember, setRemember] = useState(props.storageAvailable === true)
  const [localError, setLocalError] = useState('')
  // A failure reported by the previous connect attempt is cleared as soon as the user
  // edits the password, like every other field error.
  const [serverErrorCleared, setServerErrorCleared] = useState(false)
  const canRemember = props.storageAvailable === true
  const previouslySaved = host.passwordSaved === true
  const submit = () => {
    // Enter can fire faster than React disables the field: the guard lives in the handler
    // itself, so one prompt can never start two `POST /connect` requests (audit S2-2).
    if (props.busy === true) return
    if (String(password).trim() === '') {
      setLocalError(t('passwordPromptRequired'))
      return
    }
    setLocalError('')
    if (typeof props.onSubmit === 'function') props.onSubmit({ password, remember: canRemember && remember })
  }
  return h(
    Modal,
    {
      title: t('passwordPromptTitle'),
      onClose: props.onCancel,
      closeLabel: t('cancel'),
      testId: 'password-prompt',
      busy: props.busy === true,
      // While the connect request is in flight the dialog must not disappear under it:
      // the answer arrives into this prompt (audit S2-2/S2-5).
      dismissible: props.busy !== true,
      footer: footerRow(
        h(Button, { variant: 'ghost', onClick: props.onCancel, disabled: props.busy === true }, t('cancel')),
        h(
          Button,
          { variant: 'primary', testId: 'password-submit', busy: props.busy === true, onClick: submit },
          t('passwordPromptSubmit'),
        ),
      ),
    },
    box(
      'p',
      'drg-paragraph',
      t(canRemember ? 'passwordPromptBody' : 'passwordPromptBodyNoStorage', {
        name: host.name || host.id || '',
      }),
    ),
    h(
      Field,
      {
        label: t('passwordPromptLabel'),
        error: localError || (serverErrorCleared ? '' : typeof props.error === 'string' ? props.error : ''),
        errorId: 'password-prompt-error',
      },
      h(TextInput, {
        type: 'password',
        value: password,
        placeholder: t('wizard.passwordPlaceholder'),
        autoComplete: 'off',
        testId: 'password-input',
        ariaLabel: t('passwordPromptLabel'),
        disabled: props.busy === true,
        invalid: localError !== '' || (!serverErrorCleared && typeof props.error === 'string'),
        describedBy: 'password-prompt-error',
        onChange: (value: string) => {
          setPassword(value)
          setServerErrorCleared(true)
          if (localError !== '') setLocalError('')
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (passwordEnterSubmits(event)) submit()
        },
      }),
    ),
    canRemember
      ? box(
          'div',
          'drg-remember',
          h(
            'label',
            { className: 'drg-check', 'data-testid': 'password-remember' },
            h('input', {
              type: 'checkbox',
              checked: remember,
              onChange: (event: ReactChangeEvent<HTMLInputElement>) => setRemember(event.target.checked === true),
            }),
            h('span', null, t('passwordPromptRemember')),
          ),
          previouslySaved ? box('p', 'drg-field-hint', t('passwordPromptForgetHint')) : null,
        )
      : box('p', 'drg-field-hint', t('passwordPromptNoStorage')),
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
  return h(
    Modal,
    {
      title: t('conflictTitle'),
      onClose: () => resolve('cancel'),
      closeLabel: t('cancel'),
      testId: 'remote-conflict-prompt',
      wide: true,
      busy,
      dismissible: !busy,
      footer: footerRow(
        h(
          Button,
          { variant: 'ghost', onClick: () => resolve('cancel'), disabled: busy, testId: 'conflict-cancel' },
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
    box(
      'ul',
      'drg-conflict-processes',
      processes.map((process: { pid: number; command: string }) =>
        h(
          'li',
          { key: String(process.pid) },
          h('code', null, `pid ${process.pid}`),
          ' ',
          h('span', null, process.command || ''),
        ),
      ),
    ),
    box('p', 'drg-field-hint', t('conflictHint')),
    props.error ? h(Notice, { tone: 'error' }, props.error) : null,
    busy ? box('p', 'drg-field-hint', t('conflictBusy')) : null,
  )
}
