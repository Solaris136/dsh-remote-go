/**
 * Per-host SSH password storage in DSH's own credential store (`ctx.credentials`), never in `hosts.json`; with no credential service nothing is persisted.
 */

import { HOST_ID_RE } from './settings.js'
import { isPlainObject } from './util.js'
import type { Logger } from './util.js'

/** One stored password payload; `version` guards a shape change of this record. */
export interface PasswordPayload {
  version: number
  password: string
}

/** The record DSH's credential service stores for one key. */
export interface CredentialRecord {
  kind: string
  payload: PasswordPayload
}

/** The slice of DSH's credential service this store needs (`@deepseek-ai/dsh-credentials`). */
export interface CredentialService {
  readRecord(key: string): Promise<{ kind?: string; payload?: unknown } | null>
  modifyRecord(key: string, update: () => Promise<CredentialRecord>): Promise<unknown>
  deleteRecord(key: string): Promise<unknown>
}

/** The DSH context surface the store resolves its service through. */
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

/**
 * DSH addresses a stored record as `<scope>/<id>`, and both segments must match
 * `/^[a-z][a-z0-9-]*$/` (`parseCredentialKey` in `@deepseek-ai/dsh-credentials`). A colon-separated
 * key such as `dsh-remote-go:ssh-password:h_1` is stored as given but rejected the next time the
 * credential document is read — the whole file then fails to load, taking every other credential
 * with it. A host id is `h_<base36>`: its only character outside the grammar is the underscore,
 * which maps onto `-` without collisions because the issued suffix never contains one. Only an id
 * this plugin issued is addressable, so an unexpected value never reaches the document.
 */
export function passwordRecordKey(hostId: unknown): string | null {
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) return null
  const id = RECORD_ID_PREFIX + hostId.replace(/_/g, '-')
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null
  return `${RECORD_SCOPE}/${id}`
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const logger = options.logger ?? console

  function credentials(): Partial<CredentialService> | null {
    try {
      const ctx = options.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      const service = ctx.get('credentials') as Partial<CredentialService> | null
      if (!service || typeof service.modifyRecord !== 'function' || typeof service.readRecord !== 'function') {
        return null
      }
      return service
    } catch (error) {
      logger.warn?.('[dsh-remote-go] credential service lookup failed:', error)
      return null
    }
  }

  /**
   * The address of one host's password, or null when the id is not addressable.
   */
  function keyFor(hostId: unknown): string | null {
    return passwordRecordKey(hostId)
  }

  return {
    available() {
      return credentials() !== null
    },

    async get(hostId: string): Promise<string | null> {
      const service = credentials()
      const key = keyFor(hostId)
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
      const key = keyFor(hostId)
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
      const key = keyFor(hostId)
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
