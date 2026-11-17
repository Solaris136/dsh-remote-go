/**
 * The connect pipeline: SSH -> probe -> managed Node -> plan -> adopt/conflict -> preflight -> start -> tunnel -> verify; the step order is the behavior and every step is injected.
 */
import { REMOTE_REATTACH_ATTEMPTS, REMOTE_REATTACH_INTERVAL_MS, REMOTE_REPAIR_BACKOFF_MAX_MS, REMOTE_REPAIR_BACKOFF_MS, REMOTE_START_TIMEOUT_MS, SSH_READY_TIMEOUT_MS, TUNNEL_PROBE_TIMEOUT_MS, } from './constants.js';
import { beginConnectLog } from './connect-log.js';
import { errors, RemoteGoError, toErrorView } from './errors.js';
import { runtimeOf } from './host-registry.js';
import { beginLinkWork, cancelIdleStop, cancelLinkWork, cancelReconnect, closeTunnel, disconnectHost, disposeSsh, endLinkWork, isLinkWorkCurrent, scheduleReconnect, startRemoteHeartbeat, stopRemoteHeartbeat, teardownRuntime, } from './host-lifecycle.js';
import { findKnownHostEntries, parseKnownHosts } from './known-hosts.js';
import { layoutForRuntime } from './layout.js';
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from './node-runtime.js';
import { askConflict, cancelConflict, cancelHostKeyPrompt, requestHostKey } from './prompts.js';
import { buildRunRegistryRecord, commandMatchesProfile } from './remote-web.js';
import { resolveDestination } from './ssh-config.js';
import { isPid, messageOf, nowIso, sleep } from './util.js';
import { normalizeVersion, versionsEqual } from './version.js';
function describeTarget(entry) {
    const user = entry.username ? `${entry.username}@` : '';
    const port = entry.port && entry.port !== 22 ? `:${entry.port}` : '';
    return `${user}${entry.address || '?'}${port}`;
}
/** The bilingual detail of "the transport this step needed is gone". */
const SSH_CLOSED_DETAIL = {
    zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
    en: 'SSH connection is not open; the transport closed before this step finished. Reconnect to continue.',
};
/**
 * Internal marker: a pipeline step ran after the user (or the host process) took the link
 * away. It is not a connection failure, so it never reaches the Client as an error.
 */
class LinkCancelled extends Error {
    constructor(reason) {
        super(`connect aborted: ${reason}`);
        this.name = 'LinkCancelled';
        this.code = 'link-cancelled';
    }
}
/** Whether the link is no longer wanted: disconnect, host removal, teardown or shutdown. */
function linkTaken(ctx, runtime) {
    return (ctx.state.disposed === true ||
        runtime.closing === true ||
        runtime.desired !== 'connected' ||
        !ctx.state.runtimes.has(runtime.id));
}
/** Throw unless this attempt may still write state (H4). */
function assertStillWanted(ctx, runtime) {
    if (linkTaken(ctx, runtime))
        throw new LinkCancelled('the link is no longer wanted');
}
/** Throw a typed transport error unless the SSH transport is still open (H3). */
function assertTransportOpen(runtime) {
    if (runtime.ssh?.connected !== true) {
        throw errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed' });
    }
}
/**
 * Classify a pipeline failure. A step that raced the transport going away must read as a
 * dropped connection (`network`, retryable), never as a bare `internal` error or as a key
 * decision the user never made (H3).
 * @param runtime - host runtime.
 * @param error - the thrown value.
 * @returns the Client-facing error view.
 */
function normalizeConnectFailure(runtime, error) {
    const view = toErrorView(error);
    if (runtime.transportLost === true && runtime.ssh?.connected !== true) {
        // A prompt parked on the transport was resolved by the close itself: the user made no
        // decision, so this must not read as "confirm the host key" / "a manual DSH is running".
        if (view.code === 'host-key-unknown' || view.code === 'remote-dsh-running') {
            return toErrorView(errors.network(SSH_CLOSED_DETAIL, {
                technical: `reason=ssh-closed phase-code=${view.code}`,
            }));
        }
    }
    if (runtime.ssh?.connected === true) {
        if (!(error instanceof RemoteGoError) &&
            /\b(?:not open|closed|ECONNRESET|EPIPE|Channel closed)\b/i.test(String(error?.message ?? ''))) {
            return toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: `reason=ssh-closed cause=${error?.message ?? error}` }));
        }
        return view;
    }
    if (view.code === 'internal' || view.code === 'remote-dsh-missing' || view.code === 'remote-node-install-failed') {
        return toErrorView(errors.network(SSH_CLOSED_DETAIL, {
            technical: `reason=ssh-closed phase-code=${view.code} cause=${error instanceof Error ? error.message : String(error ?? '')}`,
        }));
    }
    return view;
}
/**
 * Accept a connect request: apply the one-time inputs, stop any pending retry,
 * and start the pipeline in the background. Progress travels on `state`.
 */
export async function startConnect(ctx, id, options = {}) {
    await ctx.init();
    const runtime = runtimeOf(ctx, id);
    if (runtime.connectPromise)
        return { accepted: false, reason: 'already-connecting' };
    if (runtime.linkBusy !== null)
        return { accepted: false, reason: 'already-restarting' };
    if (runtime.status === 'connected' && runtime.ssh?.connected)
        return { accepted: false, reason: 'already-connected' };
    // A new connect owns the link from here on: any pending one-shot action is stale.
    cancelLinkWork(runtime);
    // An idle host keeps a timer that would stop the remote web; connecting again makes that
    // policy stale (the timer used to fire into a live link: review blocker 1).
    cancelIdleStop(runtime);
    stopRemoteHeartbeat(runtime);
    runtime.alongsidePids = [];
    const typedPassword = typeof options.password === 'string' && options.password !== '' ? options.password : null;
    if (typedPassword !== null)
        runtime.password = typedPassword;
    // Remembering is the default for a password the user just typed (`POST /hosts/:id/connect`
    // treats an absent `rememberPassword` as true). An explicit false means "this connection
    // only" and also forgets a previously saved record, so an unchecked box cannot leave a stale
    // secret behind. A retry or auto-reconnect carries no password of its own and must not
    // re-save what the store already holds.
    runtime.savePassword = typedPassword !== null && options.rememberPassword !== false;
    runtime.forgetPassword = typedPassword !== null && options.rememberPassword === false;
    runtime.desired = 'connected';
    cancelReconnect(runtime);
    // A user-initiated connect gets a fresh retry budget and a fresh prompt history; a retry
    // that the pipeline schedules itself must keep the budget it already spent (H2).
    runtime.reconnectAttempts = 0;
    runtime.connectCancelled = false;
    // This connection starts its own log: the previous attempt's lines are gone before the
    // first line of this one, so the panel and a copied log only ever show the live attempt.
    beginConnectLog(runtime);
    ctx.progress.log(runtime, 'info', `connect: ${describeTarget(runtime.entry)} (auth=${runtime.entry.auth?.type ?? 'key'}${runtime.entry.jumpHost ? `, jump=${runtime.entry.jumpHost}` : ''})`);
    startConnectPromise(ctx, runtime);
    return { accepted: true };
}
/**
 * Start the pipeline in the background and make sure its promise never rejects: a listener
 * or a step outside the pipeline's own error handling must not become an unhandled
 * rejection that Node reports as a process-level failure (L).
 * @param ctx - service context.
 * @param runtime - host runtime.
 */
function startConnectPromise(ctx, runtime) {
    const run = connectPipeline(ctx, runtime).catch((error) => {
        ctx.progress.log(runtime, 'debug', 'connect pipeline stopped outside its error path:', messageOf(error));
    });
    runtime.connectPromise = run;
    void run.finally(() => {
        if (runtime.connectPromise === run)
            runtime.connectPromise = null;
    });
}
/** Drop the current link and connect again from scratch (the "Reconnect" button). */
export async function reconnectHost(ctx, runtime) {
    await disconnectHost(ctx, runtime, { stopRemote: false });
    cancelIdleStop(runtime);
    await disposeSsh(runtime);
    // A one-shot action cancelled by the disconnect resolves after its transport is gone; it
    // can no longer write state, but letting it settle keeps the old code out of the new run.
    await Promise.allSettled([runtime.restartPromise, runtime.reattachPromise].filter((promise) => promise && typeof promise.then === 'function'));
    return startConnect(ctx, runtime.id, {});
}
/**
 * Re-enter the pipeline after a dropped link. Lives here rather than in the
 * lifecycle module so `scheduleReconnect` stays a pure timer with a callback.
 */
async function reconnectNow(ctx, runtime) {
    if (ctx.state.disposed || runtime.desired !== 'connected')
        return;
    await disposeSsh(runtime);
    // A dropped link's retry is a new connection too: start from a clean log.
    beginConnectLog(runtime);
    startConnectPromise(ctx, runtime);
}
/** A timer callback that starts a retry: report a throw instead of leaving it unhandled (L). */
function retryNow(ctx, runtime) {
    void reconnectNow(ctx, runtime).catch((error) => {
        ctx.progress.log(runtime, 'warn', 'the automatic retry could not start:', messageOf(error));
    });
}
/**
 * Watch a transport that is still being dialled. `SshConnection` attaches its client `close`
 * handling before the handshake, so a transport that dies while a host-key prompt is parked
 * reaches this listener: the prompt is settled at once (instead of waiting for its timeout)
 * and the loss is recorded so the pipeline classifies the failure as a dropped link, not a
 * key decision (H3/M1).
 * @param runtime - host runtime.
 * @param ssh - the transport that was just created.
 */
function watchHandshakeTransport(runtime, ssh) {
    if (!ssh || typeof ssh.on !== 'function')
        return;
    ssh.on('close', () => {
        // A transport this runtime no longer dials (replaced, or disposed before a new attempt)
        // is not a lost link: its close is the teardown itself.
        if (runtime.ssh !== ssh && runtime.jumpSsh !== ssh)
            return;
        if (runtime.closing || runtime.desired !== 'connected')
            return;
        runtime.transportLost = true;
        cancelHostKeyPrompt(runtime);
    });
}
/**
 * Watch the transport that carries this connection. Attached as soon as the SSH session is
 * open (not only when the remote UI is ready): a drop during probe/bootstrap is still a
 * lost link and must be retried like any other (H3).
 */
