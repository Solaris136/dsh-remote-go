/**
 * Merge the planned credentials into the remote `~/.dsh/.credentials.yaml`: references are local-wins, records are add-only so a grant the remote already holds is never replaced; unknown top-level keys survive.
 */
import { dump, load } from '../vendor/yaml.bundle.mjs'
import { isPlainObject } from './util.js'

const REF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * @returns {{ text: string, counts: { addedRefs: number, updatedRefs: number, keptRefs: number, addedRecords: number, keptRecords: number } }}
 */
export function mergeCredentialsText(remoteText, credentials, options = {}) {
  const counts = { addedRefs: 0, updatedRefs: 0, keptRefs: 0, addedRecords: 0, keptRecords: 0 }
  let document = { version: 1 }
  if (typeof remoteText === 'string' && remoteText.trim() !== '') {
    const parsed = load(remoteText)
    if (!isPlainObject(parsed)) throw new Error('the remote credential document is not a mapping')
    document = { ...parsed }
  }
  if (!isPlainObject(document.refs)) document.refs = {}
  if (!isPlainObject(document.records)) document.records = {}
  if (document.version === undefined || document.version === null) document.version = 1

  for (const entry of Array.isArray(credentials?.refs) ? credentials.refs : []) {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    const value = typeof entry?.value === 'string' ? entry.value : ''
    if (!REF_NAME_RE.test(name) || value === '') continue
    const existing = document.refs[name]
    if (existing === value) counts.keptRefs += 1
    else if (typeof existing === 'string' && existing !== '') {
      document.refs[name] = value
      counts.updatedRefs += 1
    } else {
      document.refs[name] = value
      counts.addedRefs += 1
    }
  }

  for (const entry of Array.isArray(credentials?.records) ? credentials.records : []) {
    const key = typeof entry?.key === 'string' ? entry.key : ''
    if (key === '') continue
    if (Object.prototype.hasOwnProperty.call(document.records, key)) {
      counts.keptRecords += 1
      continue
    }
    document.records[key] = { kind: entry.kind, payload: entry.payload }
    counts.addedRecords += 1
  }

  const at = typeof options.at === 'string' && options.at !== '' ? options.at : new Date().toISOString()
  const header = `# dsh-remote-go sync: refs and records merged at ${at}.\n`
  return { text: header + dump(document, { lineWidth: 0, noRefs: true }), counts }
}
