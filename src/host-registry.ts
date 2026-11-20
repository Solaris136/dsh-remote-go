/** The host registry: configured hosts, their runtime objects and the client-facing snapshot; reads are pure, writes
 * re-emit the snapshot after `store`. */
import { homedir } from 'node:os'
import path from 'node:path'
import { errors } from './errors.js'
import { createHostRuntime, type HostRuntime } from './host-runtime.js'
import { hostView, type HostView, type HostViewOptions } from './host-view.js'
import { listKeyFiles as listKeyFilesInHome, OUTSIDE_HOME, type KeyFilesListing } from './key-files.js'
import { parseKnownHosts, summarizeKnownHosts, type KnownHostsSummary } from './known-hosts.js'
import { stopRemoteHeartbeat } from './host-lifecycle.js'
import { dispatch, scopeFactsFor } from './runtime/dispatch.js'
import { createRuntimeEffects } from './runtime/effects.js'
import { discoverSshAliases as discoverAliasesFromConfig, parseSshConfig } from './ssh-config.js'
import type { DiscoveredAlias } from './ssh-config.js'
import { startRemoteHeartbeat } from './watchdog.js'
import type { HostEntry, Settings } from './settings.js'
import type { Config, ConnectCtx, HostState, Reporter, Store, Transport } from './context.js'
export type RawHostEntry = Record<string, unknown> | null | undefined
export interface StateSnapshot {
  hostVersion: string | null
  targetVersion: string | null
  hosts: HostView[]
  settings: Settings
  activeHostId: string | null
  firstRun: boolean
  passwordStorageAvailable: boolean
  storeCorrupt: boolean
}
export interface SshDiscovery {
  aliases: DiscoveredAlias[]
  knownHosts: KnownHostsSummary
}
export interface KeyFileListing extends KeyFilesListing {
  defaultKeyPath: string
  defaultDir: string
}

function ensureRuntime(ctx: HostState, host: HostEntry): HostRuntime {
  const existing = ctx.state.runtimes.get(host.id)

  if (existing) {
    existing.entry = host
    return existing
  }
  // The store issues the id and the map is keyed by it; an entry without one can only come from a
  // caller that never saved it, never from `listHosts`.
  const runtime = createHostRuntime(host as HostEntry & { id: string })
  ctx.state.runtimes.set(host.id, runtime)
  return runtime
}

export function runtimeOf(ctx: HostState, id: string): HostRuntime {
  const runtime = ctx.state.runtimes.get(id)

  if (!runtime) throw errors.invalidInput('id', { zh: `未知主机 ${id}`, en: `Unknown host ${id}` })
  return runtime
}

export async function initRegistry(ctx: HostState & Store): Promise<void> {
  if (ctx.state.initialized) return
  await ctx.store.load()

  for (const host of ctx.store.listHosts()) ensureRuntime(ctx, host)
  // `passwordSaved` is a fact about the credential store, not this process: without this read the
  // Client would ask again after every DSH restart even though the password is saved.
  if (ctx.secrets) {
    await Promise.all(
      [...ctx.state.runtimes.values()].map(async (runtime) => {
        if (runtime.entry.auth?.type !== 'password') {
          runtime.passwordSaved = false
          return
        }
        runtime.passwordSaved = await ctx.secrets.has(runtime.id)
      }),
    )
  }
  ctx.state.initialized = true
}

function hostViewFor(ctx: Config & Store, runtime: HostRuntime, options: HostViewOptions = {}): HostView {
  return hostView(
    runtime,
    {
      targetVersion: ctx.localVersion(),
      passwordStorageAvailable: ctx.secrets ? ctx.secrets.available() === true : false,
      storeCorrupt: ctx.store?.hostsCorrupt === true,
    },
    options,
  )
}

export function snapshot(ctx: HostState & Config & Store, options: HostViewOptions = {}): StateSnapshot {
  const localVersion = ctx.localVersion()
  const hosts = [...ctx.state.runtimes.values()].map((runtime) => hostViewFor(ctx, runtime, options))
  return {
    hostVersion: localVersion,
    targetVersion: localVersion,
    hosts,
    settings: ctx.store.getSettings(),
    activeHostId: ctx.state.activeHostId,
    firstRun: hosts.length === 0,
    passwordStorageAvailable: ctx.secrets ? ctx.secrets.available() === true : false,
    storeCorrupt: ctx.store?.hostsCorrupt === true,
  }
}