function attachDisconnectHandler(ctx, runtime) {
    const ssh = runtime.ssh;
    if (!ssh)
        return;
    ssh.on('close', () => {
        if (runtime.closing || runtime.desired !== 'connected')
            return;
        // A newer transport already owns the link; this one is the previous attempt's.
        if (runtime.ssh !== ssh)
            return;
        runtime.transportLost = true;
        // A one-shot link action rides the same transport: losing it is the same event as a
        // dropped connection, and the action that was in flight must not write state any more.
        const live = runtime.status === 'connected' || runtime.linkBusy !== null;
        const inFlight = runtime.connectPromise !== null;
        if (!live && !inFlight)
            return;
        cancelLinkWork(runtime);
        stopRemoteHeartbeat(runtime);
        // A prompt parked on this transport can never be answered: resolve it now.
        cancelHostKeyPrompt(runtime);
        cancelConflict(runtime);
        if (live) {
            runtime.status = 'disconnected';
            runtime.phase = null;
            runtime.remote.uiReady = false;
            runtime.remote.localPort = null;
            runtime.progress = { code: 'reconnecting', params: { attempt: runtime.reconnectAttempts + 1 } };
            ctx.emitState();
            void closeTunnel(runtime);
            scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime));
            return;
        }
        // The pipeline that owns the in-flight connect reports the drop as `network` and
        // schedules the retry from one place, so it is not counted twice here (H2/H3).
        ctx.progress.log(runtime, 'warn', 'the SSH transport closed while the connection was being set up');
    });
}
/** Resolve the SSH destination from the entry + local ssh config, before dialling. */
async function resolveTargetForRuntime(ctx, runtime) {
    const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() });
    const entry = runtime.entry;
    const resolved = resolveDestination(entry.address, { configText: material.configText, home: ctx.userHome() });
    const host = resolved.host || entry.address;
    const port = entry.port && entry.port !== 22 ? entry.port : (resolved.port ?? 22);
    const knownFingerprints = findKnownHostEntries(parseKnownHosts(material.knownHostsText), host, port).map((item) => item.fingerprint);
    return {
        host,
        port,
        username: entry.username || resolved.user || null,
        identityFiles: resolved.identityFiles ?? [],
        knownFingerprints,
        jumpHost: entry.jumpHost
            ? resolveDestination(entry.jumpHost, { configText: material.configText, home: ctx.userHome() })
            : null,
        entry,
    };
}
/**
 * Open the transport: direct, or through a jump host with a forwarded stream.
 *
 * The jump host and the target are separate security contexts. Each one gets its own
 * options — its own policy, its own pin and its own `onHostKey` role — so a key confirmed
 * for one can never be checked against, or written into, the other (B1).
 */
async function openTransport(ctx, runtime, target) {
    const settings = ctx.settings();
    const auth = () => ({
        type: runtime.entry.auth?.type ?? 'key',
        keyPath: runtime.entry.auth?.keyPath ?? null,
        password: runtime.password ?? null,
    });
    const buildOptions = (resolved, role, sock) => {
        const isJump = role === 'jump';
        // A per-host policy and pin describe the saved target. A jump host only obeys the
        // global policy and, at most, a pin remembered for this session (it is not persisted).
        const hostKeyPolicy = isJump ? settings.hostKeyPolicy : (runtime.entry.hostKeyPolicy ?? settings.hostKeyPolicy);
        const resolvedPort = resolved.port ?? 22;
        const jumpPinMatches = isJump &&
            runtime.jumpFingerprint?.host === resolved.host &&
            (Number(runtime.jumpFingerprint?.port) || 22) === resolvedPort;
        const pinnedFingerprint = isJump
            ? jumpPinMatches
                ? (runtime.jumpFingerprint?.pinned ?? null)
                : null
            : (runtime.entry.pinnedFingerprint ?? null);
        return {
            host: resolved.host,
            port: resolvedPort,
            username: resolved.username ?? resolved.user ?? null,
            // The key path expands against the *user* home (`~/.ssh/...`), never against
            // DSH_HOME, so the SSH layer needs to know which one that is.
            home: ctx.userHome(),
            auth: auth(),
            identityFiles: resolved.identityFiles ?? [],
            hostKeyPolicy,
            pinnedFingerprint,
            knownHostFingerprints: resolved.knownFingerprints ?? [],
            acceptUnknownHostKey: false,
            readyTimeoutMs: settings.connectTimeoutSec * 1000 || SSH_READY_TIMEOUT_MS,
            ...(sock ? { sock } : {}),
            onHostKey: (info) => requestHostKey(ctx, runtime, info, { role, host: resolved.host, port: resolvedPort }),
        };
    };
    if (!target.jumpHost) {
        runtime.ssh = ctx.deps.sshFactory(buildOptions(target, 'target'));
        watchHandshakeTransport(runtime, runtime.ssh);
        ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host });
        captureFingerprint(ctx, runtime, await runtime.ssh.connect());
        return;
    }
    ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.jumpHost.host, jump: true });
    const jumpTarget = {
        ...target.jumpHost,
        username: target.jumpHost.user ?? target.username,
        knownFingerprints: findKnownHostEntries(parseKnownHosts((await ctx.deps.loadSshMaterial({ home: ctx.userHome() })).knownHostsText), target.jumpHost.host, target.jumpHost.port ?? 22).map((item) => item.fingerprint),
    };
    // An edited `jumpHost` is a different machine: a pin remembered for the previous jump host
    // must not make the new one fail as `host-key-changed` (review blocker 3).
    const rememberedJump = runtime.jumpFingerprint;
    const rememberedJumpPort = (Number(rememberedJump?.port) || 22) === (jumpTarget.port ?? 22);
    if (rememberedJump !== null && (!rememberedJumpPort || rememberedJump.host !== jumpTarget.host)) {
        ctx.progress.log(runtime, 'info', `the jump host changed (${rememberedJump.host ?? 'unknown'} -> ${jumpTarget.host}); forgetting its previous host key`);
        runtime.jumpFingerprint = null;
    }
    runtime.jumpSsh = ctx.deps.sshFactory(buildOptions(jumpTarget, 'jump'));
    watchHandshakeTransport(runtime, runtime.jumpSsh);
    await runtime.jumpSsh.connect();
    // The jump host's key is settled (its own context above); from here the fingerprint the host
    // card describes is the target's, which `captureFingerprint` fills once it answers.
    runtime.fingerprint = null;
    ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host, via: target.jumpHost.host });
    const stream = await runtime.jumpSsh.forwardOut(target.host, target.port ?? 22);
    runtime.ssh = ctx.deps.sshFactory(buildOptions(target, 'target', stream));
    watchHandshakeTransport(runtime, runtime.ssh);
    captureFingerprint(ctx, runtime, await runtime.ssh.connect());
}
/** Remember the session fingerprint so the host card shows it even without a pin. */
function captureFingerprint(ctx, runtime, info) {
    if (!info?.fingerprint)
        return;
    const pinned = runtime.entry.pinnedFingerprint ?? null;
    runtime.fingerprint = {
        sha256: info.fingerprint,
        keyType: info.keyType ?? 'unknown',
        status: pinned === info.fingerprint ? 'pinned' : pinned ? 'changed' : 'observed',
        pinned,
    };
    ctx.progress.log(runtime, pinned === info.fingerprint ? 'debug' : 'info', `host key ${info.keyType ?? 'unknown'}: ${info.fingerprint}${pinned === info.fingerprint ? ' (matches the pinned key)' : pinned ? ' (CHANGED from the pinned key)' : ''}`);
    ctx.emitState();
}
/**
 * Warn when the remote already runs a DSH this plugin did not start, and let the
 * user decide: stop it, keep it alongside, or cancel.
 * @returns the decision, or null when no prompt was needed.
 */
async function resolveForeignConflict(ctx, runtime, layout, profile, options = {}) {
    // Processes the user already chose to keep alongside this connection are not asked
    // about again (a local restart must not turn that choice into a prompt every time).
    const ignorePids = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).filter((pid) => isPid(pid));
    try {
        const registry = await ctx.deps.readRegistry(runtime.ssh, layout);
        const pid = Number(registry?.pid);
        if (isPid(pid) && registry?.dshHome === layout.dshHome && registry?.profile === profile)
            ignorePids.push(pid);
    }
    catch (error) {
        // swallow-ok: registry absence is normal; the scan below still finds foreign processes
        ctx.progress.log(runtime, 'debug', 'foreign DSH: registry read failed:', messageOf(error));
    }
    const found = await ctx.deps.findForeign(runtime.ssh, { ignorePids });
    const processes = found.ok === true && Array.isArray(found.processes) ? [...found.processes] : [];
    // The registry-named instance is normally ignored by the scan (it is this connection's own
    // process). When the caller cannot stop it - a pid a re-attach discovered - it still must be
    // put in front of the user: a second instance must never start silently next to it. Merge it
    // before failing open on a scan error: its identity came from /proc, not from the scan.
    const known = options.knownProcess;
    const knownPid = Number(known?.pid);
    // A pid the user already chose to keep alongside is never asked about again; the
    // registry-named pid, however, must be shown when it could not be stopped.
    const keptAlongside = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).map(Number);
    if (isPid(knownPid) &&
        !keptAlongside.includes(knownPid) &&
        !processes.some((entry) => Number(entry?.pid) === knownPid)) {
        processes.push({
            pid: knownPid,
            command: typeof known.command === 'string' && known.command !== '' ? known.command : `dsh --profile ${profile}`,
        });
    }
    if (found.ok !== true) {
        ctx.progress.log(runtime, 'debug', 'foreign DSH: scan failed:', found.reason ?? found.technical ?? 'unknown');
        // A broken scan must never allow a silent second instance: with a known live process we
        // still ask; with nothing known there is nothing to conflict with (the old behavior).
        if (processes.length === 0)
            return null;
    }
    if (processes.length === 0)
        return null;
    const pidList = processes.map((entry) => `pid ${entry.pid}`).join(', ');
    ctx.progress.log(runtime, 'warn', `foreign DSH on the remote: ${processes.length} process(es) sharing this ~/.dsh (${pidList})`);
    const decision = await askConflict(ctx, runtime, processes);
    if (decision.action === 'cancel') {
        // The user said no: retrying would ask the same question again.
        runtime.connectCancelled = true;
        throw errors.remoteDshRunning();
    }
    if (decision.action === 'alongside') {
        runtime.alongsidePids = processes.map((entry) => entry.pid).filter((pid) => isPid(pid));
        runtime.warning = {
            zh: '远端已有手工启动的 DSH；已按你的选择并存运行，两者共享 ~/.dsh，请避免同时操作同一会话。',
            en: 'A manually started DSH is already running; it was kept as you chose. Both share ~/.dsh, so avoid editing the same session in both.',
        };
        runtime.warningSource = 'alongside';
        return 'alongside';
    }
    const stopped = await ctx.deps.stopForeign(runtime.ssh, processes);
    if (stopped.ok !== true) {
        throw errors.remoteDshRunning({
            zh: '远端的手工 DSH 进程没有停下来，连接已中止。',
            en: 'The manual remote DSH process did not stop, so the connection was aborted.',
        }, {
            technical: `alive=${stopped.alive.join(',') || 'unknown'} output=${String(stopped.output ?? '').slice(0, 800)}`,
        });
    }
    runtime.alongsidePids = [];
    ctx.progress.log(runtime, 'info', `stopped ${processes.length} manual remote DSH process(es)`);
    return 'stop';
}
/** Open the loopback tunnel for one remote port; tunnel-level failures feed the liveness confirmation. */
async function openTunnelFor(ctx, runtime, remotePort) {
    // Never hand the tunnel factory a missing transport: a listener created with no SSH channel
    // would crash the host process on the first connection (see tunnel.js's own guard).
    assertTransportOpen(runtime);
    if (!isPid(remotePort) || remotePort > 65535) {
        throw errors.internal(new Error(`invalid remote port for the tunnel: ${remotePort}`));
    }
    const onError = () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel');
    const tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort, onError });
    const localPort = Number(tunnel?.localPort);
    if (!Number.isInteger(localPort) || !isPid(localPort) || localPort > 65535) {
        try {
            await tunnel?.close?.();
        }
        catch { }
        throw errors.internal(new Error(`the tunnel factory returned no usable local port (${tunnel?.localPort})`));
    }
    // The listener was created while the caller awaited the factory: a disconnect or a host
    // removal in that window must close it instead of publishing it (H4).
    try {
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
    }
    catch (error) {
        try {
            await tunnel.close();
        }
        catch { }
        throw error;
    }
    runtime.tunnel = tunnel;
    runtime.remote.localPort = localPort;
    ctx.progress.log(runtime, 'info', `tunnel open: 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}`);
    return tunnel;
}
/**
 * Record a pid this connection is allowed to stop later: it must have been launched by the
 * plugin's own start script (or adopted from a `launch` registry record) and its `/proc`
 * identity must show this DSH home and profile. Anything that fails this check is still
 * hosted and displayed, but never signalled.
 */
