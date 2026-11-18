/**
 * The kernel introspection adapter (review #7; design-contract §3): the one module that reads
 * DSH's own shapes — the loader fiber, the client-module registry, and the two optional services
 * this plugin borrows (`connection` for request admission, `credentials` for saved SSH passwords).
 *
 * Why an adapter instead of four local `try/catch` blocks: these are somebody else's internals, and
 * the plugin has to tell two very different failures apart. A kernel that never provided a service
 * must keep working exactly as it did (the local fence, the replicated key grammar, the
 * `package.json` version scan), while a kernel that still provides the service but moved a field
 * must never be mistaken for that older one. Hence three states, decided in one fixed order:
 *
 *   take the candidate → empty means `absent` → non-empty but the wrong shape means `changed`
 *                     → right shape but the call throws *also* means `changed`
 *
 * Callers may fall back on `absent`; they must degrade safely on `changed`. The security-relevant
 * one is the admission gate: a check that cannot decide answers `500` (invariant B9), never
 * "admitted". The same reading of `changed` is what keeps a moved credential grammar from being
 * read as "no credentials" (a silent fallback) or as "everything is fine".
 */
import { PLUGIN_ID } from './constants.js'
import { isPlainObject, messageOf } from './util.js'

/** The three answers a probe can give; they are not interchangeable (see the module comment). */
export type ProbeState = 'ok' | 'absent' | 'changed'

/**
 * Why a probe is not `ok`.
 *
 * `not-injected` and `lookup-failed` are both `absent` (a lookup that throws also says "I cannot
 * see this service"), but callers log them differently: a failed *lookup* is worth a warning, an
 * optional service this composition never had is not.
 */
export type ProbeReason = 'not-injected' | 'lookup-failed' | 'shape' | 'call-failed'

/** One probe's verdict. `value` is `null` exactly when the state is not `ok`. */
export interface ProbeResult<T> {
  state: ProbeState
  value: T | null
  /** One short, redaction-safe line for `/diagnostics/self` (never a username or a machine path). */
  detail: string
  reason?: ProbeReason
}

/** 1. `ctx.fiber.entry.options` — the loader's own metadata, read only to display it. */
export interface FiberEntry {
  id: string | null
  name: string | null
}

/** 2a. The loader's client-module graph, as the diagnostics row reads it. */
export interface ClientModuleGraph {
  /** The published revision tag, passed through as published (DSH has used both a string and a number). */
  rev: string | number | null
  /** The loader's release record, passed through: the graph itself is the authority for its shape. */
  release: Record<string, unknown> | null
  entries: number
}

/** 2b. The release identity alone — the one field the version probe consumes. */
export interface ClientModuleRelease {
  version: string | null
  release: Record<string, unknown> | null
}

/** 2c. One loader row: the bundle the browser half is served, and how it is injected. */
export interface ClientModuleRow {
  id: string
  rev: string | number | null
  url: string | null
  inject: string[]
  immediately: boolean
}

/** 3. The credential record API, narrowed to the members every operation needs. */
export interface CredentialRecordApi {
  readRecord(key: string): Promise<{ kind?: unknown; payload?: unknown } | null>
  modifyRecord(key: string, update: () => Promise<{ kind: unknown; payload: unknown }>): Promise<unknown>
  deleteRecord?: (key: string) => Promise<unknown>
}

/** 4. The key grammar: `parseCredentialKey`'s `"<scope>/<id>"`, both segments lowercase identifiers. */
export interface CredentialKeyGrammar {
  /** True only when the kernel's own parser was found *and* agreed with the replicated rule. */
  verified: boolean
  /** The replicated rule, rendered for the diagnostics line. */
  rule: string
}

/** One line of `/diagnostics/self`'s probe table: state and detail only (no values, no paths). */
export interface KernelProbeLine {
  state: ProbeState
  detail: string
}

