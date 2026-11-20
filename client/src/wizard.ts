// client/src/wizard.ts - WizardDialog and its add/edit steps (region 10); after wizard-draft.ts, before diagnostics.ts.
/** The wizard's props: the mode, the host being edited, the snapshot and the shell's callbacks. */
interface WizardDialogProps extends LocaleProps {
  mode?: string
  initialHost?: HostLike | null
  state?: StateView | null
  onClose?: () => void
  onRefresh?: () => void
  onSaved?: (saved: HostLike | null | undefined, warning: string | null) => void
  onConnect?: (host: HostLike, password: string | null, remember: boolean) => void
}

function WizardDialog(props: WizardDialogProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const mode = props.mode === 'edit' ? 'edit' : 'add'
  const initialHost = props.initialHost || null
  const stateView = props.state && typeof props.state === 'object' ? props.state : null
  // Whether a store exists: StateView carries it, and the per-Host field covers an older Host or an early edit.
  const storageAvailable =
    stateView !== null
      ? stateView.passwordStorageAvailable === true ||
        (Array.isArray(stateView.hosts) &&
          stateView.hosts.some((entry) => entry && entry.passwordStorageAvailable === true))
      : initialHost !== null && initialHost.passwordStorageAvailable === true
  const [draft, setDraft] = useState<HostDraftForm>(() =>
    initialDraft(mode, initialHost, props.state && props.state.settings ? props.state.settings : null),
  )
  const [password, setPassword] = useState('')
  // Remembering is the default; the box lets a shared machine opt out for this connection.
  const [remember, setRemember] = useState(true)
  const [authDirty, setAuthDirty] = useState(mode === 'add')
  const [nameTouched, setNameTouched] = useState(mode === 'edit')
  const hostId = initialHost && typeof initialHost.id === 'string' ? initialHost.id : ''
  const [saving, setSaving] = useState<string | null>(null)
  const [formError, setFormError] = useState<unknown>(null)
  /** Field-level messages keyed by draft field, cleared as soon as that field changes. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [aliases, setAliases] = useState<SshAliasEntry[]>([])
  const [knownHosts, setKnownHosts] = useState<KnownHostsSummary | null>(null)
  const [aliasesLoading, setAliasesLoading] = useState(false)
  // Key-file picker overlay (browsing lives in the Host; this is only dialog state).
  const [keyPicker, setKeyPicker] = useState(false)
  const onRefresh = typeof props.onRefresh === 'function' ? props.onRefresh : () => {}
  // Load SSH config aliases once, for the address datalist.
  useEffect(() => {
    let cancelled = false
    setAliasesLoading(true)
    api.getAliases().then(
      (result) => {
        if (cancelled) return
        setAliases(Array.isArray(result.aliases) ? result.aliases : [])
        setKnownHosts(result.knownHosts || null)
        setAliasesLoading(false)
      },
      () => {
        if (!cancelled) setAliasesLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const patchDraft = (patch: Record<string, unknown>) => {
    setDraft((current) => ({ ...current, ...patch }))
    // Correcting a field clears its own error (and the summary) instead of leaving a stale message until the next save.
    setFieldErrors((current) => {
      const touched = Object.keys(patch).filter((key) => current[key] !== undefined)
      if (touched.length === 0) return current
      const next = { ...current }
      for (const key of touched) delete next[key]
      return next
    })
    if (formError !== null) setFormError(null)
  }
  const row = (spec: FormRowSpec) => formRow(t, draft, patchDraft, { ...spec, error: fieldErrors[spec.key] })
  // Every field `validateHostDraft` can name has a `wizard-<kebab-field>` input.
  const focusField = (field: string) => {
    if (typeof document === 'undefined' || !document.querySelector) return
    const testId = 'wizard-' + field.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
    const node = document.querySelector<HTMLElement>('[data-testid="' + testId + '"]')
    if (node && typeof node.focus === 'function') node.focus()
  }

  const applyAlias = (address: string, user: string | null, port: number) => {
    patchDraft({ address, username: user || draft.username, port: port || draft.port })
    if (!nameTouched && mode === 'add') patchDraft({ name: address })
  }
  const onAddressChange = (value: string) => {
    patchDraft({ address: value })
    if (!nameTouched && mode === 'add') patchDraft({ name: value.trim() })
    const match = aliases.find((alias) => alias && alias.alias === value.trim())
    if (match) applyAlias(match.alias, match.user, match.port)
  }
  const pickAlias = (alias: SshAliasEntry | null | undefined) => {
    if (alias) applyAlias(alias.alias || alias.host || '', alias.user, alias.port)
  }

  const submit = async (intent: 'save' | 'connect') => {
    // An edit that leaves authentication alone keeps the credential, so it needs no password; typed ones are saved.
    const includeAuth = mode === 'add' || authDirty
    const invalid = validateHostDraft(
      { ...draft, password },
      { requireKeyPath: includeAuth, requirePassword: draft.authType === 'password' && includeAuth },
    )
    if (invalid !== null) {
      setFieldErrors({ [invalid.field]: invalid.code })
      setFormError(invalid.code)
      focusField(invalid.field)
      return
    }
    setFieldErrors({})
    setFormError(null)
    setSaving(intent)
    try {
      const saved = await api.saveHost(buildHostInput(draft, hostId || undefined, includeAuth))
      const id = saved && typeof saved.id === 'string' ? saved.id : hostId
      onRefresh()
      const typedPassword = draft.authType === 'password' && String(password).trim() !== '' ? password : null
      const rememberPassword = typedPassword !== null && storageAvailable && remember
      if (intent === 'connect' && id) {
        // It carries the typed password (no second prompt) and the remember flag; persisted once SSH accepts.
        if (typeof props.onConnect === 'function') {
          props.onConnect(saved && saved.id ? saved : { id }, typedPassword, rememberPassword)
        }
        return
      }
      // "Save" does not connect, so the Host stores (or forgets) the password; otherwise the next connect asks again.
      let warning = null
      if (id && typedPassword !== null && storageAvailable) {
        try {
          const result = await api.saveHostPassword(
            id,
            rememberPassword ? { password: typedPassword } : { clear: true },
          )
          if (rememberPassword && result && result.saved !== true) warning = t('wizard.passwordSaveFailed')
        } catch (_error) {
          if (rememberPassword) warning = t('wizard.passwordSaveFailed')
        }
      }
      if (typeof props.onSaved === 'function') props.onSaved(saved, warning)
      props.onClose()
    } catch (error) {
      setSaving(null)
      const view = toErrorView(error)
      // A Host validation error names a field when it can; keep it next to that field too.
      if (view && typeof view.field === 'string') setFieldErrors({ [view.field]: view.code })
      setFormError(view)
    }
  }

  const cancel = () => props.onClose()
  const saveLabel = saving === 'save' ? t('wizard.savingHost') : t('save')
  const connectLabel = saving === 'connect' ? t('wizard.savingHost') : t('connect')
  const saveButton = h(
    Button,
    {
      variant: mode === 'add' ? 'secondary' : 'primary',
      testId: 'wizard-save',
      busy: saving === 'save',
      disabled: saving === 'connect',
      onClick: () => submit('save'),
    },
    saveLabel,
  )
  // Connecting from the dialog is add-mode only: a save just changes the entry, and connections restart from the list.
  const connectButton =
    mode === 'add'
      ? h(
          Button,
          {
            variant: 'primary',
            testId: 'wizard-connect',
            busy: saving === 'connect',
            disabled: saving === 'save',
            onClick: () => submit('connect'),
          },
          connectLabel,
        )
      : null
  const footer = box('div', 'drg-row drg-row-end', saveButton, connectButton)
  const addressOptions = aliases.filter((alias) => alias && typeof alias.alias === 'string')
  const addressHintText = t('wizard.addressHint')
  const addressError = fieldErrors.address ? t(dictionaryKey(fieldErrors.address)) : undefined
  const addressInput = h(TextInput, {
    key: 'address',
    value: draft.address,
    placeholder: t('wizard.addressPlaceholder'),
    ariaLabel: t('wizard.address'),
    list: 'drg-ssh-alias-list',
    testId: 'wizard-address',
    invalid: Boolean(fieldErrors.address),
    describedBy: fieldErrors.address ? 'wizard-address-error' : undefined,
    onChange: onAddressChange,
  })
  const aliasOption = (alias: SshAliasEntry) => h('option', { key: alias.alias, value: alias.alias }, alias.host || '')
  const addressDatalist = h('datalist', { key: 'aliases', id: 'drg-ssh-alias-list' }, addressOptions.map(aliasOption))
  const addressField = h(
    Field,
    {
      label: t('wizard.address'),
      hint: addressHintText,
      error: addressError,
      errorId: fieldErrors.address ? 'wizard-address-error' : undefined,
    },
    addressInput,
    addressDatalist,
  )
  const aliasTitle = (alias: SshAliasEntry) => [alias.user, alias.host, alias.port].filter(Boolean).join(' ')
  const aliasChip = (alias: SshAliasEntry) =>
    h(
      'button',
      {
        key: alias.alias,
        type: 'button',
        className: 'drg-chip',
        title: aliasTitle(alias),
        onClick: () => pickAlias(alias),
      },
      alias.alias,
    )
  const knownHostsNote =
    knownHosts && knownHosts.entries
      ? box('span', 'drg-alias-known', t('wizard.knownHosts', { count: knownHosts.entries }))
      : null
  const aliasChips = box(
    'div',
    'drg-alias-row',
    box('span', 'drg-alias-label', t('wizard.aliases')),
    addressOptions.map(aliasChip),
    knownHostsNote,
  )
  const aliasRow =
    addressOptions.length > 0
      ? aliasChips
      : aliasesLoading
        ? box('p', 'drg-field-hint', t('wizard.aliasesLoading'))
        : box('p', 'drg-field-hint', t('wizard.aliasesEmpty'))
  const errorNotice =
    formError === null
      ? null
      : h(
          Notice,
          { tone: 'error' },
          // A local validation message is a dictionary key; a Host failure carries an ErrorView instead.
          typeof formError === 'string'
            ? t(dictionaryKey(formError))
            : resolveText(toErrorView(formError).detail, locale),
        )
  const nameRow = row({
    key: 'name',
    label: 'wizard.name',
    placeholder: 'wizard.namePlaceholder',
    testId: 'wizard-name',
    after: () => setNameTouched(true),
  })
  const grid3 = box(
    'div',
    'drg-form-grid drg-form-grid-3',
    row({ key: 'port', kind: 'number', label: 'wizard.port', testId: 'wizard-port' }),
    row({
      key: 'username',
      label: 'wizard.username',
      placeholder: 'wizard.usernamePlaceholder',
      testId: 'wizard-username',
    }),
    row({
      key: 'jumpHost',
      label: 'wizard.jumpHost',
      placeholder: 'wizard.jumpHostPlaceholder',
      testId: 'wizard-jump-host',
    }),
  )
  const authRow = row({
    key: 'authType',
    label: 'wizard.auth',
    hint: 'wizard.authHint',
    testId: 'wizard-auth',
    after: () => setAuthDirty(true),
    options: [
      ['key', 'wizard.authKey'],
      ['password', 'wizard.authPassword'],
    ],
  })
  const keyPathError = fieldErrors.keyPath ? t(dictionaryKey(fieldErrors.keyPath)) : undefined
  const keyPathInput = h(TextInput, {
    value: draft.keyPath,
    placeholder: t('wizard.keyPathPlaceholder'),
    ariaLabel: t('wizard.keyPath'),
    testId: 'wizard-key-path',
    invalid: Boolean(fieldErrors.keyPath),
    describedBy: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
    onChange: (value: string) => {
      setAuthDirty(true)
      patchDraft({ keyPath: value })
    },
  })
  const keyPick = h(
    Button,
    { variant: 'secondary', testId: 'wizard-key-path-pick', onClick: () => setKeyPicker(true) },
    t('wizard.keyPathPick'),
  )
  const keyPathRow =
    draft.authType === 'key'
      ? h(
          Field,
          {
            label: t('wizard.keyPath'),
            error: keyPathError,
            errorId: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
          },
          box('div', 'drg-field-inline', keyPathInput, keyPick),
        )
      : null
  const storageHint = storageAvailable ? t('wizard.passwordPlaceholder') : t('passwordPromptNoStorage')
  const passwordError = fieldErrors.password ? t(dictionaryKey(fieldErrors.password)) : undefined
  const passwordInput = h(TextInput, {
    type: 'password',
    value: password,
    placeholder: storageHint,
    ariaLabel: t('wizard.password'),
    testId: 'wizard-password',
    invalid: Boolean(fieldErrors.password),
    describedBy: fieldErrors.password ? 'wizard-password-error' : undefined,
    onChange: (value: string) => {
      setAuthDirty(true)
      // Clear the field error as every input does: the password has no draft field, so it stuck after `patchDraft`.
      setFieldErrors((current) => {
        if (current.password === undefined) return current
        const next = { ...current }
        delete next.password
        return next
      })
      if (formError !== null) setFormError(null)
      setPassword(value)
    },
  })
  const passwordHint = mode === 'edit' && !authDirty ? t('wizard.passwordSavedHint') : storageHint
  const passwordField =
    draft.authType === 'password'
      ? h(
          Field,
          {
            key: 'password',
            label: t('wizard.password'),
            hint: passwordHint,
            error: passwordError,
            errorId: fieldErrors.password ? 'wizard-password-error' : undefined,
          },
          passwordInput,
        )
      : null
  const rememberRow =
    draft.authType === 'password' && (mode === 'add' || authDirty)
      ? storageAvailable
        ? box(
            'div',
            'drg-remember',
            h(CheckRow, {
              checked: remember,
              label: t('wizard.passwordRemember'),
              testId: 'wizard-password-remember',
              onChange: setRemember,
            }),
            h('p', { className: 'drg-field-hint' }, t('wizard.passwordRememberHint')),
          )
        : h('p', { key: 'no-storage', className: 'drg-field-hint' }, t('passwordPromptNoStorage'))
      : null
  const autoReconnectRow = h(CheckRow, {
    checked: draft.autoReconnect !== false,
    label: t('wizard.autoReconnect'),
    testId: 'wizard-auto-reconnect',
    onChange: (checked: boolean) => patchDraft({ autoReconnect: checked }),
  })
  const policySelect = h(Select, {
    value: draft.hostKeyPolicy,
    ariaLabel: t('settings.hostKeyPolicy'),
    testId: 'wizard-host-key-policy',
    options: [
      { value: 'first-use', label: t('settings.hostKeyPolicyFirstUse') },
      { value: 'strict', label: t('settings.hostKeyPolicyStrict') },
    ],
    onChange: (value: string) => patchDraft({ hostKeyPolicy: value }),
  })
  const advancedGrid = box(
    'div',
    'drg-form-grid drg-form-grid-3',
    row({
      key: 'keepAlive',
      label: 'wizard.keepAlive',
      testId: 'wizard-keep-alive',
      options: [
        ['keep', 'wizard.keepAliveKeep'],
        ['stop', 'wizard.keepAliveStop'],
        ['idle', 'wizard.keepAliveIdle'],
      ],
    }),
    draft.keepAlive === 'idle'
      ? row({ key: 'idleMinutes', kind: 'number', label: 'wizard.idleMinutes', testId: 'wizard-idle-minutes' })
      : null,
    h(Field, { label: t('settings.hostKeyPolicy') }, policySelect),
  )
  const advanced = h(
    'details',
    { className: 'drg-advanced', 'data-testid': 'wizard-advanced' },
    h('summary', null, t('wizard.advanced')),
    box('div', 'drg-advanced-body', advancedGrid),
  )
  const loopbackNote = !isLoopbackAddress(draft.address) ? box('p', 'drg-field-hint', t('loopbackNote')) : null
  const body = box(
    'div',
    'drg-wizard-form',
    errorNotice,
    box('div', 'drg-form-grid', nameRow, addressField),
    aliasRow,
    grid3,
    authRow,
    keyPathRow,
    passwordField,
    rememberRow,
    autoReconnectRow,
    advanced,
    box('p', 'drg-field-hint', t('wizard.actionHint')),
    loopbackNote,
  )
  const picker = h(KeyFilePicker, {
    t,
    locale,
    initialDir: '',
    onPick: (pickedPath) => {
      setKeyPicker(false)
      setAuthDirty(true)
      patchDraft({ keyPath: pickedPath })
    },
    onClose: () => setKeyPicker(false),
  })
  return h(
    React.Fragment,
    null,
    h(
      Modal,
      {
        title: mode === 'edit' ? t('editHostTitle') : t('addHostTitle'),
        onClose: cancel,
        closeLabel: t('close'),
        wide: true,
        testId: 'host-wizard',
        busy: saving !== null,
        dismissible: saving === null,
        footer,
      },
      h('div', { className: 'drg-wizard-body', 'data-testid': 'wizard-form' }, body),
    ),
    keyPicker ? picker : null,
  )
}
