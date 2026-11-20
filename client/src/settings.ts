// client/src/settings.ts - SettingsModal and the settings draft/patch/validation helpers (region 12); after diagnostics.ts, before prompts.ts.
//#region 12. settings modal
/** The settings draft: the flat form fields the modal edits, before they become a patch. */
interface SettingsDraft extends Record<string, unknown> {
  defaultPort?: number
  defaultAuth?: string
  defaultKeyPath?: string
  connectTimeoutSec?: number
  autoReconnectEnabled?: boolean
  maxAttempts?: number
  baseDelayMs?: number
  hostKeyPolicy?: string
  saveTokens?: boolean
  language?: 'auto' | 'zh' | 'en'
  logLevel?: 'error' | 'warn' | 'info' | 'debug'
  profile?: string
}

/** The select fields' option keys by draft key (`formRow` translates them). */
const OPTIONS: Record<string, string[][]> = {
  defaultAuth: [
    ['key', 'settings.defaultAuthKey'],
    ['password', 'settings.defaultAuthPassword'],
  ],
  hostKeyPolicy: [
    ['first-use', 'settings.hostKeyPolicyFirstUse'],
    ['strict', 'settings.hostKeyPolicyStrict'],
  ],
  language: [
    ['auto', 'settings.languageAuto'],
    ['zh', 'settings.languageZh'],
    ['en', 'settings.languageEn'],
  ],
  logLevel: ['error', 'warn', 'info', 'debug'].map((level) => [level, level]),
}
/** One row per entry, in render order: `[kind, draft key, label key, hint key?, test id?]`. */
const SSH_ROWS: string[][] = [
  ['number', 'defaultPort', 'settings.defaultPort', 'settings.defaultPortHint', 'settings-defaultPort'],
  ['select', 'defaultAuth', 'settings.defaultAuth'],
  [
    'number',
    'connectTimeoutSec',
    'settings.connectTimeout',
    'settings.connectTimeoutHint',
    'settings-connectTimeoutSec',
  ],
]
const RECONNECT_ROWS: string[][] = [
  ['number', 'maxAttempts', 'settings.maxAttempts', undefined, 'settings-maxAttempts'],
  ['number', 'baseDelayMs', 'settings.baseDelay', undefined, 'settings-baseDelayMs'],
]
const BOOTSTRAP_ROWS: string[][] = [['text', 'profile', 'settings.profile', 'settings.profileHint', 'settings-profile']]
const OTHER_ROWS: string[][] = [
  ['select', 'language', 'settings.language'],
  ['select', 'logLevel', 'settings.logLevel'],
]

function settingsPatchFromDraft(draft: SettingsDraft): SettingsPatch {
  const clamp = (value: unknown, limit: HostRange, fallback: number) => {
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
    bootstrap: { profile: String(draft.profile || 'web').trim() || 'web' },
  }
}

function settingsDraft(settings: SettingsView | null | undefined): SettingsDraft {
  const view: Partial<SettingsView> = settings && typeof settings === 'object' ? settings : {}
  const auto: Partial<SettingsView['autoReconnect']> =
    view.autoReconnect && typeof view.autoReconnect === 'object' ? view.autoReconnect : {}
  const bootstrap: Partial<SettingsView['bootstrap']> =
    view.bootstrap && typeof view.bootstrap === 'object' ? view.bootstrap : {}
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
interface SettingsModalProps extends LocaleProps {
  settings?: SettingsView | null
  onClose?: () => void
  onSave?: (patch: SettingsPatch) => void | Promise<void>
}

function SettingsModal(props: SettingsModalProps) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(props.settings))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // Key-file picker overlay for the default key path.
  const [keyPicker, setKeyPicker] = useState(false)
  const patch = (values: Record<string, unknown>) => {
    setDraft((current) => ({ ...current, ...values }))
    // Correcting a field clears its own error instead of leaving a stale message until the next save.
    setFieldErrors((current) => {
      const touched = Object.keys(values).filter((key) => current[key] !== undefined)
      if (touched.length === 0) return current
      const next = { ...current }
      for (const key of touched) delete next[key]
      return next
    })
  }
  const set = (name: string) => (value: unknown) => patch({ [name]: value })
  const field = (spec: FormRowSpec) => formRow(t, draft, patch, { ...spec, error: fieldErrors[spec.key] })
  // The body is built from `.map`: every element needs a stable key or React warns on every render.
  const rows = (specs: string[][]) =>
    specs.map(([kind, key, label, hint, testId]) => field({ kind, key, label, hint, testId, options: OPTIONS[key] }))
  const check = (key: string, label: DictKey) =>
    h(CheckRow, { key, checked: draft[key] === true, label: t(label), onChange: set(key) })
  const focusField = (name: string) => {
    if (typeof document === 'undefined' || !document.querySelector) return
    const node = document.querySelector<HTMLElement>('[data-testid="settings-' + name + '"]')
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
  const pickKey = () => setKeyPicker(true)
  const saveLabel = t('settings.saveSettings')
  const pickLabel = t('settings.keyPathPick')
  // Spread the children: passing the variadic array as one child would make React demand a key per element.
  const section = (title: string, ...children: ReactNode[]) =>
    box('section', 'drg-settings-section', box('h3', 'drg-section-title', title), ...children)
  const footer = footerRow(
    // A save in flight cannot be cancelled by the footer button either.
    h(Button, { variant: 'ghost', testId: 'settings-cancel', disabled: saving, onClick: props.onClose }, t('cancel')),
    h(Button, { variant: 'primary', testId: 'settings-save', busy: saving, onClick: handleSave }, saveLabel),
  )
  const keyPathField = h(
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
      h(Button, { variant: 'secondary', testId: 'settings-default-key-path-pick', onClick: pickKey }, pickLabel),
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
        section(t('settings.ssh'), box('div', 'drg-form-grid drg-form-grid-3', rows(SSH_ROWS), keyPathField)),
        section(
          t('settings.security'),
          rows([['select', 'hostKeyPolicy', 'settings.hostKeyPolicy']]),
          check('saveTokens', 'settings.saveTokens'),
          box('p', 'drg-field-hint', t('settings.saveTokensHint')),
          draft.saveTokens === true ? h(Notice, { tone: 'warn', title: t('settings.saveTokensRisk') }) : null,
          h('div', { className: 'drg-divider' }),
          box('h3', 'drg-section-title', t('settings.reconnect')),
          check('autoReconnectEnabled', 'settings.reconnectEnabled'),
          box('div', 'drg-form-grid', rows(RECONNECT_ROWS)),
        ),
        section(
          t('settings.bootstrap'),
          box('p', 'drg-field-hint', t('settings.bootstrapHint')),
          box('div', 'drg-form-grid', rows(BOOTSTRAP_ROWS)),
        ),
        section(t('settings.other'), box('div', 'drg-form-grid drg-form-grid-3', rows(OTHER_ROWS))),
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
