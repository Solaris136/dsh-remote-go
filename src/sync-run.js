/**
 * The sync phase of a connection: prepare (read both sides, plan, hash) and apply (backup, write the remote profile / credentials, install plugins, verify, roll back on failure); a failed sync warns and lets the connection continue.
 */
import path from 'node:path'
import { dump } from '../vendor/yaml.bundle.mjs'
import { errors, toErrorView } from './errors.js'
import { remoteLayout } from './layout.js'
import { mergeCredentialsText } from './sync-credentials.js'
import { parseRowsYaml, readLocalSnapshot } from './sync-local.js'
import { mergePatchRows, planHash, planHasWork, planSync } from './sync-plan.js'
import {
  buildBackupCommand,
  buildDumpConfigCommand,
  buildEnsurePnpmCommand,
  buildPackageCheckCommand,
  buildPluginAddCommand,
  buildRestoreCommand,
  buildSnapshotCommand,
  mutableFiles,
  parseSnapshotOutput,
  runRemote,
  snapshotFiles,
  writeRemoteFile,
} from './sync-remote.js'
import { headTail, isPlainObject, messageOf, nowIso } from './util.js'

/** pnpm version used for remote plugin installs; matches this repository's own `packageManager`. */
export const SYNC_PNPM_VERSION = '11.28.9'

const PLUGIN_ADD_TIMEOUT_MS = 10 * 60_000
const PNPM_INSTALL_TIMEOUT_MS = 10 * 60_000
const VERIFY_TIMEOUT_MS = 3 * 60_000

export function syncWanted(entry) {
  return entry?.sync?.credentials === true || entry?.sync?.plugins === true
}

function setSyncState(ctx, runtime, patch) {
  runtime.sync = { ...runtime.sync, ...patch }
  ctx.emitState()
}

function syncErrorView(detail, technical) {
  return toErrorView(errors.syncFailed(detail, technical ? { technical } : undefined))
}

/**
 * Read the remote snapshot the plan needs. Every read is best-effort: a missing
 * file is an empty string, a malformed one is reported to the planner as an error.
 */
async function readRemoteSnapshot(ssh, layout, profile) {
  const files = snapshotFiles(profile)
  const result = await runRemote(ssh, buildSnapshotCommand({ home: layout.dshHome, files }), {
    timeoutMs: 30_000,
    maxBytes: 2 * 1024 * 1024,
  })
  const texts = parseSnapshotOutput(result.stdout, files)
  const packageJsonText = texts[files[0]]
  let packageJson = null
  try {
    const parsed = JSON.parse(packageJsonText)
    packageJson = isPlainObject(parsed) ? parsed : null
  } catch {
    // swallow-ok: an absent or malformed profile manifest is created/overwritten by the plan
    packageJson = null
  }
  const patch = parseRowsYaml(texts[files[1]])
  let state = null
  try {
    const parsed = JSON.parse(texts[files[3]])
    state = isPlainObject(parsed) ? parsed : null
  } catch {
    // swallow-ok: no sync state yet means the next apply writes one
    state = null
  }
  return { packageJson, rows: patch.rows, rowsError: patch.error, credentialsText: texts[files[2]], state }
}

function logPlanSummary(ctx, runtime, plan) {
  const counts = plan.counts
  ctx.progress.log(
    runtime,
    'info',
    `sync plan: ${counts.pluginsAdd} plugin(s) to add, ${counts.pluginsKeep} already present, ${counts.pluginsSkip} skipped; ` +
      `${counts.rowsApply} config row(s); ${counts.refs} key(s), ${counts.records} record(s)`,
  )
  for (const entry of plan.plugins) {
    if (entry.reason) ctx.progress.log(runtime, 'debug', `sync: skip plugin ${entry.name} (${entry.reason})`)
    else if (entry.warning)
      ctx.progress.log(runtime, 'warn', `sync: ${entry.name} declares build scripts (${entry.warning})`)
  }
  for (const note of plan.notes) {
    ctx.progress.log(runtime, 'warn', `sync: ${note.code} is not usable (${note.reason}); that part is skipped`)
  }
}

/**
 * Build the plan for one connection. Returns null when sync is disabled or the
 * plan cannot be produced; the connection continues either way.
 */
