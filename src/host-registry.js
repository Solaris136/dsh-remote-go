/**
 * The host registry: the record of configured hosts, the per-host runtime
 * objects that mirror them, and the client-facing snapshot built from both.
 *
 * Reads are pure; writes go through `store` and then re-emit the snapshot, so a
 * caller never has to remember to push state to the Client.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { errors } from './errors.js'
import { createHostRuntime } from './host-runtime.js'
import { hostView } from './host-view.js'
import { listKeyFiles as listKeyFilesInHome } from './key-files.js'
import { parseKnownHosts, summarizeKnownHosts } from './known-hosts.js'
import { cancelIdleStop, cancelReconnect, teardownRuntime } from './host-lifecycle.js'
import { discoverSshAliases as discoverAliasesFromConfig, parseSshConfig } from './ssh-config.js'

export function ensureRuntime(ctx, host) {
  const existing = ctx.state.runtimes.get(host.id)
  if (existing) {
    existing.entry = host
    return existing
  }
  const runtime = createHostRuntime(host)
  ctx.state.runtimes.set(host.id, runtime)
  return runtime
}

export function runtimeOf(ctx, id) {
  const runtime = ctx.state.runtimes.get(id)
  if (!runtime) throw errors.invalidInput('id', { zh: `未知主机 ${id}`, en: `Unknown host ${id}` })
  return runtime
}

export async function initRegistry(ctx) {
  if (ctx.state.initialized) return
  await ctx.store.load()
  for (const host of ctx.store.listHosts()) ensureRuntime(ctx, host)
  ctx.state.initialized = true
}

export function hostViewFor(ctx, runtime) {
  return hostView(runtime, {
    targetVersion: ctx.localVersion(),
    passwordStorageAvailable: ctx.secrets ? ctx.secrets.available() === true : false,
  })
}

/** Build the client-facing state snapshot (contract: docs/api.md). */
export function snapshot(ctx) {
  const localVersion = ctx.localVersion()
  const hosts = [...ctx.state.runtimes.values()].map((runtime) => hostViewFor(ctx, runtime))
  return {
    hostVersion: localVersion,
    targetVersion: localVersion,
    hosts,
    settings: ctx.store.getSettings(),
    activeHostId: ctx.state.activeHostId,
    firstRun: hosts.length === 0,
  }
}

export async function saveHost(ctx, rawHost) {
  await ctx.init()
  let entry
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
  ensureRuntime(ctx, entry)
  ctx.emitState()
  return hostViewFor(ctx, runtimeOf(ctx, entry.id))
}

export async function removeHost(ctx, id) {
  await ctx.init()
  const runtime = ctx.state.runtimes.get(id)
  if (runtime) {
    // A deleted host must not be resurrected by a timer scheduled before deletion.
    cancelReconnect(runtime)
    cancelIdleStop(runtime)
    await teardownRuntime(ctx, runtime, { stopRemote: runtime.entry.keepAlive === 'stop' })
  }
  ctx.state.runtimes.delete(id)
  await ctx.store.removeHost(id)
  if (ctx.state.activeHostId === id) ctx.state.activeHostId = null
  ctx.emitState()
  return { ok: true }
}

export function setActiveHost(ctx, id) {
  if (id !== null && !ctx.state.runtimes.has(id)) throw errors.invalidInput('id')
  ctx.state.activeHostId = id
  ctx.emitState()
}

export async function saveSettings(ctx, patch) {
  await ctx.init()
  const settings = await ctx.store.saveSettings(patch)
  ctx.emitState()
  return settings
}

/**
 * Browse directories inside the user's home so the client can pick a private-key
 * file instead of typing an absolute path. Read-only and home-confined.
 * @param {any} ctx @param {string} [dir]
 */
export async function listKeyFiles(ctx, dir) {
  // The picker is rooted at the OS user home, not DSH_HOME: private keys live in
  // `~/.ssh` of the account, while the service's `home` is the DSH state root.
  const userHome = homedir()
  const listing = await listKeyFilesInHome({ home: userHome, dir: typeof dir === 'string' ? dir : '' })
  const settings = ctx.store.getSettings()
  return { ...listing, defaultKeyPath: settings.defaultKeyPath, defaultDir: path.join(userHome, '.ssh') }
}

/** Read-only SSH discovery for the wizard (design §15.1). */
export async function discoverSshAliases(ctx) {
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