/** Every probe this adapter owns, named the way `/diagnostics/self` reports them. */
export interface KernelProbeReport {
  fiberEntry: KernelProbeLine
  clientModuleGraph: KernelProbeLine
  clientModuleRelease: KernelProbeLine
  clientModuleRow: KernelProbeLine
  clientPath: KernelProbeLine
  requestRejection: KernelProbeLine
  credentialService: KernelProbeLine
  credentialKeyGrammar: KernelProbeLine
}

/**
 * The kernel surface, one method per internal shape this plugin touches. Every method answers a
 * `ProbeResult` and never throws: a diagnostic bundle that throws is worse than one that reports.
 */
export interface KernelAdapter {
  fiberEntry(): ProbeResult<FiberEntry>
  clientModuleGraph(): ProbeResult<ClientModuleGraph>
  clientModuleRelease(): ProbeResult<ClientModuleRelease>
  clientModuleRow(id: string): ProbeResult<ClientModuleRow>
  clientPath(id: string): ProbeResult<string>
  /** Whether the kernel's admission is callable at all; no request is judged (diagnostics only). */
  admissionCapability(): ProbeResult<true>
  /** Judge one request through the kernel's admission (`undefined` means "not rejected"). */
  requestRejection(req: unknown): ProbeResult<number | undefined>
  credentialService(): ProbeResult<CredentialRecordApi>
  credentialKeyGrammar(): ProbeResult<CredentialKeyGrammar>
  probeReport(): KernelProbeReport
}

/** The contract version of the probe table (design-contract §3.5); additive changes bump it. */
export const KERNEL_PROBE_VERSION = '2.12'

/** The `dsh-credentials` segment grammar (`KEY_SEGMENT_PATTERN` in that package). */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/** The replicated grammar as its diagnostics line; kept beside the regex so the two cannot drift. */
export const CREDENTIAL_KEY_RULE = String(KEY_SEGMENT)

/** A key the replicated grammar admits, used to prove a real parser agrees with it. */
const SAMPLE_KEY = 'dsh-remote-go/ssh-password-h-1'

/** Forms the replicated grammar rejects; a parser that accepts one of them is the `changed` signal. */
const REJECTED_KEYS = [
  'dsh-remote-go:ssh-password-h-1',
  'Dsh-remote-go/x',
  'dsh-remote-go/ssh-password-h-1/x',
  'dsh-remote-go/ssh_password_h_1',
]

/** A function value taken off an untyped service object (the member check already proved it callable). */
type KernelCallable = (...args: unknown[]) => unknown

function ok<T>(value: T, detail: string): ProbeResult<T> {
  return { state: 'ok', value, detail }
}

function absent<T>(detail: string, reason: ProbeReason = 'not-injected'): ProbeResult<T> {
  return { state: 'absent', value: null, detail, reason }
}

function changed<T>(detail: string, reason: ProbeReason = 'shape'): ProbeResult<T> {
  return { state: 'changed', value: null, detail, reason }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** Turn a probe that failed for its own service into the same failure for a narrower value. */
function propagate<T>(failed: ProbeResult<unknown>): ProbeResult<T> {
  return {
    state: failed.state === 'changed' ? 'changed' : 'absent',
    value: null,
    detail: failed.detail,
    reason: failed.reason,
  }
}

/**
 * Bind one untyped service member to its owner.
 *
 * The kernel's services are classes; a method detached from its instance loses `this`, so every
 * call goes through `Reflect.apply` on the resolved owner instead of an assertion on the member.
 * @param member - the member the shape check already proved callable.
 * @param owner - the service object it was read from.
 * @returns a callable that forwards every argument unchanged.
 */
function bindMember(member: Function, owner: unknown): KernelCallable {
  return (...args: unknown[]) => Reflect.apply(member, owner, args)
}

/**
 * Read one revision tag (a string or a number in DSH's own history) without guessing.
 * @returns the value, `null` when the field is absent, or `undefined` when it is the wrong type.
 */
function readRev(value: unknown): string | number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  return undefined
}

