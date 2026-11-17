// client/src/settings.ts - SettingsModal and the settings draft/patch/validation helpers (region 12); after diagnostics.ts, before prompts.ts.
//#region 12. settings modal

function settingsPatchFromDraft(draft) {
  const clamp = (value, limit, fallback) => {
    const number = toInt(value, fallback)
    return Math.min(limit.max, Math.max(limit.min, number))
  }
  return {
    defaultPort: clamp(draft.defaultPort, HOST_LIMITS.defaultPort, 22),
    defaultAuth: draft.defaultAuth === 'password' ? 'password' : 'key',
    defaultKeyPath: String(draft.defaultKeyPath || '').trim(),
    connectTimeoutSec: clamp(draft.connectTimeoutSec, HOST_LIMITS.connectTimeoutSec, 30),
    autoReconnect: {
      enabled: draft.autoReconnectEnabled === true,
      maxAttempts: clamp(draft.maxAttempts, HOST_LIMITS.maxAttempts, 3),
      baseDelayMs: clamp(draft.baseDelayMs, HOST_LIMITS.baseDelayMs, 1000),
    },
    hostKeyPolicy: draft.hostKeyPolicy === 'strict' ? 'strict' : 'first-use',
    saveTokens: draft.saveTokens === true,
    language: draft.language === 'zh' || draft.language === 'en' ? draft.language : 'auto',
    logLevel: ['error', 'warn', 'info', 'debug'].indexOf(draft.logLevel) >= 0 ? draft.logLevel : 'info',
    bootstrap: {
      profile: String(draft.profile || 'web').trim() || 'web',
    },
  }
}

function settingsDraft(settings) {
  const view = settings && typeof settings === 'object' ? settings : {}
  const auto = view.autoReconnect && typeof view.autoReconnect === 'object' ? view.autoReconnect : {}
  const bootstrap = view.bootstrap && typeof view.bootstrap === 'object' ? view.bootstrap : {}
  return {
    defaultPort: view.defaultPort === undefined ? 22 : view.defaultPort,
    defaultAuth: view.defaultAuth === 'password' ? 'password' : 'key',
    defaultKeyPath: view.defaultKeyPath || '~/.ssh/id_rsa',
    connectTimeoutSec: view.connectTimeoutSec === undefined ? 30 : view.connectTimeoutSec,
    autoReconnectEnabled: auto.enabled !== false,
    maxAttempts: auto.maxAttempts === undefined ? 3 : auto.maxAttempts,
    baseDelayMs: auto.baseDelayMs === undefined ? 1000 : auto.baseDelayMs,
    hostKeyPolicy: view.hostKeyPolicy || 'first-use',
    saveTokens: view.saveTokens === true,
    language: view.language || 'auto',
    logLevel: view.logLevel || 'info',
    profile: bootstrap.profile || 'web',
  }
}