async function rememberLaunched(ctx, runtime, pid, layout, profile) {
    if (!isPid(pid))
        return null;
    if (!(runtime.launched instanceof Map))
        runtime.launched = new Map();
    const identity = await ctx.deps.processIdentity(runtime.ssh, pid);
    if (identity.ok !== true) {
        ctx.progress.log(runtime, 'debug', `launch: pid ${pid} identity unreadable (${identity.reason}); it will not be stopped`);
        return null;
    }
    if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
        ctx.progress.log(runtime, 'debug', `launch: pid ${pid} runs with another DSH_HOME; it will not be stopped`);
        return null;
    }
    if (!commandMatchesProfile(identity.command, profile)) {
        ctx.progress.log(runtime, 'debug', `launch: pid ${pid} does not run profile ${profile}; it will not be stopped`);
        return null;
    }
    const record = {
        startTime: identity.startTime,
        command: identity.command,
        dshHome: identity.dshHome,
    };
    runtime.launched.set(pid, record);
    runtime.bound = { pid, startTime: identity.startTime, origin: 'launch' };
    return record;
}
/**
 * Remember the remote web this connection is bound to without granting restart kill rights.
 * A re-attach (or the adoption of a re-attached record) names a process this plugin did not
 * launch: a restart must leave it running, but the user's explicit "Stop remote DSH" may stop
 * exactly this pid. The identity recorded here is what that action re-proves before signalling.
 * @param ctx - service context.
 * @param runtime - host runtime with a live transport.
 * @param pid - the bound remote web pid.
 * @param layout - remote layout.
 * @param profile - remote DSH profile.
 * @param origin - how this connection came to host the process.
 * @returns the recorded binding, or null when it cannot be proven.
 */
async function rememberBound(ctx, runtime, pid, layout, profile, origin) {
    if (!isPid(pid))
        return null;
    const identity = await ctx.deps.processIdentity(runtime.ssh, pid);
    if (identity.ok !== true) {
        ctx.progress.log(runtime, 'debug', `bind: pid ${pid} identity unreadable (${identity.reason}); it will not be stopped on request`);
        return null;
    }
    if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
        ctx.progress.log(runtime, 'debug', `bind: pid ${pid} runs with another DSH_HOME; it cannot be stopped here`);
        return null;
    }
    if (!commandMatchesProfile(identity.command, profile)) {
        ctx.progress.log(runtime, 'debug', `bind: pid ${pid} does not run profile ${profile}; it cannot be stopped here`);
        return null;
    }
    runtime.bound = { pid, startTime: identity.startTime, origin };
    return runtime.bound;
}
/**
 * The only gate that authorizes a kill. All three must hold: the registry names the pid,
 * this connection launched it, and `/proc` still proves the same process (kernel start time)
 * with the same home and profile. A reused pid, an adopted-only pid, or a process kept
 * alongside therefore never gets stopped silently.
 */
async function killAuthorized(ctx, runtime, pid, layout, profile) {
    const record = runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined;
    if (!record)
        return { ok: false, reason: 'not-launched-by-this-connection' };
    if ((Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []).includes(pid)) {
        return { ok: false, reason: 'kept-alongside' };
    }
    const identity = await ctx.deps.processIdentity(runtime.ssh, pid);
    if (identity.ok !== true)
        return { ok: false, reason: `identity-${identity.reason}` };
    if (identity.startTime !== record.startTime)
        return { ok: false, reason: 'pid-reused' };
    if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
        return { ok: false, reason: 'dsh-home-mismatch' };
    }
    if (!commandMatchesProfile(identity.command, profile))
        return { ok: false, reason: 'profile-mismatch' };
    return { ok: true };
}
/**
 * Rebuild the local listener for a host whose remote UI answers the SSH probe but whose
 * proxied requests fail: the tunnel, not the remote, is what broke. Single-flight per host and
 * owned by a link-work token, like restart/reattach: a disconnect, host removal or shutdown
 * cancels it and the caller waits for `runtime.tunnelRepair` before tearing down.
 *
 * The replacement is created before the old listener closes, so there is no window without a
 * listener. Its local port is a new random one, so `viewRev` is bumped: the carrier refetches
 * `GET /hosts/:id/open` and navigates again (the desktop guest's URL is the loopback origin).
 * Existing WebSockets/downloads are dropped by closing the old listener - documented.
 *
 * @param ctx - service context.
 * @param runtime - connected host runtime.
 * @returns whether the listener was rebuilt.
 */
