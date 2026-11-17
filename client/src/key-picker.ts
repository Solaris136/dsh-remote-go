// client/src/key-picker.ts - KeyFilePicker, the remote key-file chooser (region 9c); after carrier-overlay.ts, before wizard-draft.ts.
//#region 9c. key-file picker

function KeyFilePicker(props) {
  const t = translatorOf(props)
  const locale = localeOf(props)
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback((dir) => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.listKeyFiles(dir).then(
      (payload) => {
        if (cancelled) return
        setListing(payload)
        setLoading(false)
      },
      (failure) => {
        if (cancelled) return
        setError(toErrorView(failure))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(props.initialDir || ''), [props.initialDir])

  const entries = listing && Array.isArray(listing.entries) ? listing.entries : []
  // Directories first, then files; both rows are one button with a kind.
  const sorted = [
    ...entries.filter((entry) => entry && entry.isDirectory),
    ...entries.filter((entry) => entry && !entry.isDirectory),
  ]

  let body
  if (loading) {
    body = box('p', 'drg-field-hint', t('keyFile.loading'))
  } else if (error) {
    body = h(ErrorCard, {
      t,
      locale,
      error,
      onRetry: () => load(listing ? listing.path : props.initialDir || ''),
    })
  } else if (entries.length === 0) {
    body = box('p', 'drg-field-hint', t('keyFile.empty'))
  } else {
    body = h(
      'div',
      { className: 'drg-keyfile-list', 'data-testid': 'keyfile-list' },
      sorted.map((entry) =>
        h(
          'button',
          {
            key: entry.path,
            type: 'button',
            className: 'drg-keyfile-row',
            'data-kind': entry.isDirectory ? 'directory' : 'file',
            title: entry.isDirectory ? undefined : entry.path,
            onClick: () => (entry.isDirectory ? load(entry.path) : props.onPick(entry.path)),
          },
          box('span', 'drg-keyfile-name', entry.isDirectory ? entry.name + '/' : entry.name),
        ),
      ),
    )
  }

  return h(
    Modal,
    {
      title: t('keyFile.title'),
      onClose: props.onClose,
      closeLabel: t('cancel'),
      testId: 'keyfile-picker',
      footer: h(
        Button,
        {
          variant: 'ghost',
          onClick: () => (listing && listing.parent ? load(listing.parent) : undefined),
          disabled: !listing || !listing.parent,
          testId: 'keyfile-parent',
        },
        t('keyFile.parent'),
      ),
    },
    box('p', 'drg-field-hint', t('keyFile.hint')),
    listing ? box('p', 'drg-keyfile-path', listing.path) : null,
    body,
  )
}