export async function prepareSync(ctx, runtime) {
  const entry = runtime.entry
  if (!syncWanted(entry)) return null
  try {
    const profile = ctx.settings().bootstrap.profile
    const layout = remoteLayout(runtime.facts?.home ?? null)
    const local = await readLocalSnapshot({
      home: ctx.home,
      env: process.env,
      profileDir: typeof ctx.localProfileDir === 'string' ? ctx.localProfileDir : undefined,
    })
    const remote = await readRemoteSnapshot(runtime.ssh, layout, profile)
    const plan = planSync(local, remote, {
      credentials: entry.sync.credentials === true,
      plugins: entry.sync.plugins === true,
      remoteArch: runtime.facts?.arch,
      remoteVersion: ctx.localVersion(),
      nodeVersion: runtime.facts?.nodeVersion,
    })
    const hash = planHash(plan)
    ctx.progress.phase(runtime, 'sync', 'sync-planning', {
      plugins: plan.counts.pluginsAdd,
      rows: plan.counts.rowsApply,
      refs: plan.counts.refs,
    })
    logPlanSummary(ctx, runtime, plan)
    setSyncState(ctx, runtime, { status: 'planned', enabled: true, hash, error: null, summary: plan.counts })
    return { plan, hash, remote, local, layout, profile }
  } catch (error) {
    // swallow-ok: a planning failure is reported as a sync warning and never blocks the connection
    ctx.progress.log(runtime, 'warn', `sync: planning failed, this connection syncs nothing (${messageOf(error)})`)
    setSyncState(ctx, runtime, { status: 'failed', enabled: true, error: syncErrorView(null, messageOf(error)) })
    return null
  }
}

/** The profile manifest a fresh remote profile starts from (base + web app). */
export function skeletonProfilePackage(profile) {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
}

function nextProfilePackage(current, plan, profile) {
  const exists = isPlainObject(current)
  const pkg = exists ? JSON.parse(JSON.stringify(current)) : skeletonProfilePackage(profile)
  let changed = !exists
  if (!isPlainObject(pkg.dependencies)) {
    pkg.dependencies = {}
    changed = true
  }
  if (!isPlainObject(pkg.dsh)) {
    pkg.dsh = {}
    changed = true
  }
  if (!isPlainObject(pkg.dsh.profile)) {
    pkg.dsh.profile = {}
    changed = true
  }
  if (!Array.isArray(pkg.dsh.profile.bundles)) {
    pkg.dsh.profile.bundles = []
    changed = true
  }
  const bundles = pkg.dsh.profile.bundles
  for (const entry of plan.plugins) {
    if (entry.action === 'skip') continue
    // `dsh plugin add` records a new dependency itself; a package that is already
    // installed only needs its bundle selected.
    if (entry.action === 'keep' && entry.version && pkg.dependencies[entry.name] !== entry.version) {
      pkg.dependencies[entry.name] = entry.version
      changed = true
    }
    if (entry.action === 'keep' && !bundles.includes(entry.name)) {
      bundles.push(entry.name)
      changed = true
    }
  }
  return { packageJson: pkg, changed }
}

async function ensurePnpm(ctx, runtime, layout, facts) {
  const npmPath = facts?.npmPath ?? null
  if (!npmPath) throw new Error('the managed Node has no npm')
  ctx.progress.phase(runtime, 'sync', 'sync-tooling')
  const result = await runRemote(
    sshOf(runtime),
    buildEnsurePnpmCommand({
      npmPath,
      nodeBinDir: facts?.nodeBinDir ?? '',
      dir: `${layout.root}/pnpm`,
      version: SYNC_PNPM_VERSION,
      shimDir: `${layout.root}/bin`,
    }),
    { timeoutMs: PNPM_INSTALL_TIMEOUT_MS, maxBytes: 100_000 },
  )
  if (result.code !== 0 || !String(result.stdout).includes('PNPM-READY')) {
    throw new Error(`pnpm provisioning failed: ${headTail(result.stdout || result.stderr, 400)}`)
  }
  return `${layout.root}/bin`
}

function sshOf(runtime) {
  return runtime.ssh
}

/**
 * Apply a prepared plan. Non-fatal problems (a plugin whose registry install
 * fails) leave `status: 'partial'`; a verification failure rolls the remote files
 * back, and only a failed rollback becomes a connection error.
 */
