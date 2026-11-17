/**
 * The host registry: the configured hosts, their runtime objects and the client-facing snapshot; reads are pure, writes re-emit the snapshot after `store`.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { errors } from './errors.js'
import { createHostRuntime } from './host-runtime.js'
import type { HostRuntime } from './host-runtime.js'
import { hostView } from './host-view.js'
import type { HostView } from './host-view.js'
import { listKeyFiles as listKeyFilesInHome, OUTSIDE_HOME } from './key-files.js'
import type { KeyFilesListing } from './key-files.js'
import { parseKnownHosts, summarizeKnownHosts } from './known-hosts.js'
import type { KnownHostsSummary } from './known-hosts.js'
import { startRemoteHeartbeat, stopRemoteHeartbeat } from './host-lifecycle.js'
import { dispatch, scopeFactsFor } from './runtime/dispatch.js'
import { createRuntimeEffects } from './runtime/effects.js'
import { discoverSshAliases as discoverAliasesFromConfig, parseSshConfig } from './ssh-config.js'
import type { DiscoveredAlias } from './ssh-config.js'
import type { HostEntry, Settings } from './settings.js'
import type { Config, HostState, Reporter, Store, TeardownCtx, Transport, WatchdogCtx } from './context.js'

/** The raw, unsanitized host entry a Client posts; `store.upsertHost` owns validating it. */
export type RawHostEntry = Record<string, unknown> | null | undefined

/** The client-facing state snapshot `GET /state` and the SSE state frame carry (docs/api.md). */
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

/** One SSH alias the wizard may offer, plus the `known_hosts` summary beside it. */
export interface SshDiscovery {
  aliases: DiscoveredAlias[]
  knownHosts: KnownHostsSummary
}

/** The key-file listing the picker renders, plus the entries the form pre-fills. */
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
  // The store issues the id (`sanitizeHostEntry`) and the runtime map is keyed by it; an entry
  // without one can only come from a caller that never saved it, never from `listHosts`.
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
  // `passwordSaved` is a fact about the credential store, not about this process: without this
  // read the Client would ask again after every DSH restart even though the password is saved,
  // and the saved value would never be tried.
  await restoreSavedPasswords(ctx)
  ctx.state.initialized = true
}

/**
 * Re-read which password-auth hosts have a saved password. Only presence is loaded; the secret
 * itself stays in the credential store until a connection actually needs it.
 * @param ctx - service context.
 */
