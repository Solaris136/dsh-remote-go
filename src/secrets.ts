/** Per-host SSH password storage in DSH's own credential store (`ctx.credentials`), never in `hosts.json`; with no
 * credential service nothing is persisted. The record API and the `<scope>/<id>` grammar live in `kernel-adapter.ts`.
 * A moved grammar (`changed`) does not change the keys this plugin generates — the stored form is the one already on
 * users' machines — but it is reported once, because a later refused save must not look like a silent no-op. A service
 * whose members changed shape gets the same warning: the store answers "not stored" as without a service, and silence
 * would look like amnesia. */
import { credentialRecordKey, createKernelAdapter } from './kernel-adapter.js'
import type { CredentialRecordApi } from './kernel-adapter.js'
import { HOST_ID_RE } from './settings.js'
import { isPlainObject } from './util.js'
import type { Logger } from './util.js'

/** The stored password payload; `version` guards a change of the record body. */
export interface PasswordPayload {
  version: number
  password: string
}

/** The DSH context surface the store resolves its service through (only `get` is read). */
export interface CredentialContext {
  get(name: string): unknown
}

export interface SecretStoreOptions {
  logger?: Logger
  ctx?: CredentialContext
}

/** The password store the connect pipeline talks to. */
export interface SecretStore {
  available(): boolean
  get(hostId: string): Promise<string | null>
  has(hostId: string): Promise<boolean>
  set(hostId: string, password: string): Promise<boolean>
  remove(hostId: string): Promise<boolean>
}

const RECORD_SCOPE = 'dsh-remote-go'
const RECORD_ID_PREFIX = 'ssh-password-'
const PAYLOAD_VERSION = 1

/** DSH addresses a record as `<scope>/<id>` and both segments must match `/^[a-z][a-z0-9-]*$/` (`parseCredentialKey` in
 * `@deepseek-ai/dsh-credentials`): a colon-separated key would be stored as given and rejected on the next read,
 * failing every other credential with it. A host id is `h_<base36>`, whose only out-of-grammar character is the
 * underscore; it maps onto `-` without collisions (the suffix never contains one), so only our ids are addressable. */
export function passwordRecordKey(hostId: unknown): string | null {
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) return null
  return credentialRecordKey(RECORD_SCOPE, RECORD_ID_PREFIX + hostId.replace(/_/g, '-'))
}

/** Build the store for one plugin activation; every method answers "not stored"/"not saved" instead of throwing. */
export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const logger = options.logger ?? console
  const kernel = createKernelAdapter(options.ctx)
  let grammarChecked = false
  let serviceChangedNoted = false

  // Report a moved key grammar once per store. The keys keep their stored form on purpose: a changed
  // grammar is a kernel we do not recognize, not a reason to orphan every saved password.
  function noteGrammar(): void {
    if (grammarChecked) return
    grammarChecked = true
    const probe = kernel.credentialKeyGrammar()
    if (probe.state !== 'changed') return
    logger.warn?.(
      '[dsh-remote-go] the kernel credential key grammar changed; keys keep their stored form and saves may stop working:',
      probe.detail,
    )
  }

  /** The record API, or `null` when this composition has no credential service. */
  function credentials(): CredentialRecordApi | null {
    const probe = kernel.credentialService()
    if (probe.state === 'ok' && probe.value !== null) {
      noteGrammar()
      return probe.value
    }
    // A present service whose members changed shape is not "no credential service": answering null
    // silently would present every remembered password as forgotten. Report it once per store.
    if (probe.state === 'changed') {
      if (!serviceChangedNoted) {
        serviceChangedNoted = true
        logger.warn?.(
          '[dsh-remote-go] the kernel credential service changed shape; saved passwords cannot be read or written:',
          probe.detail,
        )
      }
      return null
    }
    if (probe.reason === 'lookup-failed') {
      logger.warn?.('[dsh-remote-go] credential service lookup failed:', probe.detail)
    }
    return null
  }

  return {
    available() {
      return credentials() !== null
    },

    async get(hostId: string): Promise<string | null> {
      const service = credentials()
      const key = passwordRecordKey(hostId)
      if (!service || key === null) return null
      try {
        const record = await service.readRecord(key)
        const payload = record && record.kind === 'grant' ? record.payload : null
        // A stored payload is untrusted JSON from the credential document: narrow it, never cast it.
        if (!isPlainObject(payload)) return null
        if (payload.version !== PAYLOAD_VERSION || typeof payload.password !== 'string') return null
        return payload.password === '' ? null : payload.password
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not read the saved password:', error)
        return null
      }
    },

    async has(hostId: string): Promise<boolean> {
      return (await this.get(hostId)) !== null
    },

    async set(hostId: string, password: string): Promise<boolean> {
      const service = credentials()
      const key = passwordRecordKey(hostId)
      if (!service || key === null || typeof password !== 'string' || password === '') return false
      try {
        await service.modifyRecord(key, async () => ({
          kind: 'grant',
          payload: { version: PAYLOAD_VERSION, password },
        }))
        return true
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not save the password:', error)
        return false
      }
    },

    async remove(hostId: string): Promise<boolean> {
      const service = credentials()
      const key = passwordRecordKey(hostId)
      if (!service || key === null || typeof service.deleteRecord !== 'function') return false
      try {
        await service.deleteRecord(key)
        return true
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not delete the saved password:', error)
        return false
      }
    },
  }
}