export async function repairTunnel(ctx, runtime) {
    if (ctx.state.disposed === true ||
        runtime.desired !== 'connected' ||
        runtime.status !== 'connected' ||
        runtime.linkBusy !== null ||
        runtime.tunnel === null) {
        return { ok: false, reason: 'not-watchable' };
    }
    if (runtime.ssh?.connected !== true)
        return { ok: false, reason: 'no-transport' };
    if (runtime.tunnelRepair)
        return runtime.tunnelRepair;
    if (Date.now() < (Number(runtime.nextTunnelRepairAt) || 0)) {
        return { ok: false, reason: 'backoff' };
    }
    const port = runtime.remote.port;
    const previous = runtime.tunnel;
    const token = beginLinkWork(runtime, 'repair');
    const stillCurrent = () => isLinkWorkCurrent(runtime, token) &&
        ctx.state.disposed !== true &&
        runtime.desired === 'connected' &&
        runtime.status === 'connected' &&
        runtime.ssh?.connected === true;
    let created = null;
    let work = null;
    let settled = null;
    work = (async () => {
        try {
            if (runtime.ssh?.connected !== true)
                throw errors.internal(new Error('the SSH transport is gone'));
            if (!isPid(port) || port > 65535)
                throw errors.internal(new Error(`invalid remote port for the tunnel: ${port}`));
            const next = await ctx.deps.tunnelFactory({
                ssh: runtime.ssh,
                remotePort: port,
                onError: () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel'),
            });
            created = next;
            const nextPort = Number(next?.localPort);
            if (!Number.isInteger(nextPort) || !isPid(nextPort) || nextPort > 65535) {
                throw errors.internal(new Error(`the rebuilt tunnel has no usable local port (${next?.localPort})`));
            }
            if (!stillCurrent())
                return { ok: false, reason: 'cancelled' };
            // Publish the replacement before closing the old listener: no no-listener window.
            runtime.tunnel = next;
            runtime.remote.localPort = nextPort;
            try {
                await previous.close();
            }
            catch {
                // swallow-ok: the old listener could already be gone; the new one is what matters
            }
            if (!stillCurrent())
                return { ok: false, reason: 'cancelled' };
            // The local port changed, so the carrier's view of the host did too.
            runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1;
            ctx.progress.log(runtime, 'info', `tunnel rebuilt after a failed request (remote port ${port}, local port ${previous.localPort} -> ${nextPort})`);
            runtime.tunnelRepairFailures = 0;
            runtime.nextTunnelRepairAt = 0;
            ctx.emitState();
            return { ok: true };
        }
        catch (error) {
            // swallow-ok: a failed rebuild is a typed, retryable reason (with backoff) for the caller;
            // the old listener is still serving, so this is not a connection failure.
            runtime.tunnelRepairFailures = (Number(runtime.tunnelRepairFailures) || 0) + 1;
            const backoff = Math.min(REMOTE_REPAIR_BACKOFF_MAX_MS, REMOTE_REPAIR_BACKOFF_MS * 2 ** (runtime.tunnelRepairFailures - 1));
            runtime.nextTunnelRepairAt = Date.now() + backoff;
            ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error));
            return { ok: false, reason: 'rebuild-failed' };
        }
        finally {
            // A listener this rebuild created must never outlive it: on a cancelled token (or if it
            // was never published) close it here, and clear the view only when it owned the slot.
            if (created !== null && (!isLinkWorkCurrent(runtime, token) || runtime.tunnel !== created)) {
                if (runtime.tunnel === created) {
                    runtime.tunnel = null;
                    runtime.remote.localPort = null;
                }
                try {
                    await created.close();
                }
                catch { }
            }
            endLinkWork(runtime, token);
        }
    })();
    settled = work.finally(() => {
        if (runtime.tunnelRepair === settled)
            runtime.tunnelRepair = null;
    });
    runtime.tunnelRepair = settled;
    return settled;
}
/** Prove the remote UI answers through the new tunnel and exchange this launch's token. */
async function verifyRemoteUi(ctx, runtime, port, token, localPort) {
    const tunnelPort = Number(localPort);
    if (!Number.isInteger(tunnelPort) || !isPid(tunnelPort) || tunnelPort > 65535) {
        throw errors.internal(new Error(`the tunnel has no local port to verify (${localPort ?? 'none'})`));
    }
    ctx.progress.log(runtime, 'debug', `verifying the remote UI on 127.0.0.1:${tunnelPort}`);
    const ui = await ctx.deps.waitUi(runtime.ssh, port, { attempts: 20, intervalMs: 500 });
    // The probe retries for up to ten seconds: the user may have cancelled in that window, and
    // the token exchange must not touch the (possibly closed) tunnel after it (H4).
    assertStillWanted(ctx, runtime);
    assertTransportOpen(runtime);
    if (!ui.ok) {
        throw errors.remoteUiUnreachable({
            zh: `远端 DSH 的本地 127.0.0.1:${port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
            en: `The remote DSH on 127.0.0.1:${port} did not respond (HTTP ${ui.status ?? 'none'}).`,
        });
    }
    ctx.progress.log(runtime, 'debug', `remote UI answered HTTP ${ui.status}; exchanging the launch token`);
    const exchange = await ctx.deps.exchange(tunnelPort, token, {
        timeoutMs: TUNNEL_PROBE_TIMEOUT_MS,
    });
    runtime.exchange = exchange;
    if (!exchange.ok) {
        throw errors.remoteUiUnreachable({
            zh: `本地隧道完成了 token 交换，但远端界面返回 HTTP ${exchange.status}（首次状态 ${exchange.firstStatus}）。`,
            en: `The tunnel exchanged the token but the remote UI answered HTTP ${exchange.status} (first ${exchange.firstStatus}).`,
        });
    }
    return exchange;
}
/** Publish the connected state and start watching the remote for its own restarts. */
function markConnected(ctx, runtime) {
    // A live link is not idle: no idle-stop timer may survive the attach (review blocker 1).
    cancelIdleStop(runtime);
    // Only a success resets the retry budget: a failed attempt must spend it (H2).
    runtime.reconnectAttempts = 0;
    runtime.connectCancelled = false;
    runtime.status = 'connected';
    runtime.phase = 'ready';
    runtime.progress = { code: 'ready' };
    runtime.error = null;
    runtime.remote.uiReady = true;
    // Every attach invalidates the previous launch URL / cookie: the Client re-navigates its carrier.
    runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1;
    // A fresh attach is a new listener budget: an old rebuild failure must not keep it in backoff.
    runtime.tunnelRepairFailures = 0;
    runtime.nextTunnelRepairAt = 0;
    // A successful attach makes a previous "stop not confirmed" warning stale. An alongside
    // warning keeps describing a process that is still running, so it is not cleared here.
    if (runtime.warningSource === 'restart-stop') {
        runtime.warning = null;
        runtime.warningSource = null;
    }
    startRemoteHeartbeat(ctx, runtime);
    ctx.emitState();
}
/** Bounded diagnostics trail of restarts and re-attached ports (never sent to the client). */
function recordRestart(runtime, entry) {
    const history = Array.isArray(runtime.restarts) ? runtime.restarts : [];
    history.push({ at: nowIso(), ...entry });
    runtime.restarts = history.slice(-10);
}
/**
 * Persist (or forget) the SSH password now that the transport accepted it. Doing this right
 * after the handshake rather than after `connected` keeps a credential the server already
 * proved even when a later bootstrap step fails, so the next attempt does not ask again.
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @param log - connect log writer.
 */
async function settlePasswordStorage(ctx, runtime, log) {
    const save = runtime.savePassword === true;
    const forget = runtime.forgetPassword === true;
    runtime.savePassword = false;
    runtime.forgetPassword = false;
    if (!ctx.secrets || typeof runtime.password !== 'string' || runtime.password === '')
        return;
    if (save) {
        runtime.passwordSaved = await ctx.secrets.set(runtime.id, runtime.password);
        if (runtime.passwordSaved)
            log('debug', 'saved the SSH password in the credential store');
        else
            log('warn', 'could not save the SSH password in the credential store');
        return;
    }
    if (forget) {
        const removed = await ctx.secrets.remove(runtime.id);
        runtime.passwordSaved = !removed;
    }
}
async function connectPipeline(ctx, runtime) {
    const log = (level, ...args) => ctx.progress.log(runtime, level, ...args);
    const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params);
    runtime.closing = false;
    // NOTE: `reconnectAttempts` is deliberately NOT reset here. A retry re-enters this function
    // and must keep spending the budget `scheduleReconnect` counts; only a user-initiated
    // connect (startConnect) and a successful attach reset it (H2).
    // The literal would narrow the property to `false` for the rest of this function, hiding the
    // `true` `attachDisconnectHandler` may have set meanwhile: `as boolean` keeps the field's type.
    runtime.transportLost = false;
    runtime.alongsidePids = [];
    // Kill rights belong to this connection: a fresh connect starts with no launched pids.
    runtime.launched = new Map();
    runtime.bound = null;
    runtime.tunnelRepairFailures = 0;
    runtime.nextTunnelRepairAt = 0;
    stopRemoteHeartbeat(runtime);
    ctx.progress.set(runtime, { status: 'connecting', error: null, warning: null });
    let remoteStarted = false;
    let layout = null;
    // Whether the SSH transport ever came up during this attempt: a link that was up and then
    // dropped is a connection event and is retried like one (H3).
    let transportUp = false;
    try {
        const target = await resolveTargetForRuntime(ctx, runtime);
        assertStillWanted(ctx, runtime);
        const viaJump = target.jumpHost ? ` via ${target.jumpHost.host}` : '';
        log('debug', `target resolved: ${target.username ?? '(default)'}@${target.host}:${target.port}${viaJump}`);
        // A password-auth host may have one remembered: load it before the transport
        // is opened, so reconnect and background retries work without a prompt.
        if (runtime.entry.auth?.type === 'password' && !runtime.password && ctx.secrets) {
            const remembered = await ctx.secrets.get(runtime.id);
            if (remembered) {
                runtime.password = remembered;
                runtime.passwordSaved = true;
            }
            assertStillWanted(ctx, runtime);
        }
        phase('ssh', 'ssh-connecting', { host: runtime.entry.name });
        // An idle host keeps its SSH session for a fast resume; this attempt replaces it, so the
        // old one is released here instead of being overwritten (and leaked) by openTransport.
        if (runtime.ssh !== null || runtime.jumpSsh !== null) {
            log('debug', 'releasing the transport kept by the idle policy before dialling again');
            await disposeSsh(runtime);
            assertStillWanted(ctx, runtime);
        }
        await openTransport(ctx, runtime, target);
        // The transport is the link from here on: a drop during probe/bootstrap is a lost
        // connection too, so the close handler is attached before the remaining steps (H3).
        attachDisconnectHandler(ctx, runtime);
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        transportUp = true;
        log('info', `SSH connected to ${target.host}:${target.port} as ${target.username ?? '(default)'} (fingerprint ${runtime.fingerprint?.sha256 ?? 'unknown'})`);
        // SSH accepted the credential: this is the point the password is proven, before any
        // bootstrap step can fail and force the user to type it again.
        await settlePasswordStorage(ctx, runtime, log);
        assertStillWanted(ctx, runtime);
        phase('probe', 'probing');
        let facts = await ctx.deps.probe(runtime.ssh);
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        const freeGb = Math.round(Number(facts.diskFreeKb ?? 0) / 1_048_576);
        log('debug', `probe: ${facts.os}/${facts.arch} · ${String(facts.osName ?? 'unknown OS')} · node ${facts.nodeVersion ?? 'not found'} · ${freeGb} GB free`);
        // The runtime always runs on a plugin-owned Node (`~/.dsh/remote-go/node`),
        // whether or not the remote already has one: a shared system/nvm Node is
        // exactly what makes "works for my other project" break the remote DSH.
        // There is no system fallback on purpose, so this failure is the connection's.
        const profile = ctx.settings().bootstrap.profile;
        const managedVersion = managedNodeVersionFromEngine(ctx.engineNodeRange());
        // A probe that did not report $HOME cannot address the remote layout: `remoteLayout`
        // throws instead of building a literal-tilde path (H1).
        const nodeLayout = layoutForRuntime({ facts });
        log('info', `managed Node: expecting v${managedVersion} in ${nodeLayout.nodeDir}`);
        const managed = await ctx.deps.ensureNode(runtime.ssh, {
            facts,
            layout: nodeLayout,
            version: managedVersion,
            onProgress: (event) => ctx.progress.nodeProgress(runtime, event),
        });
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        // The probe above reported every field, so the merged object is a full `RemoteFacts`; the
        // helper's own return type stays `Partial` because it also accepts a partial input.
        facts = applyManagedNodeFacts(facts, managed);
        log('info', `managed Node ${managed.version}${managed.installed ? ' installed' : ' reused'} at ${managed.nodeBinDir}`);
        runtime.facts = facts;
        const targetVersion = ctx.localVersion();
        if (!targetVersion) {
            throw errors.invalidInput('version', {
                zh: '无法确定本机 DSH 版本，无法用 npx 固定同版本启动远端。请从 DSH 界面启动本插件，让 Host 读到本机版本。',
                en: 'The local DSH version is unknown, so the remote cannot be pinned to the same version. Start the plugin from the DSH UI so the Host can read the local version.',
            });
        }
        const plan = ctx.deps.plan({ facts, targetVersion, profile });
        log('info', `runtime plan ${plan.level}: ${plan.reason.en}`);
        phase('start', 'starting-remote', { level: plan.level });
        layout = layoutForRuntime(runtime);
        let webInfo = null;
        // Adopt an instance left running by a previous local process (keep-alive).
        // Checked before the npx preflight: an adoptable instance should not require
        // registry access just to reconnect.
        try {
            const adopted = await ctx.deps.adopt(runtime.ssh, layout, { profile });
            const adoptedVersion = adopted?.version ? normalizeVersion(adopted.version) : null;
            if (adopted && (!adoptedVersion || versionsEqual(adoptedVersion, targetVersion))) {
                webInfo = { ...adopted, logPath: layout.logFile, startedAt: nowIso(), rawLine: '' };
                log('info', `adopted running remote web pid=${adopted.pid} port=${adopted.port}`);
                // Only a record written by a launch script proves the process is ours to stop; a
                // re-attached record is hosted, not owned (B1). It is still the instance this
                // connection is bound to, so the explicit "Stop remote DSH" may stop it by identity.
                if (adopted.origin !== 'reattach')
                    await rememberLaunched(ctx, runtime, adopted.pid, layout, profile);
                else
                    await rememberBound(ctx, runtime, adopted.pid, layout, profile, 'reattach');
            }
            else if (adopted && adopted.origin !== 'reattach') {
                log('info', `running remote web version ${adoptedVersion} != ${targetVersion}; stopping it and starting a matching instance`);
                // The old process owns the same `~/.dsh` profile; leaving it running next
                // to the new one would share session files with a stale version.
                try {
                    await ctx.deps.stopWeb(runtime.ssh, layout, { pid: adopted.pid });
                }
                catch (error) {
                    log('warn', 'could not stop the stale remote web:', messageOf(error));
                }
            }
            else if (adopted) {
                log('warn', `running remote web version ${adoptedVersion} != ${targetVersion}, but it was only re-attached; leaving it running`);
            }
            else {
                log('debug', 'adopt: no running remote web to reuse');
            }
        }
        catch (error) {
            log('debug', 'adopt check failed:', messageOf(error));
        }
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        if (!webInfo) {
            // The registry row we refused to adopt (stale launch marker, unresponsive
            // HTTP, ...) still names a process on this ~/.dsh profile. Starting a second
            // one would let two clients write the same session files. A record written by a
            // re-attach names a process this plugin did not launch, so it is never stopped here.
            const leftover = await ctx.deps.readRegistry(runtime.ssh, layout);
            assertStillWanted(ctx, runtime);
            const leftoverPid = Number(leftover?.pid ?? 0);
            if (leftover?.origin === 'reattach') {
                log('info', `leaving a re-attached remote web instance alone (pid ${leftoverPid || 'unknown'})`);
            }
            else if (leftover?.dshHome === layout.dshHome && leftover?.profile === profile && isPid(leftoverPid)) {
                try {
                    await ctx.deps.stopWeb(runtime.ssh, layout, { pid: leftoverPid });
                    log('info', `stopped a non-adoptable remote web instance pid=${leftoverPid}`);
                }
                catch (error) {
                    log('warn', 'could not stop the non-adoptable remote web:', messageOf(error));
                }
            }
            await resolveForeignConflict(ctx, runtime, layout, profile);
            assertStillWanted(ctx, runtime);
            assertTransportOpen(runtime);
            phase('bootstrap', 'bootstrapping', { level: plan.level });
            // Resolve the exact package in the foreground first: a cold npx download
            // belongs in the connect error, not in a detached process that only leaves a
            // log behind. This also warms the cache for the real start below.
            log('info', `npx preflight: resolving @deepseek-ai/dsh@${plan.start.targetVersion}`);
            const onStdout = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion);
            const onStderr = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion);
            await ctx.deps.preflight(runtime.ssh, plan, { onStdout, onStderr });
            assertStillWanted(ctx, runtime);
            assertTransportOpen(runtime);
            log('info', `npx preflight ready: @deepseek-ai/dsh@${plan.start.targetVersion}`);
            phase('start', 'starting-remote', { level: plan.level });
            webInfo = await ctx.deps.startWeb(runtime.ssh, {
                plan,
                layout,
                profile,
                timeoutMs: REMOTE_START_TIMEOUT_MS,
                onLine: (line) => log('debug', `remote: ${line}`),
            });
            log('info', `remote DSH started: pid ${webInfo.pid ?? '?'}, port ${webInfo.port}`);
        }
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        if (webInfo.browserCarrier === 'patched') {
            log('info', 'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch');
        }
        remoteStarted = true;
        // Only the instance launched by this connection's start script may be stopped later;
        // an adopted one was already recorded above only when its record proves a launch.
        if (webInfo.adopted !== true)
            await rememberLaunched(ctx, runtime, webInfo.pid, layout, profile);
        assertStillWanted(ctx, runtime);
        runtime.token = webInfo.token;
        runtime.remote = {
            version: targetVersion,
            uiReady: false,
            localPort: null,
            port: webInfo.port,
            pid: webInfo.pid ?? null,
            dshHome: layout.dshHome,
            profile,
            bootstrapLevel: plan.level,
            nodeVersion: facts.nodeVersion,
            nodeSource: 'managed',
            startedAt: webInfo.startedAt ?? nowIso(),
            viewRev: Number(runtime.remote.viewRev) || 0,
        };
        phase('tunnel', 'tunneling');
        const tunnel = await openTunnelFor(ctx, runtime, webInfo.port);
        assertStillWanted(ctx, runtime);
        phase('verifying', 'verifying');
        await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token, tunnel.localPort);
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        // The remote UI is reachable both ways: the desktop half hands the loopback origin to a
        // Chromium guest, and the browser half frames it through the same-origin proxy (which strips
        // any X-Frame-Options). Either way this exchange proves the launch token works.
        runtime.remote.uiReady = true;
        await ctx.store.patchHost(runtime.id, { lastOpenedAt: nowIso() });
        // The store write is an await: the user may have disconnected or deleted the host while
        // it was in flight, and a late write must not resurrect the link (H4).
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        runtime.entry = ctx.store.getHost(runtime.id) ?? runtime.entry;
        if (ctx.settings().saveTokens) {
            await ctx.store.saveToken(runtime.id, webInfo.token);
            assertStillWanted(ctx, runtime);
        }
        // Last gate before publishing: never report a connected host that the user just removed
        // or disconnected (H4), and never dereference a tunnel this pipeline no longer owns.
        assertStillWanted(ctx, runtime);
        assertTransportOpen(runtime);
        ctx.state.activeHostId = runtime.id;
        markConnected(ctx, runtime);
        const localPort = runtime.tunnel?.localPort ?? runtime.remote.localPort ?? '?';
        log('info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${localPort}`);
    }
    catch (error) {
        // Phase is cleared with the status; capture it first so the log says where it stopped.
        const failedPhase = runtime.phase;
        // The transport was up earlier in this attempt and is gone now: the link dropped, which
        // is what the retry policy exists for, even while the remote was still being set up (H3).
        const droppedTransport = runtime.transportLost === true || (transportUp === true && runtime.ssh?.connected !== true);
        const cancelled = error instanceof LinkCancelled || linkTaken(ctx, runtime);
        if (cancelled) {
            // A user-initiated disconnect/teardown (or a host removal) resolved a pending prompt or
            // cancelled the link while the pipeline was in flight: this is not a failure.
            runtime.error = null;
            runtime.status = 'disconnected';
            runtime.phase = null;
            runtime.progress = null;
            log('info', 'connect cancelled by disconnect');
        }
        else {
            const view = normalizeConnectFailure(runtime, error);
            runtime.error = view;
            runtime.status = 'error';
            runtime.phase = null;
            runtime.progress = null;
            // The log has to explain the failure on its own: every line the card shows, plus the
            // redacted technical detail (and the remote log tail for a failed remote start).
            ctx.progress.logFailure(runtime, view, { phase: failedPhase });
        }
        runtime.remote.uiReady = false;
        runtime.remote.localPort = null;
        await teardownRuntime(ctx, runtime, {
            stopRemote: remoteStarted && runtime.entry.keepAlive === 'stop',
            keepRemote: remoteStarted && runtime.entry.keepAlive !== 'stop',
        });
        // One place decides whether a failed attempt is retried, and the budget lives in
        // `scheduleReconnect` (H2). A user's "no" (host-key/conflict prompt) is final, and a
        // first manual connect that never reached the remote is reported instead of looping.
        if (!cancelled) {
            const retryable = runtime.error?.retryable !== false && runtime.connectCancelled !== true;
            const repairAttempt = (Number(runtime.reconnectAttempts) || 0) > 0;
            runtime.connectCancelled = false;
            if (retryable && (repairAttempt || droppedTransport))
                scheduleConnectRetry(ctx, runtime);
        }
        ctx.emitState();
    }
    finally {
        runtime.connectPromise = null;
    }
}
/**
 * Arm the next automatic attempt after a failed connect/reconnect; `scheduleReconnect`
 * owns the settings gate and the attempt budget, so a spent budget is reported once.
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime.
 */
function scheduleConnectRetry(ctx, runtime) {
    if (ctx.state.disposed === true || runtime.desired !== 'connected')
        return;
    if (!runtime.entry.autoReconnect || !ctx.settings().autoReconnect.enabled)
        return;
    scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime));
}
async function readRegistryQuietly(ctx, runtime, layout) {
    try {
        return await ctx.deps.readRegistry(runtime.ssh, layout);
    }
    catch (error) {
        // swallow-ok: registry absence only means the restart cannot attribute the running pid
        ctx.progress.log(runtime, 'debug', 'restart: registry read failed:', messageOf(error));
        return null;
    }
}
/**
 * Recompute the launch plan from the probe facts the connection already recorded. A
 * restart reuses the same managed Node, profile and pinned version, so `[ssh]`,
 * `[probe]` and `[bootstrap]` are deliberately not run again.
 */