export async function saveHost(ctx: HostState & Config & Store & Reporter, rawHost: RawHostEntry): Promise<HostView> {
  await ctx.init()
  const previousAuth =
    rawHost && typeof rawHost === 'object' && typeof rawHost.id === 'string'
      ? (ctx.store.getHost(rawHost.id)?.auth?.type ?? null)
      : null
  let entry: HostEntry | null
  try {
    entry = await ctx.store.upsertHost(rawHost, { settings: ctx.store.getSettings() })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'address is required') {
      throw errors.invalidInput('address', {
        zh: '请填写服务器地址或 ~/.ssh/config 别名。',
        en: 'Enter a server address or an ~/.ssh/config alias.',
      })
    }
    if (message === 'address is invalid') {
      throw errors.invalidInput('address', { zh: '服务器地址格式不正确。', en: 'The server address is not valid.' })
    }
    throw errors.invalidInput('host', { zh: `主机配置不合法：${message}`, en: `Invalid host entry: ${message}` })
  }
  const runtime = ensureRuntime(ctx, entry)

  if (previousAuth === 'password' && entry.auth?.type !== 'password') {
    await ctx.secrets?.remove(entry.id)
    runtime.passwordSaved = false
    runtime.password = null
  }
  ctx.emitState()
  return hostViewFor(ctx, runtime)
}
/** Delete one host. The teardown needs the watchdog's five slices and the deletion needs `Store`, so the gate registers
 * this function in `godCtxParams` rather than pretending it is narrow. */
export async function removeHost(ctx: ConnectCtx, id: string): Promise<{ ok: true }> {
  await ctx.init()
  const runtime = ctx.state.runtimes.get(id)

  if (runtime) {
    // A deleted host must not be resurrected by a timer, and a connect pipeline still in flight must
    // see that the user no longer wants it: it may never publish a connected state afterwards.
    if (ctx.state.activeHostId === id) ctx.state.activeHostId = null
    // `host.removed` owns the desired flag, the token bump, the timer disarms, the prompt settlement
    // and the teardown; the frame is published below with the host already gone.
    const event = { type: 'host.removed' as const, keepAlive: runtime.entry.keepAlive }
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'silent',
      emit: false,
    })
  }
  ctx.state.runtimes.delete(id)
  await ctx.store.removeHost(id)
  await ctx.secrets?.remove(id)

  if (ctx.state.activeHostId === id) ctx.state.activeHostId = null
  ctx.emitState()
  return { ok: true }
}

export function setActiveHost(ctx: HostState & Reporter, id: string | null): void {
  if (id !== null && !ctx.state.runtimes.has(id)) throw errors.invalidInput('id')
  ctx.state.activeHostId = id
  ctx.emitState()
}

export async function saveSettings(ctx: ConnectCtx, patch: unknown): Promise<Settings> {
  await ctx.init()
  const settings = await ctx.store.saveSettings(patch)
  for (const runtime of ctx.state.runtimes.values()) {
    if (runtime.status !== 'connected') continue
    if (settings.remoteHeartbeat.enabled) startRemoteHeartbeat(ctx, runtime)
    else stopRemoteHeartbeat(runtime)
  }
  ctx.emitState()
  return settings
}

export async function listKeyFiles(ctx: Store, dir: unknown): Promise<KeyFileListing> {
  // The picker is rooted at the OS user home, not DSH_HOME: private keys live in `~/.ssh` of the
  // account, while the service's `home` is the DSH state root.
  const userHome = homedir()
  let listing: KeyFilesListing
  try {
    listing = await listKeyFilesInHome({ home: userHome, dir: typeof dir === 'string' ? dir : '' })
  } catch (error) {
    // A path outside the home directory (or an unreadable one) is the caller's mistake: answer 400
    // instead of turning a bare `Error` into a 500, and never echo the path back in `technical`.
    if (error?.code === OUTSIDE_HOME || ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error?.code)) {
      throw errors.invalidInput('path', {
        zh: '这个目录不在用户主目录内，或无法读取。',
        en: 'This folder is outside the home directory, or cannot be read.',
      })
    }
    throw error
  }
  const settings = ctx.store.getSettings()
  return { ...listing, defaultKeyPath: settings.defaultKeyPath, defaultDir: path.join(userHome, '.ssh') }
}

export async function discoverSshAliases(ctx: Config & Transport): Promise<SshDiscovery> {
  const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const parsed = parseSshConfig(material.configText)
  const aliases = discoverAliasesFromConfig(parsed, { home: ctx.userHome() })
  const knownHosts = parseKnownHosts(material.knownHostsText)
  return {
    aliases: aliases.map(({ alias, host, user, port }) => ({ alias, host, user, port, source: 'config' })),
    knownHosts: summarizeKnownHosts(knownHosts),
  }
}