/** Settings modal (contract SettingsView). */
function SettingsModal(props) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const [draft, setDraft] = useState(() => settingsDraft(props.settings))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // Key-file picker overlay for the default key path.
  const [keyPicker, setKeyPicker] = useState(false)
  const patch = (patchValue) => {
    setDraft((current) => ({ ...current, ...patchValue }))
    setFieldErrors((current) => {
      const next = { ...current }
      let changed = false
      for (const key of Object.keys(patchValue)) {
        if (next[key] !== undefined) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : current
    })
  }
  const set = (field) => (value) => patch({ [field]: value })

  const fieldRow = (spec) => {
    const row = formRow(t, draft, patch, { ...spec, error: fieldErrors[spec.key] })
    // The settings body is built from `.map(fieldRow)`: every element needs a stable key or
    // React reports a missing-key warning on every render.
    return React.cloneElement(row, { key: spec.key })
  }
  const focusField = (field) => {
    if (typeof document === 'undefined' || !document.querySelector) return
    const node = document.querySelector<HTMLElement>('[data-testid="settings-' + field + '"]')
    if (node && typeof node.focus === 'function') node.focus()
  }

  const handleSave = async () => {
    const invalid = validateSettingsDraft(draft)
    if (invalid !== null) {
      setFieldErrors({ [invalid.field]: invalid.code })
      setError(null)
      focusField(invalid.field)
      return
    }
    setFieldErrors({})
    setSaving(true)
    setError(null)
    try {
      if (typeof props.onSave === 'function') await props.onSave(settingsPatchFromDraft(draft))
      setSaving(false)
      if (typeof props.onClose === 'function') props.onClose()
    } catch (saveError) {
      setSaving(false)
      setError(toErrorView(saveError))
    }
  }

  const footer = footerRow(
    // Same dismissal contract as Escape / the backdrop / the header ×: a save in flight
    // cannot be cancelled by the footer button either.
    h(Button, { variant: 'ghost', testId: 'settings-cancel', disabled: saving, onClick: props.onClose }, t('cancel')),
    h(
      Button,
      { variant: 'primary', testId: 'settings-save', busy: saving, onClick: handleSave },
      t('settings.saveSettings'),
    ),
  )

  return h(
    React.Fragment,
    null,
    h(
      Modal,
      {
        title: t('settings.title'),
        onClose: props.onClose,
        closeLabel: t('close'),
        wide: true,
        testId: 'settings',
        busy: saving,
        dismissible: !saving,
        footer,
      },
      box(
        'div',
        'drg-settings',
        box(
          'section',
          'drg-settings-section',
          box('h3', 'drg-section-title', t('settings.ssh')),
          box(
            'div',
            'drg-form-grid drg-form-grid-3',
            [
              {
                kind: 'number',
                key: 'defaultPort',
                label: 'settings.defaultPort',
                hint: 'settings.defaultPortHint',
                testId: 'settings-defaultPort',
              },
              {
                kind: 'select',
                key: 'defaultAuth',
                label: 'settings.defaultAuth',
                options: [
                  ['key', 'settings.defaultAuthKey'],
                  ['password', 'settings.defaultAuthPassword'],
                ],
              },
              {
                kind: 'number',
                key: 'connectTimeoutSec',
                label: 'settings.connectTimeout',
                hint: 'settings.connectTimeoutHint',
                testId: 'settings-connectTimeoutSec',
              },
            ].map(fieldRow),
            h(
              Field,
              { label: t('settings.defaultKeyPath'), hint: t('settings.defaultKeyPathHint'), wide: true },
              box(
                'div',
                'drg-field-inline',
                h(TextInput, {
                  value: draft.defaultKeyPath,
                  placeholder: t('wizard.keyPathPlaceholder'),
                  ariaLabel: t('settings.defaultKeyPath'),
                  testId: 'settings-default-key-path',
                  onChange: set('defaultKeyPath'),
                }),
                h(
                  Button,
                  {
                    variant: 'secondary',
                    testId: 'settings-default-key-path-pick',
                    onClick: () => setKeyPicker(true),
                  },
                  t('settings.keyPathPick'),
                ),
              ),
            ),
          ),
        ),
        box(
          'section',
          'drg-settings-section',
          box('h3', 'drg-section-title', t('settings.security')),
          h(
            Field,
            { label: t('settings.hostKeyPolicy') },
            h(Select, {
              value: draft.hostKeyPolicy,
              ariaLabel: t('settings.hostKeyPolicy'),
              options: [
                { value: 'first-use', label: t('settings.hostKeyPolicyFirstUse') },
                { value: 'strict', label: t('settings.hostKeyPolicyStrict') },
              ],
              onChange: set('hostKeyPolicy'),
            }),
          ),
          h(CheckRow, {
            checked: draft.saveTokens === true,
            label: t('settings.saveTokens'),
            onChange: set('saveTokens'),
          }),
          box('p', 'drg-field-hint', t('settings.saveTokensHint')),
          draft.saveTokens === true ? h(Notice, { tone: 'warn', title: t('settings.saveTokensRisk') }) : null,
          h('div', { className: 'drg-divider' }),
          box('h3', 'drg-section-title', t('settings.reconnect')),
          h(CheckRow, {
            checked: draft.autoReconnectEnabled === true,
            label: t('settings.reconnectEnabled'),
            onChange: set('autoReconnectEnabled'),
          }),
          box(
            'div',
            'drg-form-grid',
            [
              { kind: 'number', key: 'maxAttempts', label: 'settings.maxAttempts', testId: 'settings-maxAttempts' },
              { kind: 'number', key: 'baseDelayMs', label: 'settings.baseDelay', testId: 'settings-baseDelayMs' },
            ].map(fieldRow),
          ),
        ),
        box(
          'section',
          'drg-settings-section',
          box('h3', 'drg-section-title', t('settings.bootstrap')),
          box('p', 'drg-field-hint', t('settings.bootstrapHint')),
          box(
            'div',
            'drg-form-grid',
            [
              {
                kind: 'text',
                key: 'profile',
                label: 'settings.profile',
                hint: 'settings.profileHint',
                testId: 'settings-profile',
              },
            ].map(fieldRow),
          ),
        ),
        box(
          'section',
          'drg-settings-section',
          box('h3', 'drg-section-title', t('settings.other')),
          box(
            'div',
            'drg-form-grid drg-form-grid-3',
            [
              {
                kind: 'select',
                key: 'language',
                label: 'settings.language',
                options: [
                  ['auto', 'settings.languageAuto'],
                  ['zh', 'settings.languageZh'],
                  ['en', 'settings.languageEn'],
                ],
              },
              {
                kind: 'select',
                key: 'logLevel',
                label: 'settings.logLevel',
                options: ['error', 'warn', 'info', 'debug'].map((level) => [level, level]),
              },
            ].map(fieldRow),
          ),
        ),
        error ? h(Notice, { tone: 'error' }, resolveText(error.detail, locale)) : null,
      ),
    ),
    keyPicker
      ? h(KeyFilePicker, {
          t,
          locale,
          initialDir: '',
          onPick: (pickedPath) => {
            setKeyPicker(false)
            patch({ defaultKeyPath: pickedPath })
          },
          onClose: () => setKeyPicker(false),
        })
      : null,
  )
}
