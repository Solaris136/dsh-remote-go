/**
 * Orchestration service — the facade over host-registry, connect-pipeline, host-lifecycle, prompts and connect-progress; every external step is injected.
 */
import { EventEmitter } from 'node:events';
import { planNpx, verifyNpxVersion } from './bootstrap.js';
import { MIN_DSH_VERSION, REMOTE_CONFLICT_TIMEOUT_MS, REMOTE_REATTACH_ATTEMPTS, REMOTE_REATTACH_INTERVAL_MS, REMOTE_TUNNEL_REPAIR_SETTLE_MS, REMOTE_UNREACHABLE_CONFIRM_DELAY_MS, REMOTE_UNREACHABLE_RECHECK_DELAY_MS, REMOTE_VIEW_PREFIX, } from './constants.js';
import { createConnectProgress, describePreflightEvent } from './connect-progress.js';
import { createDownloadJobs } from './download-jobs.js';
import { reattachHost, reconnectHost, repairTunnel, restartHost, startConnect, stopRemoteHost, } from './connect-pipeline.js';
import { diagnoseHost } from './diagnostics.js';
import { errors } from './errors.js';
import { discoverSshAliases, initRegistry, listKeyFiles, removeHost, runtimeOf, saveHost, saveSettings, setActiveHost, snapshot, } from './host-registry.js';
import { disconnectHost, noteRemoteUnreachable, shutdownAll } from './host-lifecycle.js';
import { requireDestination } from './local-download.js';
import { loadLocalSshMaterial } from './local-ssh.js';
import { ensureRemoteNode } from './node-runtime.js';
import { confirmConflict, confirmHostKey } from './prompts.js';
import { probeRemote } from './probe.js';
import { SshConnection } from './ssh.js';
import { createTunnel, probeLoopback } from './tunnel.js';
import { compareVersions, normalizeVersion, parseVersion } from './version.js';
import { nowIso } from './util.js';
import { adoptRemoteWeb, clearRunRegistry, exchangeTokenOverTunnel, findForeignDshProcesses, readRunRegistry, remoteHttpStatus, remoteProcessIdentity, resolveRemoteWeb, startRemoteWeb, stopForeignDshProcesses, stopRemoteWeb, waitForRemoteUi, writeRunRegistry, } from './webapp.js';
export { describePreflightEvent };
/** Milliseconds a paused host-key handshake waits for the user. */
const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000;
/**
 * One Host process can create several services (tests, a plugin reload in-process). The
 * instance id must differ for each so the Client can tell a new publish generation from a stale
 * frame without trusting wall-clock ordering.
 */