async function restoreSavedPasswords(ctx: HostState & Store): Promise<void> {
  if (!ctx.secrets) return
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

function hostViewFor(ctx: Config & Store, runtime: HostRuntime): HostView {
  return hostView(runtime, {
    targetVersion: ctx.localVersion(),
    passwordStorageAvailable: ctx.secrets ? ctx.secrets.available() === true : false,
    // A quarantined hosts.json means the list beside it is the empty recovery fallback.
    storeCorrupt: ctx.store?.hostsCorrupt === true,
  })
}

/** Build the client-facing state snapshot (contract: docs/api.md). */
export function snapshot(ctx: HostState & Config & Store): StateSnapshot {
  const localVersion = ctx.localVersion()
  const hosts = [...ctx.state.runtimes.values()].map((runtime) => hostViewFor(ctx, runtime))
  return {
    hostVersion: localVersion,
    targetVersion: localVersion,
    hosts,
    settings: ctx.store.getSettings(),
    activeHostId: ctx.state.activeHostId,
    firstRun: hosts.length === 0,
    /** Whether a password typed for any host can be persisted at all (the Client hides the choice). */
    passwordStorageAvailable: ctx.secrets ? ctx.secrets.available() === true : false,
    // Store-wide, and deliberately not per host: a quarantined hosts.json leaves this list
    // empty, which is exactly the case the user has to be told about.
    storeCorrupt: ctx.store?.hostsCorrupt === true,
  }
}

export async function saveHost(ctx: HostState & Config & Store & Reporter, rawHost: RawHostEntry): Promise<HostView> {
  await ctx.init()
  // The auth mode as it is stored now: a switch away from password must not leave its secret
  // behind as an orphaned credential record.
  const previousAuth =
    rawHost && typeof rawHost === 'object' && typeof rawHost.id === 'string'
      ? (ctx.store.getHost(rawHost.id)?.auth?.type ?? null)
      : null
  let entry: HostEntry | null
  try {
    entry = await ctx.store.upsertHost(rawHost, { settings: ctx.store.getSettings() })
  } catch (error) {
    // The store's validators throw bare messages; map them to the client's field
    // errors here so the contract stays typed.
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
    throw errors.invalidInput('host', {
      zh: `主机配置不合法：${message}`,
      en: `Invalid host entry: ${message}`,
    })
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

export async function removeHost(ctx: Store & TeardownCtx, id: string): Promise<{ ok: true }> {
  await ctx.init()
  const runtime = ctx.state.runtimes.get(id)
  if (runtime) {
    // A deleted host must not be resurrected by a timer scheduled before deletion, and a
    // connect pipeline still in flight must see that the user no longer wants it: it may
    // never publish a connected state or a fresh `activeHostId` afterwards (H4).
    if (ctx.state.activeHostId === id) ctx.state.activeHostId = null
    // `host.removed` owns the desired flag, the token bump, the timer disarms, the prompt
    // settlement and the teardown; the frame is published below with the host already gone, so
    // this call must not emit on its own.
    const event = { type: 'host.removed' as const, keepAlive: runtime.entry.keepAlive }
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'silent',
      emit: false,
    })
  }
  ctx.state.runtimes.delete(id)
  await ctx.store.removeHost(id)
  // The host is gone: its saved password must not outlive it in the credential store.
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

export async function saveSettings(ctx: Store & WatchdogCtx, patch: unknown): Promise<Settings> {
  await ctx.init()
  const settings = await ctx.store.saveSettings(patch)
  // The liveness switch applies to hosts that are already connected, not just the next one.
  for (const runtime of ctx.state.runtimes.values()) {
    if (runtime.status !== 'connected') continue
    if (settings.remoteHeartbeat.enabled) startRemoteHeartbeat(ctx, runtime)
    else stopRemoteHeartbeat(runtime)
  }
  ctx.emitState()
  return settings
}

/**
 * Browse directories inside the user's home so the client can pick a private-key
 * file instead of typing an absolute path. Read-only and home-confined.
 */
export async function listKeyFiles(ctx: Store, dir: unknown): Promise<KeyFileListing> {
  // The picker is rooted at the OS user home, not DSH_HOME: private keys live in
  // `~/.ssh` of the account, while the service's `home` is the DSH state root.
  const userHome = homedir()
  let listing: KeyFilesListing
  try {
    listing = await listKeyFilesInHome({ home: userHome, dir: typeof dir === 'string' ? dir : '' })
  } catch (error) {
    // A path outside the home directory (`C:\Windows`, `..`, a symlink escape) or an
    // unreadable one is the caller's mistake: answer 400 instead of turning a bare `Error`
    // into a 500, and never echo the requested path back in `technical`.
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

/** Read-only SSH discovery for the wizard (design §15.1). */
export async function discoverSshAliases(ctx: Config & Transport): Promise<SshDiscovery> {
  const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const parsed = parseSshConfig(material.configText)
  const aliases = discoverAliasesFromConfig(parsed, { home: ctx.userHome() })
  const knownHosts = parseKnownHosts(material.knownHostsText)
  return {
    aliases: aliases.map((alias) => ({
      alias: alias.alias,
      host: alias.host,
      user: alias.user,
      port: alias.port,
      source: 'config',
    })),
    knownHosts: summarizeKnownHosts(knownHosts),
  }
}
