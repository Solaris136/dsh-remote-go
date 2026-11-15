/**
 * Per-host SSH password storage in DSH's own credential store (`ctx.credentials`), never in `hosts.json`; with no credential service nothing is persisted.
 */

const RECORD_PREFIX = 'dsh-remote-go:ssh-password:'
const PAYLOAD_VERSION = 1

export function createSecretStore(options = {}) {
  const logger = options.logger ?? console

  function credentials() {
    try {
      const ctx = options.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      const service = ctx.get('credentials')
      if (!service || typeof service.modifyRecord !== 'function' || typeof service.readRecord !== 'function') {
        return null
      }
      return service
    } catch (error) {
      logger.warn?.('[dsh-remote-go] credential service lookup failed:', error)
      return null
    }
  }

  function keyFor(hostId) {
    return RECORD_PREFIX + String(hostId)
  }

  return {
    available() {
      return credentials() !== null
    },

    async get(hostId) {
      const service = credentials()
      if (!service || !hostId) return null
      try {
        const record = await service.readRecord(keyFor(hostId))
        const payload = record && record.kind === 'grant' ? record.payload : null
        if (!payload || typeof payload !== 'object') return null
        if (payload.version !== PAYLOAD_VERSION || typeof payload.password !== 'string') return null
        return payload.password === '' ? null : payload.password
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not read the saved password:', error)
        return null
      }
    },

    async has(hostId) {
      return (await this.get(hostId)) !== null
    },

    async set(hostId, password) {
      const service = credentials()
      if (!service || !hostId || typeof password !== 'string' || password === '') return false
      try {
        await service.modifyRecord(keyFor(hostId), async () => ({
          kind: 'grant',
          payload: { version: PAYLOAD_VERSION, password },
        }))
        return true
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not save the password:', error)
        return false
      }
    },

    async remove(hostId) {
      const service = credentials()
      if (!service || typeof service.deleteRecord !== 'function' || !hostId) return
      try {
        await service.deleteRecord(keyFor(hostId))
      } catch (error) {
        logger.warn?.('[dsh-remote-go] could not delete the saved password:', error)
      }
    },
  }
}