function planForRuntime(ctx, runtime, profile) {
    const facts = runtime.facts;
    const targetVersion = ctx.localVersion();
    if (!facts || !targetVersion) {
        throw errors.internal(new Error('the connected host has no recorded probe facts or local version'));
    }
    return { plan: ctx.deps.plan({ facts, targetVersion, profile }), targetVersion, facts };
}
/** Put a host back into its connected state without pretending the launch URL changed. */
function resumeConnected(ctx, runtime) {
    // A late action must never resurrect a link that was torn down or replaced while it waited:
    // the token is checked by callers, and these are the other three proofs that it still exists.
    if (runtime.desired !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null)
        return false;
    runtime.status = 'connected';
    runtime.phase = 'ready';
    runtime.progress = { code: 'ready' };
    runtime.error = null;
    runtime.remote.uiReady = true;
    startRemoteHeartbeat(ctx, runtime);
    ctx.emitState();
    return true;
}
/**
 * Restart the managed remote web on the same SSH transport: stop the pid the run
 * registry names, `[start]` again on the same plan, rebuild the tunnel for the new
 * random port and verify. `[ssh]` / `[probe]` / `[bootstrap]` are not re-run, so a
 * password or host-key prompt can never appear here.
 *
 * Only the instance this connection launched is stopped; a process the plugin did
 * not start goes through the ordinary conflict prompt instead of being killed.
 *
 * Available while connected, and also from the `remote-unreachable` error state: that
 * state deliberately keeps the SSH transport so the user can restart exactly when a
 * remote re-attach found nothing to adopt (docs/design.md §5.6).
 *
 * @param ctx - service context.
 * @param runtime - host runtime with a live transport.
 * @returns whether the restart started.
 */