/**
 * `ctx.get(name)` without trusting either the context or the lookup.
 *
 * A context that is not an object, has no `get`, or throws is *absence*: the adapter could not see
 * the service, which is exactly what an older composition looks like. It is never `changed`,
 * because "I could not read it" says nothing about the shape behind it (design-contract §3.4, T-f).
 */
function lookupService(ctx: unknown, name: string): ProbeResult<unknown> {
  if (!isPlainObject(ctx)) return absent('the plugin context is not an object')
  const get = ctx.get
  if (typeof get !== 'function') return absent('the plugin context has no get()')
  try {
    const service: unknown = Reflect.apply(get, ctx, [name])
    // `!service` matches the pre-adapter gate: a falsy service was "no service" for every consumer.
    if (!service) return absent(`${name} is not injected`)
    return ok(service, `resolved ${name}`)
  } catch (error) {
    return absent(`${name} lookup failed: ${messageOf(error)}`, 'lookup-failed')
  }
}

/** The record-key builder: the replicated rule, the single implementation (`secrets.ts` imports it). */
export function credentialRecordKey(scope: string, id: string): string | null {
  if (typeof scope !== 'string' || typeof id !== 'string') return null
  if (!KEY_SEGMENT.test(scope) || !KEY_SEGMENT.test(id)) return null
  return `${scope}/${id}`
}

/** Summarize one probe for the diagnostics table, containing an unexpected throw as `changed`. */
function line(probe: () => ProbeResult<unknown>): KernelProbeLine {
  try {
    const result = probe()
    return { state: result.state, detail: result.detail }
  } catch (error) {
    // Diagnostics must never throw; a probe that did is reported, not propagated.
    return { state: 'changed', detail: `probe threw: ${messageOf(error)}` }
  }
}

/**
 * Build the adapter for one kernel context.
 *
 * `ctx` is `unknown` on purpose: it comes from the loader and every member below is narrowed by a
 * shape check before use, so a kernel that renames or drops a member is reported instead of
 * crashing the Host process at call time. Probes are cheap and stateless, so a caller may keep one
 * adapter or build one per call; `probeReport()` is the only method that runs all of them.
 * @param ctx - the plugin context the loader handed to `apply`.
 * @returns the adapter.
 */
