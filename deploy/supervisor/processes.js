/**
 * Spawns, tracks, reaps and kills one DocWriter process per user.
 *
 * Lifecycle: starting → ready → stopping → gone. `ensureRunning` is the
 * only way in; it serialises concurrent callers for the same user on one
 * readiness promise, enforces the process cap and the per-user respawn
 * cooldown, and resolves once `/api/health` answers through the gateway
 * secret. The reaper stops processes with no WebSocket for `idleSeconds`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCommand, passwdFiles, userDirs } from './sandbox.js';
import { findAppPid } from './procfs.js';
import { info, warn, error } from './log.js';

export class CapacityError extends Error {}
export class CooldownError extends Error {}
export class SpawnError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProcessManager({
	config,
	cgroups,
	host,
	metrics,
	spawnImpl = spawn,
	fetchImpl = fetch,
	findAppPidImpl = findAppPid,
	now = Date.now
}) {
	/** @type {Map<string, any>} userId → proc */
	const procs = new Map();
	/** @type {Map<string, number>} userId → last exit time */
	const lastExit = new Map();

	function running() {
		return [...procs.values()].filter((p) => p.status !== 'stopping');
	}

	function prepareDirs(user) {
		const dirs = userDirs(config.dataDir, user.uid);
		for (const d of [dirs.root, dirs.workspace, dirs.home, dirs.etc]) mkdirSync(d, { recursive: true });
		const files = passwdFiles(user.uid);
		writeFileSync(join(dirs.etc, 'passwd'), files.passwd);
		writeFileSync(join(dirs.etc, 'group'), files.group);
		if (config.sandbox === 'bwrap' && process.getuid?.() === 0) {
			for (const d of [dirs.root, dirs.workspace, dirs.home]) chownSync(d, user.uid, user.uid);
		}
		return dirs;
	}

	async function waitReady(proc) {
		const deadline = now() + config.readyTimeoutMs;
		const url = `http://127.0.0.1:${proc.user.appPort}/api/health`;
		while (now() < deadline) {
			if (proc.exited) throw new SpawnError(`process exited during startup (code ${proc.exitCode}, signal ${proc.signal})`);
			try {
				const res = await fetchImpl(url, {
					headers: { 'x-docwriter-gateway': proc.secret },
					signal: AbortSignal.timeout(2000)
				});
				if (res.ok) return;
			} catch {
				/* not listening yet */
			}
			await sleep(250);
		}
		throw new SpawnError('process did not become ready in time');
	}

	function start(user) {
		const dirs = prepareDirs(user);
		const secret = randomBytes(24).toString('hex');
		const spec = buildCommand({ config, user, secret, dirs, host });
		const child = spawnImpl(spec.cmd, spec.args, {
			env: spec.env,
			cwd: spec.cwd,
			uid: spec.uid,
			gid: spec.gid,
			detached: true, // own process group, so a kill(-pid) reaches every descendant
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const proc = {
			user,
			secret,
			child,
			pid: child.pid,
			status: 'starting',
			startedAt: now(),
			readyAt: null,
			lastActivity: now(),
			wsConnections: 0,
			exited: false,
			exitCode: null,
			signal: null,
			ready: null
		};
		procs.set(user.id, proc);
		metrics?.inc('spawns');
		info('spawned', { user: user.login, uid: user.uid, pid: child.pid, sandbox: config.sandbox });

		const tag = `[${user.login}]`;
		for (const stream of ['stdout', 'stderr']) {
			let buf = '';
			child[stream].setEncoding('utf8');
			child[stream].on('data', (chunk) => {
				buf += chunk;
				let nl;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.trim()) process.stdout.write(`${tag} ${line}\n`);
				}
			});
		}
		child.on('error', (err) => {
			error('spawn error', { user: user.login, reason: String(err?.message ?? err) });
			proc.exited = true;
			proc.exitCode = -1;
		});
		child.on('exit', (code, signal) => {
			proc.exited = true;
			proc.exitCode = code;
			proc.signal = signal;
			proc.exitedAt = now();
			lastExit.set(user.id, proc.exitedAt);
			const oom = cgroups?.oomKills(user.uid) ?? 0;
			if (oom > 0) metrics?.inc('oom_kills');
			cgroups?.remove(user.uid);
			if (procs.get(user.id) === proc) procs.delete(user.id);
			info('exited', { user: user.login, pid: proc.pid, code, signal, status: proc.status, oom });
		});

		if (cgroups && child.pid) {
			proc.cgroupPath = cgroups.attach(user.uid, child.pid, { memoryMax: config.memoryMax, pidsMax: config.pidsMax });
		}

		proc.ready = waitReady(proc)
			.then(() => {
				proc.status = 'ready';
				proc.readyAt = now();
				metrics?.observeReady(proc.readyAt - proc.startedAt);
				info('ready', { user: user.login, pid: proc.pid, ms: proc.readyAt - proc.startedAt });
			})
			.catch(async (err) => {
				metrics?.inc('spawn_failures');
				warn('startup failed', { user: user.login, pid: proc.pid, reason: err.message });
				await stop(user.id, 'startup-failed');
				throw err;
			});
		return proc;
	}

	/** Returns the user's process once it is ready, spawning it if needed. */
	async function ensureRunning(user) {
		let proc = procs.get(user.id);
		if (proc && proc.status === 'stopping') {
			await proc.stopped;
			proc = null;
		}
		if (!proc) {
			const exitedAt = lastExit.get(user.id);
			if (exitedAt && now() - exitedAt < config.respawnCooldownMs) {
				throw new CooldownError('process restarted too recently');
			}
			if (running().length >= config.maxProcesses) {
				throw new CapacityError('at capacity');
			}
			proc = start(user);
		}
		await proc.ready;
		return proc;
	}

	/** SIGTERM the process group, then SIGKILL after the grace period. */
	function stop(userId, reason) {
		const proc = procs.get(userId);
		if (!proc || proc.exited) return Promise.resolve();
		if (proc.status === 'stopping') return proc.stopped;
		proc.status = 'stopping';
		info('stopping', { user: proc.user.login, pid: proc.pid, reason });
		if (reason === 'idle') metrics?.inc('reaps');
		proc.stopped = new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				resolve();
			};
			proc.child.once('exit', finish);
			const timer = setTimeout(() => {
				if (proc.exited) return;
				warn('force killing', { user: proc.user.login, pid: proc.pid });
				if (!cgroups?.kill(proc.user.uid)) signalGroup(proc.pid, 'SIGKILL');
			}, config.killGraceSeconds * 1000);
			// SIGTERM the Node process itself, not the whole group: under bwrap
			// the group also contains bwrap, which would die first and take
			// the app down with SIGKILL (--die-with-parent) before it flushes.
			const appPid = config.sandbox === 'none' ? proc.pid : (findAppPidImpl(proc.pid) ?? proc.pid);
			try {
				process.kill(appPid, 'SIGTERM');
			} catch {
				signalGroup(proc.pid, 'SIGTERM');
			}
		});
		return proc.stopped;
	}

	function signalGroup(pid, signal) {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				/* already gone */
			}
		}
	}

	function markActivity(userId) {
		const proc = procs.get(userId);
		if (proc) proc.lastActivity = now();
	}

	function wsOpened(userId) {
		const proc = procs.get(userId);
		if (proc) {
			proc.wsConnections += 1;
			proc.lastActivity = now();
		}
	}

	function wsClosed(userId) {
		const proc = procs.get(userId);
		if (proc) {
			proc.wsConnections = Math.max(0, proc.wsConnections - 1);
			proc.lastActivity = now();
		}
	}

	/** Which running processes are idle right now. Pure, for tests. */
	function idleProcs(at = now()) {
		return running().filter(
			(p) => p.status === 'ready' && p.wsConnections === 0 && at - p.lastActivity > config.idleSeconds * 1000
		);
	}

	async function reapIdle() {
		await Promise.all(idleProcs().map((p) => stop(p.user.id, 'idle')));
	}

	async function stopAll(reason = 'shutdown') {
		await Promise.all([...procs.keys()].map((id) => stop(id, reason)));
	}

	function get(userId) {
		return procs.get(userId) ?? null;
	}

	function stats() {
		const all = [...procs.values()];
		return {
			running: all.filter((p) => p.status === 'ready').length,
			starting: all.filter((p) => p.status === 'starting').length,
			stopping: all.filter((p) => p.status === 'stopping').length,
			wsConnections: all.reduce((n, p) => n + p.wsConnections, 0)
		};
	}

	return { ensureRunning, stop, stopAll, markActivity, wsOpened, wsClosed, idleProcs, reapIdle, get, stats };
}