export async function restartHost(ctx, runtime) {
    await ctx.init();
    if (runtime.connectPromise || runtime.linkBusy !== null)
        return { accepted: false, reason: 'busy' };
    const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null;
    const recoverable = runtime.status === 'error' &&
        runtime.error?.code === 'remote-unreachable' &&
        runtime.ssh?.connected === true &&
        runtime.facts !== null;
    if (!connected && !recoverable) {
        throw errors.restartUnavailable();
    }
    const token = beginLinkWork(runtime, 'restart');
    const work = runRestart(ctx, runtime, token);
    runtime.restartPromise = work;
    void work.finally(() => {
        endLinkWork(runtime, token);
        if (runtime.restartPromise === work)
            runtime.restartPromise = null;
    });
    return { accepted: true };
}
async function runRestart(ctx, runtime, token) {
    const log = (level, ...args) => ctx.progress.log(runtime, level, ...args);
    const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params);
    const layout = layoutForRuntime(runtime);
    const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile;
    const previousPort = runtime.remote.port;
    // Restarting from the remote-unreachable error state has no tunnel to keep.
    const hadTunnel = runtime.tunnel !== null;
    let killable = false;
    let stoppedOwn = false;
    let started = false;
    let tunnelCreated = false;
    try {
        stopRemoteHeartbeat(runtime);
        cancelIdleStop(runtime);
        log('info', `restart requested (pid=${runtime.remote.pid ?? 'unknown'}, remote port=${previousPort ?? 'unknown'})`);
        ctx.progress.set(runtime, { status: 'connecting', error: null, phase: 'start' });
        phase('start', 'restarting-remote', { pid: Number(runtime.remote.pid) || 0, port: Number(previousPort) || 0 });
        // Whether the running pid is ours to stop needs three independent proofs: the registry
        // names it, this connection launched it, and /proc still shows the same process. A pid that
        // a re-attach discovered (or one kept alongside) is hosted, never killed.
        const registry = await readRegistryQuietly(ctx, runtime, layout);
        const managedPid = Number(runtime.remote.pid ?? 0);
        const registeredPid = Number(registry?.pid ?? 0);
        const registered = registry !== null &&
            registry.dshHome === layout.dshHome &&
            registry.profile === profile &&
            isPid(managedPid) &&
            registeredPid === managedPid;
        if (registered) {
            const verdict = await killAuthorized(ctx, runtime, managedPid, layout, profile);
            killable = verdict.ok === true;
            if (!killable) {
                log('warn', `restart: not stopping pid ${managedPid} (${verdict.reason}); only a process this connection launched is stopped`);
            }
        }
        else {
            log('warn', `restart: the run registry does not name this connection's pid (${isPid(managedPid) ? managedPid : 'unknown'}); leaving the running instance alone`);
        }
        // A live instance this connection cannot stop and did not launch (typically the pid a
        // re-attach discovered) still occupies this ~/.dsh + profile. It goes through the conflict
        // prompt: restarting must never start a second instance silently next to it
        // (docs/design.md §5.5). Pids this connection launched are its own current instance; the
        // registry mismatch is the caller's existing "leave it alone" behavior, not a foreign one.
        let knownProcess = null;
        const launchedHere = runtime.launched instanceof Map && runtime.launched.has(managedPid);
        if (!killable && !launchedHere && isPid(managedPid) && runtime.ssh?.connected === true) {
            const identity = await ctx.deps.processIdentity(runtime.ssh, managedPid);
            if (identity.ok === true) {
                const sameHome = identity.dshHome === '' || identity.dshHome === layout.dshHome;
                if (sameHome && commandMatchesProfile(identity.command, profile)) {
                    knownProcess = { pid: managedPid, command: identity.command };
                }
            }
            else if (identity.reason === 'unreadable') {
                // Alive but not provable: asking is safer than starting a second instance.
                knownProcess = { pid: managedPid, command: `dsh --profile ${profile}` };
            }
        }
        if (!isLinkWorkCurrent(runtime, token))
            return;
        // Ask about foreign instances BEFORE anything is stopped: cancelling the prompt must not
        // destroy the instance the user is currently connected to (docs/design.md §5.5).
        const decision = await resolveForeignConflict(ctx, runtime, layout, profile, {
            ignoredPids: Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : [],
            knownProcess,
        });
        if (!isLinkWorkCurrent(runtime, token))
            return;
        // The prompt stopped the instance this connection was attached to: the old attachment is
        // gone, so a later failure must not "resume" it.
        if (decision === 'stop')
            stoppedOwn = true;
        if (killable) {
            const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid: managedPid });
            // A stop can take seconds; the link may have been dropped or replaced in the meantime.
            // A late action must not write warning/connected state on top of that.
            if (!isLinkWorkCurrent(runtime, token))
                return;
            stoppedOwn = stopped?.ok === true;
            if (stoppedOwn) {
                log('info', `restart: stopped the managed remote web pid=${managedPid}`);
                if (runtime.launched instanceof Map)
                    runtime.launched.delete(managedPid);
            }
            else {
                // Never start a second instance next to one whose stop was not confirmed. The old
                // tunnel is still open, so the host stays usable and the user can retry.
                runtime.warning = {
                    zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
                    en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
                };
                runtime.warningSource = 'restart-stop';
                log('warn', `restart: the managed remote web did not confirm its stop; not launching a second instance (${String(stopped?.output ?? '').slice(0, 300) || 'no output'})`);
                if (resumeConnected(ctx, runtime))
                    return;
                // The link changed under us, or there was no tunnel to keep (restart from the error
                // state): never publish a fake "connected" state; explain instead of staying stuck.
                if (isLinkWorkCurrent(runtime, token) && runtime.status === 'connecting') {
                    const view = toErrorView(errors.restartUnavailable({
                        zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试。',
                        en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly.',
                    }));
                    runtime.error = view;
                    runtime.status = 'error';
                    runtime.phase = null;
                    runtime.progress = null;
                    runtime.remote.uiReady = false;
                    ctx.progress.logFailure(runtime, view, { phase: 'start' });
                    ctx.emitState();
                }
                return;
            }
        }
        if (!isLinkWorkCurrent(runtime, token))
            return;
        const { plan, targetVersion, facts } = planForRuntime(ctx, runtime, profile);
        phase('start', 'restarting-remote', { level: plan.level });
        log('info', `restart: launching @deepseek-ai/dsh@${plan.start.targetVersion} with profile ${profile}`);
        const webInfo = await ctx.deps.startWeb(runtime.ssh, {
            plan,
            layout,
            profile,
            timeoutMs: REMOTE_START_TIMEOUT_MS,
            onLine: (line) => log('debug', `remote: ${line}`),
        });
        started = true;
        if (!isLinkWorkCurrent(runtime, token))
            return;
        await rememberLaunched(ctx, runtime, webInfo.pid, layout, profile);
        if (webInfo.browserCarrier === 'patched') {
            log('info', 'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch');
        }
        log('info', `restart: remote DSH started pid ${webInfo.pid ?? '?'}, port ${webInfo.port}`);
        const record = buildRunRegistryRecord({
            pid: webInfo.pid,
            port: webInfo.port,
            version: targetVersion,
            profile,
            dshHome: layout.dshHome,
            startedAt: webInfo.startedAt,
        });
        const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record);
        if (written.ok === true)
            log('info', `restart: run registry refreshed (pid ${record.pid}, port ${record.port})`);
        else
            log('warn', 'restart: the run registry could not be refreshed:', written.output);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        // The remote picked a random port again, so the old tunnel points at a dead port.
        phase('tunnel', 'tunneling');
        await closeTunnel(runtime);
        runtime.token = webInfo.token;
        runtime.remote = {
            ...runtime.remote,
            version: targetVersion,
            uiReady: false,
            localPort: null,
            port: webInfo.port,
            pid: webInfo.pid ?? null,
            dshHome: layout.dshHome,
            profile,
            bootstrapLevel: plan.level,
            nodeVersion: facts.nodeVersion,
            nodeSource: 'managed',
            startedAt: webInfo.startedAt ?? nowIso(),
        };
        const tunnel = await openTunnelFor(ctx, runtime, webInfo.port);
        tunnelCreated = true;
        if (!isLinkWorkCurrent(runtime, token))
            return;
        phase('verifying', 'verifying');
        await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token, tunnel.localPort);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        if (ctx.settings().saveTokens)
            await ctx.store.saveToken(runtime.id, webInfo.token);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        recordRestart(runtime, {
            kind: 'local-restart',
            fromPort: previousPort,
            toPort: webInfo.port,
            pid: webInfo.pid ?? null,
        });
        markConnected(ctx, runtime);
        log('info', `restart: connected again on 127.0.0.1:${runtime.tunnel?.localPort ?? tunnel.localPort} (remote port ${previousPort} -> ${webInfo.port})`);
    }
    catch (error) {
        if (!isLinkWorkCurrent(runtime, token)) {
            log('debug', 'restart aborted: the link was replaced by a disconnect or reconnect');
            return;
        }
        // Nothing this connection owned was stopped, so the previous attachment is still
        // valid: cancelling a conflict prompt (or a failed relaunch) keeps the host usable.
        if (!stoppedOwn && !started && hadTunnel && runtime.ssh?.connected === true && runtime.tunnel !== null) {
            log('warn', `restart cancelled: ${messageOf(error)}; keeping the current remote instance`);
            resumeConnected(ctx, runtime);
            return;
        }
        const view = error instanceof LinkCancelled
            ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during restart' }))
            : toErrorView(error);
        // Phase is cleared with the status; capture it first so the log says where it stopped.
        const failedPhase = runtime.phase;
        runtime.error = view;
        runtime.status = 'error';
        runtime.phase = null;
        runtime.progress = null;
        runtime.remote.uiReady = false;
        runtime.remote.localPort = null;
        // #68: a failed restart explains itself (phase, code, reason, hints, redacted details).
        ctx.progress.logFailure(runtime, view, { phase: failedPhase });
        await teardownRuntime(ctx, runtime, { stopRemote: started && runtime.entry.keepAlive === 'stop' });
        ctx.emitState();
    }
    finally {
        // A listener this action created must never outlive the action: a disconnect (or a host
        // removal) during the rebuild would otherwise leave it open with a disposed SSH channel.
        if (tunnelCreated && !isLinkWorkCurrent(runtime, token))
            await closeTunnel(runtime);
        endLinkWork(runtime, token);
    }
}
/**
 * The explicit "stop remote DSH" authorization. A restart must never stop a process this
 * plugin did not launch; here the user is pointing at the instance this connection is bound
 * to, so a re-attached pid is stoppable too - with the same `/proc` proofs, re-read now:
 *
 * - the pid must be the one this connection is bound to (`remote.pid`);
 * - it must stay out of `alongsidePids` (the user asked to keep it);
 * - this connection must have recorded it: launched it, or bound to it after a re-attach;
 * - `run/web.json` must still name that pid with the same DSH home and profile;
 * - `/proc/<pid>` must still be the same process (kernel start time), same home, same profile.
 *
 * A pid that is already gone is not an error for this action: the caller clears the stale
 * registry and releases the link, which is exactly what "stop" means in that state.
 *
 * @param ctx - service context.
 * @param runtime - connected (or remote-unreachable) host runtime.
 * @param pid - the bound remote web pid.
 * @param layout - remote layout.
 * @param profile - remote DSH profile.
 * @returns the verdict.
 */
