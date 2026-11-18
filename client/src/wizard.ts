// client/src/wizard.ts - WizardDialog and its add/edit steps (region 10); after wizard-draft.ts, before diagnostics.ts.
function WizardDialog(props) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const mode = props.mode === 'edit' ? 'edit' : 'add'
  const initialHost = props.initialHost || null
  const stateView = props.state && typeof props.state === 'object' ? props.state : null
  // Whether a credential store exists here. StateView carries the fact; the per-Host field
  // is the fallback for a Host from before that field existed, and for an edit opened
  // before the first state frame arrived.
  const storageAvailable =
    stateView !== null
      ? stateView.passwordStorageAvailable === true ||
        (Array.isArray(stateView.hosts) &&
          stateView.hosts.some((entry) => entry && entry.passwordStorageAvailable === true))
      : initialHost !== null && initialHost.passwordStorageAvailable === true
  const [draft, setDraft] = useState(() =>
    initialDraft(mode, initialHost, props.state && props.state.settings ? props.state.settings : null),
  )
  const [password, setPassword] = useState('')
  // Remembering is the default; the box lets a shared machine opt out for this connection.
  const [remember, setRemember] = useState(true)
  const [authDirty, setAuthDirty] = useState(mode === 'add')
  const [nameTouched, setNameTouched] = useState(mode === 'edit')
  const hostId = initialHost && typeof initialHost.id === 'string' ? initialHost.id : ''
  const [saving, setSaving] = useState(null)
  const [formError, setFormError] = useState(null)
  /** Field-level messages keyed by draft field, cleared as soon as that field changes. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [aliases, setAliases] = useState([])
  const [knownHosts, setKnownHosts] = useState(null)
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

  const patchDraft = (patch) => {
    setDraft((current) => ({ ...current, ...patch }))
    // Correcting a field clears its own error (and the summary) instead of leaving a stale
    // message until the next save (audit S2-3).
    setFieldErrors((current) => {
      const next = { ...current }
      let changed = false
      for (const key of Object.keys(patch)) {
        if (next[key] !== undefined) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : current
    })
    if (formError !== null) setFormError(null)
  }
  const row = (spec) => formRow(t, draft, patchDraft, { ...spec, error: fieldErrors[spec.key] })
  const focusField = (field) => {
    if (typeof document === 'undefined' || !document.querySelector) return
    const testId = {
      name: 'wizard-name',
      address: 'wizard-address',
      port: 'wizard-port',
      username: 'wizard-username',
      idleMinutes: 'wizard-idle-minutes',
      keyPath: 'wizard-key-path',
      password: 'wizard-password',
    }[field]
    if (!testId) return
    const node = document.querySelector<HTMLElement>('[data-testid="' + testId + '"]')
    if (node && typeof node.focus === 'function') node.focus()
  }

  const onAddressChange = (value) => {
    patchDraft({ address: value })
    if (!nameTouched && mode === 'add') patchDraft({ name: value.trim() })
    const match = aliases.find((alias) => alias && alias.alias === value.trim())
    if (match) {
      patchDraft({
        address: match.alias,
        username: match.user || draft.username,
        port: match.port || draft.port,
      })
      if (!nameTouched && mode === 'add') patchDraft({ name: match.alias })
    }
  }
  const pickAlias = (alias) => {
    if (!alias) return
    patchDraft({
      address: alias.alias || alias.host || '',
      username: alias.user || draft.username,
      port: alias.port || draft.port,
    })
    if (!nameTouched && mode === 'add') patchDraft({ name: alias.alias || alias.host || '' })
  }

  const submit = async (intent) => {
    // An edit that does not touch authentication keeps the stored credential, so it does
    // not need (and must not demand) a password: the connection asks for it later
    // (audit S2-2). A password typed into the wizard is saved by default; the box below
    // the field turns it into a one-time value.
    const requiresPassword = draft.authType === 'password' && (mode === 'add' || authDirty)
    const invalid = validateHostDraft(
      { ...draft, password },
      { requireKeyPath: mode === 'add' || authDirty, requirePassword: requiresPassword },
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
      const includeAuth = mode === 'add' || authDirty
      const saved = await api.saveHost(buildHostInput(draft, hostId || undefined, includeAuth))
      const id = saved && typeof saved.id === 'string' ? saved.id : hostId
      onRefresh()
      const typedPassword = draft.authType === 'password' && String(password).trim() !== '' ? password : null
      const rememberPassword = typedPassword !== null && storageAvailable && remember
      if (intent === 'connect' && id) {
        // The connection carries the typed password (so the user is not asked again) and
        // the remember decision; the Host persists it once SSH accepts it.
        if (typeof props.onConnect === 'function') {
          props.onConnect(saved && saved.id ? saved : { id }, typedPassword, rememberPassword)
        }
        return
      }
      // "Save" does not connect, so the Host stores (or forgets) the password directly;
      // otherwise the value would be lost and the next connect would ask for it again.
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

  const handleCancel = () => {
    props.onClose()
  }

  const saveButton = h(
    Button,
    {
      variant: mode === 'add' ? 'secondary' : 'primary',
      testId: 'wizard-save',
      busy: saving === 'save',
      disabled: saving === 'connect',
      onClick: () => submit('save'),
    },
    saving === 'save' ? t('wizard.savingHost') : t('save'),
  )
  // Connecting from the dialog is an add-mode action: saving an edit only changes the
  // entry, and the host list is where a connection is (re)started.
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
          saving === 'connect' ? t('wizard.savingHost') : t('connect'),
        )
      : null
  const footer = box('div', 'drg-row drg-row-end', saveButton, connectButton)
  const addressOptions = aliases.filter((alias) => alias && typeof alias.alias === 'string')
  const body = box(
    'div',
    'drg-wizard-form',
    formError
      ? h(
          Notice,
          { tone: 'error' },
          // A local validation message is a dictionary key; a Host failure carries an ErrorView
          // instead and goes through resolveText below.
          typeof formError === 'string'
            ? t(dictionaryKey(formError))
            : resolveText(toErrorView(formError).detail, locale),
        )
      : null,
    box(
      'div',
      'drg-form-grid',
      row({
        key: 'name',
        label: 'wizard.name',
        placeholder: 'wizard.namePlaceholder',
        testId: 'wizard-name',
        after: () => setNameTouched(true),
      }),
      h(
        Field,
        {
          label: t('wizard.address'),
          hint: t('wizard.addressHint'),
          error: fieldErrors.address ? t(dictionaryKey(fieldErrors.address)) : undefined,
          errorId: fieldErrors.address ? 'wizard-address-error' : undefined,
        },
        [
          h(TextInput, {
            key: 'address',
            value: draft.address,
            placeholder: t('wizard.addressPlaceholder'),
            ariaLabel: t('wizard.address'),
            list: 'drg-ssh-alias-list',
            testId: 'wizard-address',
            invalid: Boolean(fieldErrors.address),
            describedBy: fieldErrors.address ? 'wizard-address-error' : undefined,
            onChange: onAddressChange,
          }),
          h(
            'datalist',
            { key: 'aliases', id: 'drg-ssh-alias-list' },
            addressOptions.map((alias) => h('option', { key: alias.alias, value: alias.alias }, alias.host || '')),
          ),
        ],
      ),
    ),
    addressOptions.length > 0
      ? box(
          'div',
          'drg-alias-row',
          box('span', 'drg-alias-label', t('wizard.aliases')),
          addressOptions.map((alias) =>
            h(
              'button',
              {
                key: alias.alias,
                type: 'button',
                className: 'drg-chip',
                title: [alias.user, alias.host, alias.port].filter(Boolean).join(' '),
                onClick: () => pickAlias(alias),
              },
              alias.alias,
            ),
          ),
          knownHosts && knownHosts.entries
            ? box('span', 'drg-alias-known', t('wizard.knownHosts', { count: knownHosts.entries }))
            : null,
        )
      : aliasesLoading
        ? box('p', 'drg-field-hint', t('wizard.aliasesLoading'))
        : box('p', 'drg-field-hint', t('wizard.aliasesEmpty')),
    box(
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
    ),
    row({
      key: 'authType',
      label: 'wizard.auth',
      hint: 'wizard.authHint',
      testId: 'wizard-auth',
      after: () => setAuthDirty(true),
      options: [
        ['key', 'wizard.authKey'],
        ['password', 'wizard.authPassword'],
      ],
    }),
    draft.authType === 'key'
      ? h(
          Field,
          {
            label: t('wizard.keyPath'),
            error: fieldErrors.keyPath ? t(dictionaryKey(fieldErrors.keyPath)) : undefined,
            errorId: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
          },
          box(
            'div',
            'drg-field-inline',
            h(TextInput, {
              value: draft.keyPath,
              placeholder: t('wizard.keyPathPlaceholder'),
              ariaLabel: t('wizard.keyPath'),
              testId: 'wizard-key-path',
              invalid: Boolean(fieldErrors.keyPath),
              describedBy: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
              onChange: (value) => {
                setAuthDirty(true)
                patchDraft({ keyPath: value })
              },
            }),
            h(
              Button,
              {
                variant: 'secondary',
                testId: 'wizard-key-path-pick',
                onClick: () => setKeyPicker(true),
              },
              t('wizard.keyPathPick'),
            ),
          ),
        )
      : null,
    draft.authType === 'password'
      ? [
          h(
            Field,
            {
              key: 'password',
              label: t('wizard.password'),
              // An edit that leaves auth alone does not need the password: the Host asks for it
              // when the connection actually starts (audit S2-2).
              hint:
                mode === 'edit' && !authDirty
                  ? t('wizard.passwordSavedHint')
                  : storageAvailable
                    ? t('wizard.passwordPlaceholder')
                    : t('passwordPromptNoStorage'),
              error: fieldErrors.password ? t(dictionaryKey(fieldErrors.password)) : undefined,
              errorId: fieldErrors.password ? 'wizard-password-error' : undefined,
            },
            h(TextInput, {
              type: 'password',
              value: password,
              placeholder: storageAvailable ? t('wizard.passwordPlaceholder') : t('passwordPromptNoStorage'),
              ariaLabel: t('wizard.password'),
              testId: 'wizard-password',
              invalid: Boolean(fieldErrors.password),
              describedBy: fieldErrors.password ? 'wizard-password-error' : undefined,
              onChange: (value) => {
                setAuthDirty(true)
                // Clear the field error like every other input: the password has no draft
                // field, so `patchDraft` was not called and the error stuck (review feedback).
                setFieldErrors((current) => {
                  if (current.password === undefined) return current
                  const next = { ...current }
                  delete next.password
                  return next
                })
                if (formError !== null) setFormError(null)
                setPassword(value)
              },
            }),
          ),
          // A password typed into this form is saved by default. The choice only matters
          // when the form will actually carry a password (add, or an auth change).
          mode === 'add' || authDirty
            ? storageAvailable
              ? h(
                  'div',
                  { key: 'remember', className: 'drg-remember' },
                  h(CheckRow, {
                    checked: remember,
                    label: t('wizard.passwordRemember'),
                    testId: 'wizard-password-remember',
                    onChange: setRemember,
                  }),
                  h('p', { className: 'drg-field-hint' }, t('wizard.passwordRememberHint')),
                )
              : h('p', { key: 'no-storage', className: 'drg-field-hint' }, t('passwordPromptNoStorage'))
            : null,
        ]
      : null,
    h(CheckRow, {
      checked: draft.autoReconnect !== false,
      label: t('wizard.autoReconnect'),
      testId: 'wizard-auto-reconnect',
      onChange: (checked) => patchDraft({ autoReconnect: checked }),
    }),
    h(
      'details',
      { className: 'drg-advanced', 'data-testid': 'wizard-advanced' },
      h('summary', null, t('wizard.advanced')),
      box(
        'div',
        'drg-advanced-body',
        box(
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
            ? row({
                key: 'idleMinutes',
                kind: 'number',
                label: 'wizard.idleMinutes',
                testId: 'wizard-idle-minutes',
              })
            : null,
          h(
            Field,
            { label: t('settings.hostKeyPolicy') },
            h(Select, {
              value: draft.hostKeyPolicy,
              ariaLabel: t('settings.hostKeyPolicy'),
              testId: 'wizard-host-key-policy',
              options: [
                { value: 'first-use', label: t('settings.hostKeyPolicyFirstUse') },
                { value: 'strict', label: t('settings.hostKeyPolicyStrict') },
              ],
              onChange: (value) => patchDraft({ hostKeyPolicy: value }),
            }),
          ),
        ),
      ),
    ),
    box('p', 'drg-field-hint', t('wizard.actionHint')),
    !isLoopbackAddress(draft.address) ? box('p', 'drg-field-hint', t('loopbackNote')) : null,
  )

  return h(
    React.Fragment,
    null,
    h(
      Modal,
      {
        title: mode === 'edit' ? t('editHostTitle') : t('addHostTitle'),
        onClose: handleCancel,
        closeLabel: t('close'),
        wide: true,
        testId: 'host-wizard',
        busy: saving !== null,
        dismissible: saving === null,
        footer,
      },
      h('div', { className: 'drg-wizard-body', 'data-testid': 'wizard-form' }, body),
    ),
    keyPicker
      ? h(KeyFilePicker, {
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
      : null,
  )
}
