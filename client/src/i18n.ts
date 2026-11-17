// client/src/i18n.ts - locale/text helpers: interpolate, makeFallbackT, localeOf, translatorOf, resolveText, resolveTextList; after i18n-dict.ts, before util.ts.
//#region 3. i18n helpers

function interpolate(template, params) {
  if (params === undefined || params === null) return String(template)
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null ? match : String(params[key]),
  )
}

function makeFallbackT(locale) {
  const dict = locale === 'en' ? en : zh
  return (key, params) => {
    const text = dict[key] !== undefined ? dict[key] : en[key] !== undefined ? en[key] : key
    return interpolate(text, params)
  }
}

function localeOf(props) {
  if (props && typeof props.getLocaleId === 'function') {
    try {
      const id = props.getLocaleId()
      if (id === 'en' || id === 'zh') return id
    } catch (_error) {
      // fall through to the default
    }
  }
  if (props && (props.localeId === 'en' || props.localeId === 'zh')) return props.localeId
  // The overlay and the wizard hand the resolved id down as `locale`; without this a
  // window opened from them resolved host-provided text as Chinese in an English UI.
  if (props && (props.locale === 'en' || props.locale === 'zh')) return props.locale
  return 'zh'
}

function translatorOf(props) {
  if (props && typeof props.t === 'function') return props.t
  return makeFallbackT(localeOf(props))
}

function resolveText(text, locale) {
  if (text === undefined || text === null) return ''
  if (typeof text === 'string') return text
  if (typeof text !== 'object') return String(text)
  const primary = locale === 'en' ? text.en : text.zh
  if (typeof primary === 'string') return primary
  if (typeof text.zh === 'string') return text.zh
  if (typeof text.en === 'string') return text.en
  return ''
}

function resolveTextList(list, locale) {
  if (!Array.isArray(list)) return []
  return list.map((item) => resolveText(item, locale)).filter((item) => item.length > 0)
}