export async function applySync(ctx, runtime, prepared) {
  const { plan, hash, remote, layout, profile } = prepared
  const ssh = runtime.ssh
  const dshVersion = ctx.localVersion()
  const facts = runtime.facts ?? {}
  const archive = `${layout.root}/sync/backup-${Date.now()}.tgz`
  const force = runtime.forceSync === true
  runtime.forceSync = false

  if (!force && remote.state?.hash === hash && remote.state?.profile === profile && remote.state?.status !== 'failed') {
    ctx.progress.log(runtime, 'debug', 'sync: the remote already carries this plan (hash unchanged)')
    setSyncState(ctx, runtime, {
      status: 'applied',
      enabled: true,
      at: typeof remote.state.at === 'string' ? remote.state.at : nowIso(),
      hash,
      error: null,
      summary: isPlainObject(remote.state.counts) ? remote.state.counts : plan.counts,
    })
    return
  }

  if (!planHasWork(plan)) {
    ctx.progress.log(runtime, 'info', 'sync: nothing to change on the remote')
    try {
      await writeSyncState(layout, ssh, { hash, profile, counts: plan.counts, status: 'applied' })
    } catch (error) {
      // swallow-ok: the remote state file is an optimization; the connection still works without it
      ctx.progress.log(runtime, 'debug', 'sync: could not record the applied plan:', messageOf(error))
    }
    setSyncState(ctx, runtime, {
      status: 'applied',
      enabled: true,
      at: nowIso(),
      hash,
      error: null,
      summary: plan.counts,
    })
    return
  }

  setSyncState(ctx, runtime, { status: 'syncing', enabled: true, error: null })
  ctx.progress.phase(runtime, 'sync', 'sync-backup')
  try {
    await runRemote(ssh, buildBackupCommand({ home: layout.dshHome, files: mutableFiles(profile), archive }), {
      timeoutMs: 60_000,
      maxBytes: 20_000,
    })
  } catch (error) {
    // swallow-ok: without a backup the sync is skipped entirely; the connection continues on the untouched remote
    ctx.progress.log(runtime, 'warn', `sync: backup failed, skipping this sync (${messageOf(error)})`)
    setSyncState(ctx, runtime, { status: 'failed', enabled: true, error: syncErrorView(null, messageOf(error)) })
    return
  }
  ctx.progress.log(runtime, 'debug', `sync: backup written to ${archive}`)

  try {
    if (plan.credentials.refs.length > 0 || plan.credentials.records.length > 0) {
      ctx.progress.phase(runtime, 'sync', 'sync-credentials', {
        refs: plan.credentials.refs.length,
        records: plan.credentials.records.length,
      })
      const merged = mergeCredentialsText(remote.credentialsText, plan.credentials, { at: nowIso() })
      await writeRemoteFile(ssh, `${layout.dshHome}/.credentials.yaml`, merged.text, { mode: '600' })
      ctx.progress.log(
        runtime,
        'info',
        `sync: credentials merged (${merged.counts.addedRefs} added, ${merged.counts.updatedRefs} updated, ` +
          `${merged.counts.addedRecords} record(s) added, ${merged.counts.keptRecords} kept)`,
      )
    }

    const profilePackage = nextProfilePackage(remote.packageJson, plan, profile)
    if (profilePackage.changed) {
      ctx.progress.phase(runtime, 'sync', 'sync-config')
      await writeRemoteFile(
        ssh,
        `${layout.dshHome}/profiles/${profile}/package.json`,
        `${JSON.stringify(profilePackage.packageJson, null, 2)}\n`,
        { mode: '600' },
      )
      ctx.progress.log(runtime, 'info', 'sync: remote profile manifest updated')
    }

    const added = plan.plugins.filter((item) => item.action === 'add')
    const failedPlugins = []
    if (added.length > 0) {
      const shimDir = await ensurePnpm(ctx, runtime, layout, facts)
      const nodeBinDir = facts.nodeBinDir ?? (facts.nodePath ? path.dirname(facts.nodePath) : '')
      const npxPath = facts.npxPath ?? (nodeBinDir ? `${nodeBinDir}/npx` : 'npx')
      for (const [index, item] of added.entries()) {
        ctx.progress.phase(runtime, 'sync', 'sync-plugins', {
          name: item.name,
          index: index + 1,
          total: added.length,
        })
        ctx.progress.log(runtime, 'info', `sync: installing ${item.name}@${item.version}`)
        try {
          const result = await runRemote(
            ssh,
            buildPluginAddCommand({
              home: layout.dshHome,
              profile,
              spec: `${item.name}@${item.version}`,
              dshVersion,
              npxPath,
              nodeBinDir,
              shimDir,
            }),
            { timeoutMs: PLUGIN_ADD_TIMEOUT_MS, maxBytes: 400_000 },
          )
          if (result.code !== 0) {
            failedPlugins.push(item.name)
            ctx.progress.log(
              runtime,
              'warn',
              `sync: ${item.name} did not install (${headTail(result.stderr || result.stdout, 300)})`,
            )
          }
        } catch (error) {
          // swallow-ok: one failed package install is a reported skip, not a connection failure
          failedPlugins.push(item.name)
          ctx.progress.log(runtime, 'warn', `sync: ${item.name} install failed (${messageOf(error)})`)
        }
      }
    }

    const appliedRows = plan.rows.entries.filter((item) => item.action !== 'skip')
    if (appliedRows.length > 0) {
      ctx.progress.phase(runtime, 'sync', 'sync-config', { rows: appliedRows.length })
      const merged = mergePatchRows(remote.rows ?? [], appliedRows)
      const text = dump(merged.rows, { lineWidth: 0, noRefs: true })
      await writeRemoteFile(ssh, `${layout.dshHome}/profiles/${profile}/cordis.patch.yml`, text, { mode: '600' })
      ctx.progress.log(runtime, 'info', `sync: ${merged.replaced} config row(s) replaced, ${merged.appended} appended`)
    }

    ctx.progress.phase(runtime, 'sync', 'sync-verifying')
    await verifyRemote(ssh, runtime, { layout, profile, dshVersion, facts, added })
    ctx.progress.log(runtime, 'info', 'sync: remote composition verified')

    const status = failedPlugins.length > 0 ? 'partial' : 'applied'
    await writeSyncState(layout, ssh, {
      hash,
      profile,
      counts: plan.counts,
      status,
      failedPlugins,
    })
    setSyncState(ctx, runtime, {
      status,
      enabled: true,
      at: nowIso(),
      hash,
      error: null,
      summary: { ...plan.counts, failedPlugins: failedPlugins.length },
    })
    if (failedPlugins.length > 0) {
      ctx.progress.log(runtime, 'warn', `sync: finished with ${failedPlugins.length} package(s) not installed`)
    }
  } catch (error) {
    ctx.progress.log(runtime, 'warn', `sync: apply failed, rolling the remote files back (${messageOf(error)})`)
    let restored = false
    try {
      const result = await runRemote(ssh, buildRestoreCommand({ home: layout.dshHome, archive }), {
        timeoutMs: 60_000,
        maxBytes: 20_000,
      })
      restored = result.code === 0
    } catch (restoreError) {
      ctx.progress.log(runtime, 'error', 'sync: rollback failed:', messageOf(restoreError))
    }
    if (!restored) {
      setSyncState(ctx, runtime, {
        status: 'failed',
        enabled: true,
        error: syncErrorView(null, messageOf(error)),
      })
      throw errors.syncFailed(
        {
          zh: '同步失败，且远端文件没有成功回滚；连接已中止，避免用过期的远端配置启动界面。',
          en: 'The sync failed and the remote files were not rolled back; the connection was aborted to avoid starting with a half-written profile.',
        },
        { technical: headTail(messageOf(error), 600) },
      )
    }
    setSyncState(ctx, runtime, {
      status: 'failed',
      enabled: true,
      error: syncErrorView(null, messageOf(error)),
    })
    ctx.progress.log(runtime, 'warn', 'sync: remote files restored; connecting without the sync')
  }
}

