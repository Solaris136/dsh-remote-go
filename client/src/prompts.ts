// client/src/prompts.ts - PasswordPrompt and RemoteConflictPrompt (region 13); after settings.ts, before toast.ts.
//#region 13. password prompt

function PasswordPrompt(props) {
  const t = translatorOf(props)
  const host = props.host || {}
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
        onChange: (value) => {
          setPassword(value)
          setServerErrorCleared(true)
          if (localError !== '') setLocalError('')
        },
        onKeyDown: (event) => {
          if (event && event.key === 'Enter') submit()
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
              onChange: (event) => setRemember(event.target.checked === true),
            }),
            h('span', null, t('passwordPromptRemember')),
          ),
          previouslySaved ? box('p', 'drg-field-hint', t('passwordPromptForgetHint')) : null,
        )
      : box('p', 'drg-field-hint', t('passwordPromptNoStorage')),
  )
}

/** The remote already runs a DSH this plugin did not start: the choices are explicit, the pipeline waits. */
function RemoteConflictPrompt(props) {
  const t = translatorOf(props)
  const host = props.host || {}
  const conflict = host.conflict && typeof host.conflict === 'object' ? host.conflict : {}
  const processes = Array.isArray(conflict.processes) ? conflict.processes : []
  const busy = props.busy === true
  const resolve = (action) => {
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
      processes.map((process) =>
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