async function closeAuthorized(ctx, runtime, pid, layout, profile) {
    if (!isPid(pid))
        return { ok: false, reason: 'pid-unknown' };
    if (Number(runtime.remote.pid) !== pid)
        return { ok: false, reason: 'not-the-bound-instance' };
    if ((Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []).includes(pid)) {
        return { ok: false, reason: 'kept-alongside' };
    }
    const launched = runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined;
    const bound = runtime.bound !== null && Number(runtime.bound?.pid) === pid ? runtime.bound : null;
    const proof = launched ?? bound;
    if (!proof)
        return { ok: false, reason: 'not-launched-by-this-connection' };
    const registry = await readRegistryQuietly(ctx, runtime, layout);
    const registered = registry !== null &&
        registry.dshHome === layout.dshHome &&
        registry.profile === profile &&
        Number(registry.pid) === pid;
    if (!registered)
        return { ok: false, reason: 'registry-mismatch' };
    const identity = await ctx.deps.processIdentity(runtime.ssh, pid);
    if (identity.ok !== true) {
        // The process is gone: there is nothing to signal, only a stale registry to clear.
        if (identity.reason === 'missing')
            return { ok: false, reason: 'identity-missing' };
        return { ok: false, reason: `identity-${identity.reason}` };
    }
    if (typeof proof.startTime === 'string' && identity.startTime !== proof.startTime) {
        return { ok: false, reason: 'pid-reused' };
    }
    if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
        return { ok: false, reason: 'dsh-home-mismatch' };
    }
    if (!commandMatchesProfile(identity.command, profile))
        return { ok: false, reason: 'profile-mismatch' };
    return { ok: true };
}
/** Why the explicit stop refused, as the bilingual `ErrorView.detail` the Client renders. */
function describeStopRefusal(reason, pid) {
    const target = isPid(pid) ? `pid ${pid}` : 'pid unknown';
    switch (reason) {
        case 'kept-alongside':
            return {
                zh: `远端进程 ${target} 是你在冲突提示里选择「保留」的实例，不会被停止。`,
                en: `The remote process ${target} is the one you chose to keep alongside; it will not be stopped.`,
            };
        case 'not-launched-by-this-connection':
        case 'not-the-bound-instance':
            return {
                zh: '远端进程不是本连接启动或接管的实例，无法证明归属，因此没有停止它；可以点「重连」。',
                en: 'The remote process is not the instance this connection launched or took over, so its ownership cannot be proven and it was not stopped; use Reconnect.',
            };
        case 'registry-mismatch':
            return {
                zh: '远端 run/web.json 没有命名本连接的进程（或读不到），无法证明归属，因此没有停止它。',
                en: 'The remote run/web.json does not name this connection\u2019s process (or could not be read), so ownership cannot be proven and nothing was stopped.',
            };
        case 'pid-reused':
            return {
                zh: '这个 pid 已被另一个进程复用，不是本连接启动的 DSH；没有停止它。',
                en: 'This pid was reused by another process, not the DSH this connection launched; nothing was stopped.',
            };
        case 'dsh-home-mismatch':
        case 'profile-mismatch':
            return {
                zh: '远端进程的 DSH home / profile 与本连接不一致，没有停止它。',
                en: 'The remote process runs a different DSH home / profile than this connection; nothing was stopped.',
            };
        case 'pid-unknown':
            return {
                zh: '本连接没有记录远端 DSH 的 pid，无法定位要停止的进程。',
                en: 'This connection has no recorded remote DSH pid, so there is no process to stop.',
            };
        default:
            return {
                zh: `无法读取远端进程 ${target} 的身份（${reason}），没有停止它。`,
                en: `The identity of the remote process ${target} could not be proven (${reason}), so nothing was stopped.`,
            };
    }
}
/**
 * Stop the remote DSH this connection manages, then release the link: the tunnel closes,
 * the SSH session is released and the host lands on `disconnected` (settings and credentials
 * kept, no automatic reconnect) so the card offers Reconnect again. `run/web.json` is removed
 * by the stop itself, so the next connect starts a clean instance instead of raising the
 * "a manually started DSH is already running" conflict.
 *
 * Unlike the disconnect action this never kills a pid without an ownership proof: it reuses
 * the restart's `/proc` identity rules and additionally accepts the re-attached pid this
 * connection is bound to (docs/design.md §5.7). Available while connected and in the
 * `remote-unreachable` error state, which keeps the SSH session on purpose.
 *
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @returns the stopped pid (null when already gone).
 */
export async function stopRemoteHost(ctx, runtime) {
    await ctx.init();
    if (runtime.connectPromise || runtime.linkBusy !== null) {
        throw errors.stopRemoteUnavailable({
            zh: '这台主机正在执行另一个连接动作，请等它结束后再关闭远端 DSH。',
            en: 'This host is busy with another link action; wait for it to finish before stopping the remote DSH.',
        }, { technical: 'reason=link-busy' });
    }
    const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null;
    const recoverable = runtime.status === 'error' &&
        runtime.error?.code === 'remote-unreachable' &&
        runtime.ssh?.connected === true &&
        runtime.facts !== null;
    if (!connected && !recoverable)
        throw errors.stopRemoteUnavailable();
    const token = beginLinkWork(runtime, 'stop');
    const previous = {
        status: runtime.status,
        phase: runtime.phase,
        progress: runtime.progress,
        error: runtime.error,
        uiReady: runtime.remote.uiReady,
        localPort: runtime.remote.localPort,
    };
    try {
        return await runStopRemote(ctx, runtime, token);
    }
    catch (error) {
        const view = toErrorView(error);
        const phase = typeof runtime.phase === 'string' ? runtime.phase : previous.phase;
        if (isLinkWorkCurrent(runtime, token)) {
            if (!restoreStopState(ctx, runtime, previous) && runtime.status === 'connecting') {
                // The transport went away (or the link was replaced) while the stop was failing:
                // never publish a fake "connected" state, publish the coded failure instead.
                runtime.error = view;
                runtime.status = 'error';
                runtime.phase = null;
                runtime.progress = null;
                runtime.remote.uiReady = false;
                runtime.remote.localPort = null;
                ctx.emitState();
            }
            // The failure explains itself in the log too (phase, code, reason, hints, details).
            ctx.progress.logFailure(runtime, view, { phase, label: STOP_FAILED_LABEL });
        }
        throw error;
    }
    finally {
        endLinkWork(runtime, token);
    }
}
/** The first log line a refused/failed stop prints; `logFailure` owns the rest. */
const STOP_FAILED_LABEL = {
    zh: '关闭远端 DSH 失败',
    en: 'Stopping the remote DSH failed',
};
/** Put a host back the way it was when a stop did not happen. */
function restoreStopState(ctx, runtime, previous) {
    if (previous.status === 'error') {
        runtime.status = 'error';
        runtime.error = previous.error;
        runtime.phase = previous.phase;
        runtime.progress = previous.progress;
        runtime.remote.uiReady = previous.uiReady === true;
        runtime.remote.localPort = previous.localPort ?? null;
        ctx.emitState();
        return true;
    }
    // `resumeConnected` refuses to stage a connected state on a link that went away (or was
    // replaced) while the stop was failing; the caller reports the coded failure instead.
    return resumeConnected(ctx, runtime);
}
async function runStopRemote(ctx, runtime, token) {
    const log = (level, ...args) => ctx.progress.log(runtime, level, ...args);
    const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params);
    const layout = layoutForRuntime(runtime);
    const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile;
    const pid = Number(runtime.remote.pid ?? 0);
    const port = Number(runtime.remote.port ?? 0);
    log('info', `stop remote requested (pid=${isPid(pid) ? pid : 'unknown'}, remote port=${isPid(port) ? port : 'unknown'})`);
    // One-shot link action: the card shows a progress line and no other action may interleave.
    stopRemoteHeartbeat(runtime);
    cancelReconnect(runtime);
    cancelIdleStop(runtime);
    ctx.progress.set(runtime, { status: 'connecting', error: null, phase: 'start' });
    phase('start', 'stopping-remote', {
        pid: isPid(pid) ? pid : 0,
        port: isPid(port) ? port : 0,
    });
    const verdict = await closeAuthorized(ctx, runtime, pid, layout, profile);
    if (!isLinkWorkCurrent(runtime, token)) {
        log('debug', 'stop remote aborted: the link was replaced by a disconnect or reconnect');
        return { ok: true, pid: null };
    }
    if (verdict.ok !== true && verdict.reason !== 'identity-missing') {
        throw errors.stopRemoteUnavailable(describeStopRefusal(verdict.reason, pid), {
            technical: `reason=${verdict.reason} pid=${isPid(pid) ? pid : 'unknown'}`,
        });
    }
    if (verdict.reason === 'identity-missing') {
        // Nothing to signal: the process is already gone. Only its stale record remains, and it
        // must go away or the next connect would try to stop/adopt a dead pid.
        log('info', `stop remote: the bound remote process pid=${pid} is already gone; clearing its run registry`);
        const cleared = await ctx.deps.clearRegistry(runtime.ssh, layout);
        if (cleared?.ok !== true) {
            log('warn', 'stop remote: the stale run registry could not be cleared:', cleared?.output ?? 'no output');
        }
    }
    else {
        const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid });
        if (stopped?.ok !== true) {
            throw errors.stopRemoteUnavailable({
                zh: '远端 DSH 进程没有报告干净停止；连接保持原样，可以重试或点「重连」。',
                en: 'The remote DSH process did not report a clean stop; the connection is unchanged, so retry or use Reconnect.',
            }, { technical: String(stopped?.output ?? '').slice(0, 1200) || 'no output' });
        }
        log('info', `stop remote: stopped the managed remote web pid=${pid}`);
        if (runtime.launched instanceof Map)
            runtime.launched.delete(pid);
    }
    if (!isLinkWorkCurrent(runtime, token)) {
        log('debug', 'stop remote: the link was replaced after the stop; leaving the state to that action');
        return { ok: true, pid: isPid(pid) ? pid : null };
    }
    runtime.bound = null;
    // Reuse the single teardown path; `stopped` keeps the idle policy from arming a second stop.
    await disconnectHost(ctx, runtime, { stopRemote: false, stopped: true });
    runtime.bound = null;
    log('info', 'stop remote: the remote DSH is stopped; the host is kept and can be reconnected');
    return { ok: true, pid: isPid(pid) ? pid : null };
}
/**
 * Re-attach to a remote web that restarted on its own (plugin-market update, supervisor,
 * remote reboot): re-read the real pid/port, refresh `run/web.json`, rebuild the tunnel,
 * take the new launch token and verify. The SSH session and the host entry are untouched.
 *
 * @param ctx - service context.
 * @param runtime - host runtime the watchdog decided is unreachable.
 * @param info - why the re-attach was requested.
 * @returns whether the re-attach started.
 */