let stateInstanceSequence = 0;
function stateInstanceId() {
    stateInstanceSequence += 1;
    const pid = typeof process !== 'undefined' && Number.isInteger(process.pid) ? process.pid.toString(36) : '0';
    return `${pid}-${Date.now().toString(36)}-${stateInstanceSequence.toString(36)}`;
}
export class RemoteGoService extends EventEmitter {
    constructor(options) {
        super();
        this.store = options.store;
        this.home = options.home;
        this.logger = options.logger ?? console;
        this.localVersion = options.localVersion ?? null;
        // `engines.node` of the local DSH package; the managed Node version is its
        // lower bound (see `managedNodeVersionFromEngine`). Null until detected.
        this.engineNodeRange = options.engineNodeRange ?? null;
        this.secrets = options.secrets ?? null;
        this.hostKeyConfirmTimeoutMs = options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS;
        this.conflictConfirmTimeoutMs = options.conflictConfirmTimeoutMs ?? REMOTE_CONFLICT_TIMEOUT_MS;
        this.logLevel = typeof options.logLevel === 'string' ? options.logLevel : null;
        this.stateRev = 0;
        this.stateInstance = stateInstanceId();
        const deps = {
            sshFactory: options.sshFactory ?? ((sshOptions) => new SshConnection(sshOptions)),
            tunnelFactory: options.tunnelFactory ?? createTunnel,
            /** Local listener health: decides whether a transient proxy failure needs a rebuild. */
            tunnelProbe: options.tunnelProbe ?? probeLoopback,
            probe: options.probe ?? probeRemote,
            plan: options.plan ?? planNpx,
            ensureNode: options.ensureNode ?? ensureRemoteNode,
            preflight: options.preflight ?? verifyNpxVersion,
            startWeb: options.startWeb ?? startRemoteWeb,
            stopWeb: options.stopWeb ?? stopRemoteWeb,
            waitUi: options.waitUi ?? waitForRemoteUi,
            exchange: options.exchange ?? exchangeTokenOverTunnel,
            adopt: options.adopt ?? adoptRemoteWeb,
            resolveRemote: options.resolveRemote ?? resolveRemoteWeb,
            writeRegistry: options.writeRegistry ?? writeRunRegistry,
            clearRegistry: options.clearRegistry ?? clearRunRegistry,
            remoteStatus: options.remoteStatus ?? remoteHttpStatus,
            processIdentity: options.processIdentity ?? remoteProcessIdentity,
            findForeign: options.findForeign ?? findForeignDshProcesses,
            stopForeign: options.stopForeign ?? stopForeignDshProcesses,
            readRegistry: options.readRegistry ?? readRunRegistry,
            loadSshMaterial: options.loadSshMaterial ?? loadLocalSshMaterial,
        };
        this.ctx = {
            deps,
            store: this.store,
            home: this.home,
            logger: this.logger,
            secrets: this.secrets,
            state: { runtimes: new Map(), activeHostId: null, initialized: false, disposed: false },
            timers: {
                hostKeyConfirmMs: this.hostKeyConfirmTimeoutMs,
                conflictConfirmMs: this.conflictConfirmTimeoutMs,
                // Liveness confirmation and the re-attach retry loop; tests shorten these.
                remoteConfirmDelayMs: options.remoteConfirmDelayMs ?? REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
                remoteRecheckMs: options.remoteRecheckMs ?? REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
                reattachAttempts: options.reattachAttempts ?? REMOTE_REATTACH_ATTEMPTS,
                reattachIntervalMs: options.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS,
                tunnelRepairSettleMs: options.tunnelRepairSettleMs ?? REMOTE_TUNNEL_REPAIR_SETTLE_MS,
            },
            // Live readers, never cached: a setting or a detected version can change
            // while a connect is already in flight.
            settings: () => this.store.getSettings(),
            localVersion: () => this.localVersion,
            engineNodeRange: () => this.engineNodeRange,
            userHome: () => process.env.USERPROFILE || process.env.HOME || this.home,
            emitState: () => this.emitState(),
            init: () => this.init(),
            /**
             * The watchdog reports an episode (suspected -> confirmed -> recovered); the Client
             * contract gets the same transitions as one SSE event, and the state frames carry the
             * `restarting-remote` progress. Never let a listener failure break the probe.
             */
            onRemoteUnreachable: (runtime, info) => {
                try {
                    this.emit('remote-unreachable', { hostId: runtime.id, at: nowIso(), ...info });
                }
                catch (error) {
                    this.logger.warn?.('[dsh-remote-go] remote-unreachable listener failed:', error);
                }
            },
            /** A proxy or tunnel failure arrived: confirm it with probes instead of trusting one request. */
            noteRemoteUnreachable: (runtime, source) => noteRemoteUnreachable(this.ctx, runtime, source),
            /** Confirmed by probes: re-read the remote, rewrite the registry, rebuild the tunnel. */
            requestReattach: (runtime, info) => {
                void reattachHost(this.ctx, runtime, info);
            },
            /** The remote answers but proxied requests fail: rebuild the local listener (B8). */
            repairTunnel: (runtime) => repairTunnel(this.ctx, runtime),
            // `progress` is attached on the next statement: its writer needs `emitState`, which reads
            // this very object. The cast restates the one field the literal cannot carry yet.
        };
        this.ctx.progress = createConnectProgress({
            logger: this.logger,
            logLevel: this.logLevel,
            getSettings: () => this.store.getSettings(),
            emitState: () => this.emitState(),
        });
        this.downloads = createDownloadJobs({
            logger: this.logger,
            emit: (job) => this.emit('download', job),
        });
    }
    get runtimes() {
        return this.ctx.state.runtimes;
    }
    get activeHostId() {
        return this.ctx.state.activeHostId;
    }
    async init() {
        await initRegistry(this.ctx);
        return this;
    }
    emitState() {
        try {
            // Every emitted frame gets its own monotonic revision. The Client drops a frame whose
            // `rev` is not newer than the one on screen, so an out-of-order SSE delivery or a slow
            // `GET /state` can no longer repaint the panel backwards (docs/api.md StateView.rev).
            this.stateRev += 1;
            this.emit('state', this.snapshot());
        }
        catch (error) {
            this.logger.warn?.('[dsh-remote-go] state listener failed:', error);
        }
    }
    /**
     * Adopt a DSH version for this machine.
     *
     * `source === 'client'` is the browser's `POST /local-version` backfill: it exists for the
     * case where the Host could not detect the version by itself, so it must never overwrite a
     * detected one, and it must stay inside the range this plugin supports. Without both guards
     * any local page could pin the remote npx runtime (and the version-parity check) to a value
     * of its choosing.
     * @param version - a DSH semver string.
     * @param source - where the value came from; only `client` is distrusted.
     * @returns whether the value was adopted.
     */
    setLocalVersion(version, source = 'detected') {
        const normalized = version ? normalizeVersion(String(version)) : null;
        const valid = normalized !== null && parseVersion(normalized) !== null;
        if (source === 'client') {
            if (this.localVersion !== null)
                return false;
            // A page may only name a real DSH version: a typo or a crafted value is a client mistake
            // (400), not a silent no-op the page could mistake for success.
            if (!valid) {
                throw errors.invalidInput('version', {
                    zh: '本机 DSH 版本格式不合法。',
                    en: 'The local DSH version is not a valid version.',
                });
            }
            if (compareVersions(normalized, MIN_DSH_VERSION) < 0) {
                throw errors.invalidInput('version', {
                    zh: `本机 DSH 版本 ${normalized} 低于插件要求的最低版本 ${MIN_DSH_VERSION}。`,
                    en: `Local DSH ${normalized} is below the minimum this plugin supports (${MIN_DSH_VERSION}).`,
                });
            }
        }
        else if (!valid) {
            return false;
        }
        this.localVersion = normalized;
        this.emitState();
        return true;
    }
    setLocalEnginesNode(range) {
        const text = typeof range === 'string' ? range.trim() : '';
        this.engineNodeRange = text === '' ? null : text;
    }
    /** Build the client-facing state snapshot (contract: docs/api.md). */
    snapshot() {
        return { ...snapshot(this.ctx), rev: this.stateRev, instance: this.stateInstance };
    }
    userHome() {
        return this.ctx.userHome();
    }
    async saveHost(rawHost) {
        return saveHost(this.ctx, rawHost);
    }
    async removeHost(id) {
        return removeHost(this.ctx, id);
    }
    setActiveHost(id) {
        return setActiveHost(this.ctx, id);
    }
    async saveSettings(patch) {
        return saveSettings(this.ctx, patch);
    }
    async listKeyFiles(dir) {
        return listKeyFiles(this.ctx, dir);
    }
    async discoverSshAliases() {
        return discoverSshAliases(this.ctx);
    }
    async connect(id, options = {}) {
        return startConnect(this.ctx, id, options);
    }
    /**
     * Remember (or forget) the SSH password without opening a connection. The wizard's plain
     * "save" action uses this, and it is the only way to refresh a saved password that does not
     * require a successful connect first. The value never enters `hosts.json`; `available:false`
     * means no credential store can persist it here.
     * @param id - host id.
     */
    async saveHostPassword(id, options = {}) {
        await this.init();
        const runtime = runtimeOf(this.ctx, id);
        const available = this.secrets ? this.secrets.available() === true : false;
        if (!available)
            return { available: false, saved: false };
        if (options.clear === true) {
            const removed = await this.secrets.remove(id);
            // The password in memory belonged to the record just removed: a later connect must ask
            // instead of silently reusing a credential the user asked to forget.
            runtime.password = null;
            runtime.passwordSaved = !removed;
            this.emitState();
            return { available, saved: false };
        }
        const password = typeof options.password === 'string' ? options.password : '';
        if (password === '') {
            throw errors.invalidInput('password', { zh: '密码不能为空。', en: 'The password must not be empty.' });
        }
        const saved = await this.secrets.set(id, password);
        // An explicit save also arms the in-memory copy, so clicking "connect" next does not ask
        // again for a password this process just proved and stored.
        runtime.password = password;
        runtime.passwordSaved = saved;
        this.emitState();
        return { available, saved };
    }
    async disconnect(id, options = {}) {
        await this.init();
        return disconnectHost(this.ctx, runtimeOf(this.ctx, id), options);
    }
    async reconnect(id) {
        await this.init();
        return reconnectHost(this.ctx, runtimeOf(this.ctx, id));
    }
    /**
     * Restart the managed remote web on the same SSH session (the "Restart remote DSH"
     * card action). Only a connected host can be restarted; the work runs in the
     * background and reports through `/state` like a connect does.
     */
    async restart(id) {
        await this.init();
        return restartHost(this.ctx, runtimeOf(this.ctx, id));
    }
    /**
     * Stop the managed remote web this connection is bound to, then release the link and
     * leave the host `disconnected` (the "Stop remote DSH" card action). Runs synchronously
     * on the same SSH session: `/state` carries `stopping-remote` while it works, and a
     * refusal (wrong state, busy, or an unprovable pid) is thrown as a coded error (HTTP 409).
     */
    async stopRemote(id) {
        await this.init();
        return stopRemoteHost(this.ctx, runtimeOf(this.ctx, id));
    }
    async confirmFingerprint(id, decision) {
        return confirmHostKey(this.ctx, runtimeOf(this.ctx, id), decision);
    }
    async confirmConflict(id, decision) {
        return confirmConflict(runtimeOf(this.ctx, id), decision);
    }
    openInfo(id) {
        const runtime = runtimeOf(this.ctx, id);
        if (runtime.status !== 'connected' || !runtime.tunnel || !runtime.token) {
            throw errors.remoteUiUnreachable({
                zh: '主机尚未连接，无法打开远端界面。',
                en: 'The host is not connected yet, so the remote UI cannot be opened.',
            });
        }
        const token = encodeURIComponent(runtime.token);
        return {
            url: `http://127.0.0.1:${runtime.tunnel.localPort}/?token=${token}`,
            // The browser half's carrier: same-origin seat of the same UI, proxied to this tunnel.
            webUrl: `${REMOTE_VIEW_PREFIX}${encodeURIComponent(id)}/?token=${token}`,
            localPort: runtime.tunnel.localPort,
            address: `127.0.0.1:${runtime.tunnel.localPort}`,
        };
    }
    /** Configured host ids (the proxy keeps one stream upgrade route per id). */
    hostIds() {
        return [...this.ctx.state.runtimes.keys()];
    }
    /**
     * Loopback target of one host's remote web UI, for the same-origin proxy.
     * Reads the live runtime, so a reconnect hands the proxy the new tunnel on the next request.
     * @param id - host id.
     */
    webViewTarget(id) {
        const runtime = this.ctx.state.runtimes.get(id);
        if (!runtime || runtime.status !== 'connected' || !runtime.tunnel)
            return null;
        return { localPort: runtime.tunnel.localPort, remotePort: runtime.remote.port };
    }
    /**
     * The same-origin proxy could not reach a host's tunnel. One failed request is not a
     * restart: it starts the same probe confirmation the heartbeat uses.
     * @param id - host id the proxy serves.
     */
    noteUpstreamFailure(id) {
        const runtime = this.ctx.state.runtimes.get(id);
        if (!runtime)
            return;
        noteRemoteUnreachable(this.ctx, runtime, 'proxy');
    }
    async diagnose(id) {
        await this.init();
        return diagnoseHost(runtimeOf(this.ctx, id), { targetVersion: this.localVersion });
    }
    /**
     * Start preparing one remote file or folder for the client's download.
     * @param id - host id.
     * @param path - absolute remote path.
     * @param options - local destination directory.
     * @returns the initial download job view.
     */
    async startRemoteDownload(id, path, options = {}) {
        await this.init();
        const runtime = runtimeOf(this.ctx, id);
        // One home root for both checks: the pre-flight below and the write itself. Falling back to
        // `os.homedir()` later could disagree with `userHome()` when HOME/USERPROFILE is unset, and
        // then a destination accepted here would be refused by the job.
        const home = this.userHome();
        // The local folder is checked before a job exists: a refused destination is the caller's
        // mistake (HTTP 400 `invalid-input`), not a job that first answers `preparing` and then
        // reports the refusal asynchronously (which also wasted a job slot and an SFTP stat).
        await requireDestination(options.destination, { home });
        return this.downloads.start(runtime, path, { ...options, home });
    }
    /** Current view of one download job. */
    async remoteDownloadStatus(jobId) {
        await this.init();
        return this.downloads.status(jobId);
    }
    /** Cancel one download job. */
    async cancelRemoteDownload(jobId) {
        await this.init();
        return this.downloads.cancel(jobId);
    }
    async shutdown() {
        this.ctx.state.disposed = true;
        this.ctx.progress.dispose();
        this.downloads.dispose();
        await shutdownAll(this.ctx);
    }
}
