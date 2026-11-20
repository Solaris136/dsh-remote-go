// client/src/i18n.ts - locale/text helpers: interpolate, makeFallbackT, localeOf, translatorOf, resolveText, resolveTextList; after i18n-dict.ts, before util.ts.
//#region 3. i18n helpers
/** The props a surface mounts with: only the fields the language lookup reads are declared here. */
interface LocaleProps {
  t?: Translate
  getLocaleId?: () => unknown
  localeId?: string
  locale?: string
}

/** Keys already reported: a missing entry is a packaging defect, not a per-render event, so only the first warns. */
const REPORTED_MISSING_KEYS = new Set<string>()
/** Report one missing dictionary entry, once per key: warn, never throw. */
function reportMissingKey(key: string, message: string): void {
  if (REPORTED_MISSING_KEYS.has(key)) return
  REPORTED_MISSING_KEYS.add(key)
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[dsh-remote-go] ' + message)
  }
}

function interpolate(template: string, params?: DictParams): string {
  if (params === undefined || params === null) return String(template)
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null ? match : String(params[key]),
  )
}

/** A key only known at runtime (a `phase.<id>`, an ErrorView code): the one documented string-to-key boundary. */
// An unknown key still fails soft: it renders as itself and `makeFallbackT` warns once.
function dictionaryKey(key: string): DictKey {
  return key as DictKey
}

/** The `t()` a surface renders with: requested language, then the other, then the key, failing soft, never throwing. */
// The default `dictionaries` is the shipped pair; tests pass a partial pack to prove both fallbacks.
function makeFallbackT(locale: DictLocale, dictionaries: PartialDictionaries = STRINGS_BY_LOCALE): Translate {
  const primary = dictionaries[locale] ?? {}
  const fallbackLocale: DictLocale = locale === 'en' ? 'zh' : 'en'
  const fallback = dictionaries[fallbackLocale] ?? {}
  return (key, params) => {
    const text = primary[key]
    if (text !== undefined) return interpolate(text, params)
    const backup = fallback[key]
    if (backup !== undefined) {
      reportMissingKey(
        'missing:' + locale + ':' + key,
        'the ' + locale + ' dictionary has no "' + key + '"; showing ' + fallbackLocale,
      )
      return interpolate(backup, params)
    }
    reportMissingKey('absent:' + key, 'no dictionary entry for "' + key + '"; showing the key')
    // Interpolated like any other text, so a runtime-built key with `{name}` renders as it did before the dictionary.
    return interpolate(key, params)
  }
}

function localeOf(props?: LocaleProps | null): DictLocale {
  if (props && typeof props.getLocaleId === 'function') {
    try {
      const id = props.getLocaleId()
      if (id === 'en' || id === 'zh') return id
    } catch (_error) {
      // swallow-ok: a throwing getLocaleId falls through to the static locale prop
    }
  }
  if (props && (props.localeId === 'en' || props.localeId === 'zh')) return props.localeId
  // The overlay and wizard pass `locale` down; without this a window opened from them resolved host text wrongly.
  if (props && (props.locale === 'en' || props.locale === 'zh')) return props.locale
  return 'zh'
}

function translatorOf(props?: LocaleProps | null): Translate {
  if (props && typeof props.t === 'function') return props.t
  return makeFallbackT(localeOf(props))
}

/** A parsed payload's bilingual pair; both halves are optional because the payload is `unknown`. */
function isLocalizedPair(value: unknown): value is { zh?: unknown; en?: unknown } {
  return typeof value === 'object' && value !== null
}

function resolveText(text: unknown, locale: DictLocale): string {
  if (text === undefined || text === null) return ''
  if (typeof text === 'string') return text
  if (!isLocalizedPair(text)) return String(text)
  const primary = locale === 'en' ? text.en : text.zh
  if (typeof primary === 'string') return primary
  if (typeof text.zh === 'string') return text.zh
  if (typeof text.en === 'string') return text.en
  return ''
}

function resolveTextList(list: unknown, locale: DictLocale): string[] {
  if (!Array.isArray(list)) return []
  return list.map((item) => resolveText(item, locale)).filter((item) => item.length > 0)
}