export async function reattachHost(ctx, runtime, info = {}) {
    if (runtime.status !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) {
        return { accepted: false, reason: 'not-connected' };
    }
    if (runtime.connectPromise || runtime.linkBusy !== null)
        return { accepted: false, reason: 'busy' };
    const token = beginLinkWork(runtime, 'reattach');
    const work = runReattach(ctx, runtime, info, token);
    runtime.reattachPromise = work;
    void work.finally(() => {
        endLinkWork(runtime, token);
        if (runtime.reattachPromise === work)
            runtime.reattachPromise = null;
    });
    return { accepted: true };
}
async function runReattach(ctx, runtime, info, token) {
    const log = (level, ...args) => ctx.progress.log(runtime, level, ...args);
    const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params);
    const layout = layoutForRuntime(runtime);
    const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile;
    const fromPort = runtime.remote.port;
    const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable';
    let tunnelCreated = false;
    try {
        stopRemoteHeartbeat(runtime);
        cancelReconnect(runtime);
        cancelIdleStop(runtime);
        log('info', `remote restart suspected: ${reason}; re-reading the remote state`);
        ctx.progress.set(runtime, { status: 'connecting', error: null, phase: 'start' });
        phase('start', 'restarting-remote', { reason });
        // A restart takes a moment to print its new readiness line: retry before giving up.
        const attempts = Math.max(1, Number(ctx.timers.reattachAttempts) || REMOTE_REATTACH_ATTEMPTS);
        const intervalMs = Math.max(0, Number(ctx.timers.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS) || 0);
        let resolved = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (!isLinkWorkCurrent(runtime, token))
                return;
            resolved = await ctx.deps.resolveRemote(runtime.ssh, layout, { profile });
            if (resolved?.ok === true)
                break;
            log('debug', `re-attach: remote state not ready yet (${resolved?.reason ?? 'unreadable'}), attempt ${attempt}/${attempts}`);
            if (attempt < attempts && intervalMs > 0)
                await sleep(intervalMs);
        }
        if (!isLinkWorkCurrent(runtime, token))
            return;
        // `resolved?.ok !== true` is the same test as `!resolved || resolved.ok !== true`, and it is
        // the form the compiler can narrow: with `strictNullChecks` off the disjunction's `!resolved`
        // arm widens the branch back to the whole union.
        if (resolved?.ok !== true) {
            const detail = resolved?.reason === 'no-token'
                ? {
                    zh: '远端 DSH 仍在运行，但它这次重启没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
                    en: 'The remote DSH is still running, but its restart left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
                }
                : {
                    zh: `远端 DSH 重启后没有找到可以重新挂载的实例（${resolved?.reason ?? 'unreadable'}）；主机与配置已保留。`,
                    en: `No re-attachable remote DSH instance was found after the restart (${resolved?.reason ?? 'unreadable'}); the host and its settings are kept.`,
                };
            throw errors.remoteUnreachable(detail, {
                technical: `reason=${resolved?.reason ?? 'unknown'} fromPort=${fromPort ?? 'unknown'}`,
            });
        }
        // A takeover needs the new launch token: a real DSH rejects `/?token=` and a cookie-less
        // request, so an empty token can never be treated as success (B4).
        if (typeof resolved.token !== 'string' || resolved.token === '') {
            throw errors.remoteUnreachable({
                zh: '远端 DSH 重启后没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
                en: 'The restarted remote DSH left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
            }, { technical: `reason=no-token source=${resolved.source ?? 'unknown'} port=${resolved.port ?? 'unknown'}` });
        }
        const targetVersion = ctx.localVersion();
        const remoteVersion = typeof resolved.version === 'string' && resolved.version !== '' ? normalizeVersion(resolved.version) : null;
        if (remoteVersion && targetVersion && !versionsEqual(remoteVersion, targetVersion)) {
            // A different DSH under the same ~/.dsh would show a UI that does not match this machine;
            // the user's remedy is the explicit restart, which launches the pinned version.
            throw errors.versionMismatch(targetVersion, remoteVersion);
        }
        if (remoteVersion === null) {
            log('warn', 're-attach: the running DSH version could not be proven; keeping it unknown, not assuming the local one');
        }
        // The pid that actually listens may differ from the wrapper this connection launched (npx
        // spawns the DSH). Keep the kill right only for the pid we are now attached to.
        if (runtime.launched instanceof Map) {
            for (const pid of [...runtime.launched.keys()]) {
                if (pid !== resolved.pid)
                    runtime.launched.delete(pid);
            }
        }
        log('info', `re-attach: found remote web pid=${resolved.pid} port=${resolved.port} (source=${resolved.source}); refreshing the run registry`);
        const record = buildRunRegistryRecord({
            pid: resolved.pid,
            port: resolved.port,
            // Never launder an unproven version into the registry.
            version: remoteVersion ?? '',
            profile,
            dshHome: layout.dshHome,
            origin: 'reattach',
        });
        const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record);
        if (written.ok === true)
            log('info', `re-attach: run registry refreshed (pid ${record.pid}, port ${record.port})`);
        else
            log('warn', 're-attach: the run registry could not be refreshed:', written.output);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        phase('tunnel', 'tunneling');
        await closeTunnel(runtime);
        runtime.token = resolved.token;
        runtime.remote = {
            ...runtime.remote,
            version: remoteVersion,
            uiReady: false,
            localPort: null,
            port: resolved.port,
            pid: resolved.pid,
            dshHome: resolved.dshHome ?? layout.dshHome,
            profile: resolved.profile ?? profile,
            startedAt: nowIso(),
        };
        const tunnel = await openTunnelFor(ctx, runtime, resolved.port);
        tunnelCreated = true;
        if (!isLinkWorkCurrent(runtime, token))
            return;
        phase('verifying', 'verifying');
        await verifyRemoteUi(ctx, runtime, resolved.port, resolved.token, tunnel.localPort);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        if (ctx.settings().saveTokens)
            await ctx.store.saveToken(runtime.id, resolved.token);
        if (!isLinkWorkCurrent(runtime, token))
            return;
        // The re-attached instance is now the one this connection is bound to. It stays out of
        // `launched` (a restart must not kill it), but the explicit stop action may end exactly it.
        await rememberBound(ctx, runtime, resolved.pid, layout, profile, 'reattach');
        if (!isLinkWorkCurrent(runtime, token))
            return;
        recordRestart(runtime, {
            kind: 'remote-reattach',
            fromPort,
            toPort: resolved.port,
            pid: resolved.pid,
            reason,
            source: resolved.source,
        });
        markConnected(ctx, runtime);
        log('info', `re-attached: remote ${runtime.remote.version ?? 'version unknown'} on 127.0.0.1:${runtime.tunnel?.localPort ?? tunnel.localPort} (remote port ${fromPort} -> ${resolved.port})`);
    }
    catch (error) {
        if (!isLinkWorkCurrent(runtime, token)) {
            log('debug', 're-attach aborted: the link was replaced by a disconnect or reconnect');
            return;
        }
        const view = error instanceof LinkCancelled
            ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during re-attach' }))
            : toErrorView(error);
        // Phase is cleared with the status; capture it first so the log says where it stopped.
        const failedPhase = runtime.phase;
        runtime.error = view;
        runtime.status = 'error';
        runtime.phase = null;
        runtime.progress = null;
        runtime.remote.uiReady = false;
        runtime.remote.localPort = null;
        await closeTunnel(runtime);
        stopRemoteHeartbeat(runtime);
        // #68: a failed re-attach explains itself (phase, code, reason, hints, redacted details).
        ctx.progress.logFailure(runtime, view, { phase: failedPhase });
        ctx.emitState();
    }
    finally {
        // A listener this action created must never outlive the action (see runRestart).
        if (tunnelCreated && !isLinkWorkCurrent(runtime, token))
            await closeTunnel(runtime);
        endLinkWork(runtime, token);
    }
}