async function verifyRemote(ssh, runtime, options) {
  const { layout, profile, dshVersion, facts, added } = options
  const nodeBinDir = facts.nodeBinDir ?? (facts.nodePath ? path.dirname(facts.nodePath) : '')
  const npxPath = facts.npxPath ?? (nodeBinDir ? `${nodeBinDir}/npx` : 'npx')
  const dumped = await runRemote(
    ssh,
    buildDumpConfigCommand({ home: layout.dshHome, profile, dshVersion, npxPath, nodeBinDir }),
    { timeoutMs: VERIFY_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 },
  )
  if (dumped.code !== 0) {
    throw new Error(`dsh --dump-config failed (exit ${dumped.code}): ${headTail(dumped.stderr || dumped.stdout, 600)}`)
  }
  if (added.length === 0) return
  const check = await runRemote(
    ssh,
    buildPackageCheckCommand({
      profileDir: `${layout.dshHome}/profiles/${profile}`,
      names: added.map((item) => item.name),
    }),
    { timeoutMs: 30_000, maxBytes: 100_000 },
  )
  const missing = String(check.stdout)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('MISSING '))
    .map((line) => line.slice('MISSING '.length).trim())
    .filter(Boolean)
  if (missing.length > 0) throw new Error(`packages missing after install: ${missing.join(', ')}`)
  ctx.progress.log(runtime, 'debug', `sync: ${added.length} package(s) present in the remote profile`)
}

async function writeSyncState(layout, ssh, state) {
  const payload = {
    version: 1,
    at: nowIso(),
    hash: state.hash ?? null,
    profile: state.profile ?? null,
    counts: state.counts ?? null,
    status: state.status ?? 'applied',
    failedPlugins: Array.isArray(state.failedPlugins) ? state.failedPlugins : [],
  }
  await writeRemoteFile(ssh, `${layout.root}/sync/state.json`, `${JSON.stringify(payload, null, 2)}\n`, { mode: '600' })
}
