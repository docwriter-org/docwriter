import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapacityError, CooldownError, SpawnError, createProcessManager } from '../processes.js';

function fakeChild(pid) {
	const child = new EventEmitter();
	child.pid = pid;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr.setEncoding = () => {};
	return child;
}

function setup({ maxProcesses = 10, health = () => true, cooldown = 10_000 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'dw-procs-'));
	let clock = 1_000_000;
	const spawned = [];
	const killed = [];
	const realKill = process.kill;
	process.kill = (pid, sig) => killed.push([pid, sig]);
	const config = {
		sandbox: 'none',
		dataDir: dir,
		appDir: dir,
		appEntry: join(dir, 'x.js'),
		nodePath: 'node',
		wsUrl: 'ws://x/ws',
		publicOrigin: 'http://x',
		bodySizeLimit: '1M',
		passthroughEnv: [],
		maxProcesses,
		idleSeconds: 60,
		killGraceSeconds: 1,
		readyTimeoutMs: 2_000,
		respawnCooldownMs: cooldown,
		memoryMax: '1M',
		pidsMax: 10
	};
	const manager = createProcessManager({
		config,
		cgroups: null,
		host: null,
		metrics: null,
		spawnImpl: (cmd, args, opts) => {
			const child = fakeChild(100 + spawned.length);
			spawned.push({ cmd, args, opts, child });
			return child;
		},
		fetchImpl: async () => ({ ok: health() }),
		now: () => clock
	});
	const cleanup = () => {
		process.kill = realKill;
		rmSync(dir, { recursive: true, force: true });
	};
	return { manager, spawned, killed, cleanup, tick: (ms) => (clock += ms), user: (n) => ({ id: `u${n}`, login: `user${n}`, uid: 20000 + n, appPort: 41000 + 2 * n, wsPort: 41001 + 2 * n }) };
}

describe('process manager', () => {
	let s;
	afterEach(() => s?.cleanup());

	it('spawns once per user, shares the readiness wait, and reuses a ready process', async () => {
		s = setup();
		const [a, b] = await Promise.all([s.manager.ensureRunning(s.user(1)), s.manager.ensureRunning(s.user(1))]);
		expect(a).toBe(b);
		expect(s.spawned).toHaveLength(1);
		expect(a.status).toBe('ready');
		expect(s.spawned[0].opts.detached).toBe(true);
		expect(s.spawned[0].opts.env.DOCWRITER_GATEWAY_SECRET).toBe(a.secret);
		expect(await s.manager.ensureRunning(s.user(1))).toBe(a);
		expect(s.spawned).toHaveLength(1);
	});

	it('enforces the process cap', async () => {
		s = setup({ maxProcesses: 1 });
		await s.manager.ensureRunning(s.user(1));
		await expect(s.manager.ensureRunning(s.user(2))).rejects.toBeInstanceOf(CapacityError);
	});

	it('reaps idle processes and refuses an immediate respawn', async () => {
		s = setup({ cooldown: 5_000 });
		const p = await s.manager.ensureRunning(s.user(1));
		s.manager.wsOpened('u1');
		s.tick(120_000);
		expect(s.manager.idleProcs()).toHaveLength(0); // a live WebSocket keeps it
		s.manager.wsClosed('u1');
		expect(s.manager.idleProcs()).toHaveLength(0); // activity was just now
		s.tick(61_000);
		expect(s.manager.idleProcs().map((x) => x.user.id)).toEqual(['u1']);
		const reaped = s.manager.reapIdle();
		expect(s.killed).toEqual([[p.pid, 'SIGTERM']]); // the app process itself, not its group
		p.child.emit('exit', 0, null);
		await reaped;
		expect(s.manager.get('u1')).toBeNull();
		await expect(s.manager.ensureRunning(s.user(1))).rejects.toBeInstanceOf(CooldownError);
		s.tick(5_001);
		const again = await s.manager.ensureRunning(s.user(1));
		expect(again).not.toBe(p);
		expect(s.spawned).toHaveLength(2);
	});

	it('reports a process that dies before it is healthy', async () => {
		s = setup({ health: () => false });
		const pending = s.manager.ensureRunning(s.user(1));
		await new Promise((r) => setTimeout(r, 10));
		s.spawned[0].child.emit('exit', 1, null);
		await expect(pending).rejects.toBeInstanceOf(SpawnError);
		expect(s.manager.get('u1')).toBeNull();
	});
});