export function createKernelAdapter(ctx: unknown): KernelAdapter {
  /** The `clientModules` service: `ctx.get` first, then the property `ctx.clientModules` (its fallback). */
  function clientModules(): ProbeResult<Record<string, unknown>> {
    const looked = lookupService(ctx, 'clientModules')
    // A throwing lookup is not retried through the property: the historical code read the property
    // only when `get` returned nothing, and a throw says the same "cannot see it" (T-f).
    if (looked.reason === 'lookup-failed') return propagate<Record<string, unknown>>(looked)
    if (looked.state === 'ok' && looked.value !== null) {
      return isPlainObject(looked.value)
        ? ok(looked.value, 'resolved clientModules')
        : changed(`clientModules is ${describeType(looked.value)}`)
    }
    const direct = isPlainObject(ctx) ? ctx.clientModules : undefined
    if (isPlainObject(direct)) return ok(direct, 'resolved clientModules from the context')
    if (direct !== undefined && direct !== null) return changed(`clientModules is ${describeType(direct)}`)
    return absent('clientModules is not injected')
  }

  /**
   * The published graph object, or why it could not be read.
   *
   * Validation stops at the object boundary on purpose: the release version, the revision tag and
   * the entry list are read by different consumers (the version probe needs only the release, the
   * diagnostics row needs the entries), so each probe narrows the fields *it* reads instead of
   * failing the others. A kernel that grows a field must not switch off a probe that never read it.
   */
  function readGraph(): ProbeResult<Record<string, unknown>> {
    const service = clientModules()
    if (service.state !== 'ok' || service.value === null) return propagate(service)
    const owner = service.value
    const graphMember = owner.graph
    if (graphMember === undefined) return absent('clientModules has no graph()')
    if (typeof graphMember !== 'function') return changed(`clientModules.graph is ${describeType(graphMember)}`)
    let raw: unknown
    try {
      raw = bindMember(graphMember, owner)()
    } catch (error) {
      return changed(`clientModules.graph() threw: ${messageOf(error)}`, 'call-failed')
    }
    if (raw === undefined || raw === null) return absent('clientModules.graph() returned nothing')
    if (!isPlainObject(raw)) return changed(`clientModules.graph() returned ${describeType(raw)}`)
    return ok(raw, 'read clientModules.graph()')
  }

  /** Resolve the admission member without judging a request (shared by the gate and diagnostics). */
  function resolveAdmission(): ProbeResult<KernelCallable> {
    const looked = lookupService(ctx, 'connection')
    if (looked.state !== 'ok' || looked.value === null) return propagate(looked)
    if (!isPlainObject(looked.value)) return changed(`connection is ${describeType(looked.value)}`)
    const owner = looked.value
    const member = owner.requestRejection
    if (member === undefined) return absent('connection has no requestRejection()')
    if (typeof member !== 'function') return changed(`connection.requestRejection is ${describeType(member)}`)
    return ok(bindMember(member, owner), 'connection admission is callable')
  }

  const adapter: KernelAdapter = {
    fiberEntry(): ProbeResult<FiberEntry> {
      if (!isPlainObject(ctx)) return absent('the plugin context is not an object')
      const fiber = ctx.fiber
      if (fiber === undefined || fiber === null) return absent('fiber is not exposed on the plugin context')
      if (!isPlainObject(fiber)) return changed(`fiber is ${describeType(fiber)}`)
      const entry = fiber.entry
      if (entry === undefined || entry === null) return absent('fiber.entry is not exposed')
      if (!isPlainObject(entry)) return changed(`fiber.entry is ${describeType(entry)}`)
      const options = entry.options
      if (!isPlainObject(options)) {
        return changed(`fiber.entry.options is ${options === undefined ? 'missing' : describeType(options)}`)
      }
      const id = options.id
      const name = options.name
      if (id !== undefined && id !== null && typeof id !== 'string') {
        return changed(`fiber.entry.options.id is ${describeType(id)}`)
      }
      if (name !== undefined && name !== null && typeof name !== 'string') {
        return changed(`fiber.entry.options.name is ${describeType(name)}`)
      }
      const value: FiberEntry = { id: typeof id === 'string' ? id : null, name: typeof name === 'string' ? name : null }
      return ok(value, `id=${value.id ?? '-'} name=${value.name ?? '-'}`)
    },

    clientModuleGraph(): ProbeResult<ClientModuleGraph> {
      const graph = readGraph()
      if (graph.state !== 'ok' || graph.value === null) return propagate(graph)
      const entries = graph.value.entries
      if (!Array.isArray(entries)) return changed(`clientModules.graph().entries is ${describeType(entries)}`)
      const rev = readRev(graph.value.rev)
      if (rev === undefined) return changed(`clientModules.graph().rev is ${describeType(graph.value.rev)}`)
      const release = graph.value.release
      if (release !== undefined && release !== null && !isPlainObject(release)) {
        return changed(`clientModules.graph().release is ${describeType(release)}`)
      }
      const releaseVersion = isPlainObject(release) && typeof release.version === 'string' ? release.version : '-'
      return ok(
        { rev, release: isPlainObject(release) ? release : null, entries: entries.length },
        `rev=${String(rev ?? '-')} entries=${entries.length} release=${releaseVersion}`,
      )
    },

    clientModuleRelease(): ProbeResult<ClientModuleRelease> {
      const graph = readGraph()
      if (graph.state !== 'ok' || graph.value === null) return propagate(graph)
      const release = graph.value.release
      if (release === undefined || release === null) return absent('the client-module graph has no release record')
      if (!isPlainObject(release)) return changed(`the client-module release is ${describeType(release)}`)
      const version = release.version
      if (version === undefined || version === null) return absent('the client-module release has no version')
      if (typeof version !== 'string' || version === '') {
        return changed(`the client-module release version is ${describeType(version)}`)
      }
      return ok({ version, release }, `release version ${version}`)
    },

    clientModuleRow(id: string): ProbeResult<ClientModuleRow> {
      const graph = readGraph()
      if (graph.state !== 'ok' || graph.value === null) return propagate(graph)
      const entries = graph.value.entries
      if (!Array.isArray(entries)) return changed(`clientModules.graph().entries is ${describeType(entries)}`)
      const row = entries.find((item) => isPlainObject(item) && item.id === id)
      if (!isPlainObject(row)) return absent(`the client-module graph lists no row for ${id}`)
      const rev = readRev(row.rev)
      if (rev === undefined) return changed(`the ${id} row has a ${describeType(row.rev)} rev`)
      const url = row.url
      if (url !== undefined && url !== null && typeof url !== 'string') {
        return changed(`the ${id} row has a ${describeType(url)} url`)
      }
      const inject = row.inject
      if (inject !== undefined && !Array.isArray(inject)) {
        return changed(`the ${id} row has a ${describeType(inject)} inject list`)
      }
      const injected = Array.isArray(inject) ? inject.filter((item): item is string => typeof item === 'string') : []
      if (Array.isArray(inject) && injected.length !== inject.length) {
        return changed(`the ${id} row injects a non-string entry`)
      }
      const immediately = row.immediately
      if (immediately !== undefined && immediately !== null && typeof immediately !== 'boolean') {
        return changed(`the ${id} row has a ${describeType(immediately)} immediately flag`)
      }
      const value: ClientModuleRow = {
        id,
        rev,
        url: typeof url === 'string' ? url : null,
        inject: injected,
        immediately: immediately === true,
      }
      return ok(value, `inject=${value.inject.length} immediately=${value.immediately}`)
    },

    clientPath(id: string): ProbeResult<string> {
      const service = clientModules()
      if (service.state !== 'ok' || service.value === null) return propagate(service)
      const owner = service.value
      const member = owner.clientPath
      if (member === undefined) return absent('clientModules has no clientPath()')
      if (typeof member !== 'function') return changed(`clientModules.clientPath is ${describeType(member)}`)
      let raw: unknown
      try {
        raw = bindMember(member, owner)(id)
      } catch (error) {
        return changed(`clientModules.clientPath() threw: ${messageOf(error)}`, 'call-failed')
      }
      if (raw === undefined || raw === null) return absent(`clientModules.clientPath() knows no bundle for ${id}`)
      if (typeof raw !== 'string' || raw === '')
        return changed(`clientModules.clientPath() returned ${describeType(raw)}`)
      // The path itself is never echoed: it carries the machine's plugin directory.
      return ok(raw, 'resolved')
    },

    admissionCapability(): ProbeResult<true> {
      const resolved = resolveAdmission()
      if (resolved.state !== 'ok') return propagate(resolved)
      return ok(true, 'connection admission is callable')
    },

    requestRejection(req: unknown): ProbeResult<number | undefined> {
      const resolved = resolveAdmission()
      if (resolved.state !== 'ok' || resolved.value === null) return propagate(resolved)
      let verdict: unknown
      try {
        verdict = resolved.value(req)
      } catch (error) {
        // A judgement that throws cannot decide: the gate turns this into 500, never "admitted".
        return changed(`connection.requestRejection threw: ${messageOf(error)}`, 'call-failed')
      }
      if (verdict === undefined || verdict === null) return ok(undefined, 'admitted')
      if (typeof verdict === 'number' && Number.isFinite(verdict)) return ok(verdict, `rejected with ${verdict}`)
      return changed(`connection.requestRejection returned ${describeType(verdict)}`)
    },

    credentialService(): ProbeResult<CredentialRecordApi> {
      const looked = lookupService(ctx, 'credentials')
      if (looked.state !== 'ok' || looked.value === null) return propagate(looked)
      if (!isPlainObject(looked.value)) return changed(`credentials is ${describeType(looked.value)}`)
      const owner = looked.value
      const readRecord = owner.readRecord
      const modifyRecord = owner.modifyRecord
      if (readRecord === undefined && modifyRecord === undefined) return absent('credentials exposes no record API')
      if (typeof readRecord !== 'function' || typeof modifyRecord !== 'function') {
        return changed(
          `credentials.readRecord/modifyRecord are ${describeType(readRecord)}/${describeType(modifyRecord)}`,
        )
      }
      const read = bindMember(readRecord, owner)
      const modify = bindMember(modifyRecord, owner)
      const api: CredentialRecordApi = {
        async readRecord(key: string) {
          // A record of an unexpected shape reads as "nothing stored"; the caller re-narrows the payload.
          const record: unknown = await read(key)
          return isPlainObject(record) ? { kind: record.kind, payload: record.payload } : null
        },
        async modifyRecord(key: string, update: () => Promise<{ kind: unknown; payload: unknown }>) {
          return await modify(key, update)
        },
      }
      const deletable = owner.deleteRecord
      if (typeof deletable === 'function') {
        const remove = bindMember(deletable, owner)
        api.deleteRecord = async (key: string) => await remove(key)
      }
      return ok(api, 'credentials exposes readRecord + modifyRecord')
    },

    credentialKeyGrammar(): ProbeResult<CredentialKeyGrammar> {
      const looked = lookupService(ctx, 'credentials')
      if (looked.state !== 'ok' || looked.value === null) return propagate(looked)
      if (!isPlainObject(looked.value)) return changed(`credentials is ${describeType(looked.value)}`)
      const parser = looked.value.parseCredentialKey
      if (parser === undefined) {
        return ok(
          { verified: false, rule: CREDENTIAL_KEY_RULE },
          'the kernel exposes no key parser; the replicated grammar is in use',
        )
      }
      if (typeof parser !== 'function') return changed(`credentials.parseCredentialKey is ${describeType(parser)}`)
      const parse = bindMember(parser, looked.value)
      try {
        parse(SAMPLE_KEY)
      } catch (error) {
        return changed(`credentials.parseCredentialKey rejected a valid key: ${messageOf(error)}`, 'call-failed')
      }
      for (const rejected of REJECTED_KEYS) {
        let refused = false
        try {
          parse(rejected)
        } catch {
          // swallow-ok: the refusal is the expected answer; the flag records that it happened
          refused = true
        }
        if (!refused) {
          return changed(`credentials.parseCredentialKey accepted "${rejected}", which the grammar rejects`)
        }
      }
      return ok({ verified: true, rule: CREDENTIAL_KEY_RULE }, 'parseCredentialKey agrees with the replicated grammar')
    },

    probeReport(): KernelProbeReport {
      return {
        fiberEntry: line(() => adapter.fiberEntry()),
        clientModuleGraph: line(() => adapter.clientModuleGraph()),
        clientModuleRelease: line(() => adapter.clientModuleRelease()),
        clientModuleRow: line(() => adapter.clientModuleRow(PLUGIN_ID)),
        clientPath: line(() => adapter.clientPath(PLUGIN_ID)),
        requestRejection: line(() => adapter.admissionCapability()),
        credentialService: line(() => adapter.credentialService()),
        credentialKeyGrammar: line(() => adapter.credentialKeyGrammar()),
      }
    },
  }
  return adapter
}
