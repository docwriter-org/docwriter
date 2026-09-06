/**
 * The real supervisor (sandbox=none, auth=dev) in front of the fake app.
 * Covers sign-in, proxying with the gateway secret, direct-port rejection,
 * WebSocket and SSE passthrough, two isolated users, reap and respawn.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startSupervisor } from '../main.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT_BASE = 47000 + Math.floor(Math.random() * 500) * 2;

let sup;
let dir;
let base;

const cookieFor = async (name) => {
	const res = await fetch(`${base}/auth/login?user=${name}`, { redirect: 'manual' });
	expect(res.status).toBe(302);
	const setCookie = res.headers.get('set-cookie');
	expect(setCookie).toContain('dw_session=');
	return setCookie.split(';')[0];
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'dw-sup-'));
	sup = await startSupervisor(
		loadConfig({
			SUPERVISOR_PORT: '0',
			SUPERVISOR_SANDBOX: 'none',
			SUPERVISOR_AUTH: 'dev',
			SUPERVISOR_APP_DIR: here,
			SUPERVISOR_APP_ENTRY: 'fake-app.js',
			SUPERVISOR_DATA_DIR: dir,
			SUPERVISOR_PORT_BASE: String(PORT_BASE),
			SUPERVISOR_IDLE_SECONDS: '0',
			SUPERVISOR_RESPAWN_COOLDOWN_MS: '0',
			SUPERVISOR_KILL_GRACE_SECONDS: '2',
			SUPERVISOR_PASSTHROUGH_ENV: ''
		})
	);
	base = `http://127.0.0.1:${sup.port}`;
}, 30_000);

afterAll(async () => {
	await sup?.shutdown('test');
	rmSync(dir, { recursive: true, force: true });
});

describe('supervisor end to end (fake app)', () => {
	it('asks browsers to sign in and refuses API calls without a session', async () => {
		const html = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
		expect(html.status).toBe(401);
		expect(await html.text()).toContain('dev auth');
		const api = await fetch(`${base}/api/anything`);
		expect(api.status).toBe(401);
	});

	it('spawns a process for a signed-in user and proxies with the gateway secret', async () => {
		const cookie = await cookieFor('alice');
		const res = await fetch(`${base}/echo`, { headers: { cookie } });
		expect(res.status).toBe(200);
		const body = await res.json();
		const alice = sup.registry.get('dev:alice');
		expect(alice.uid).toBe(20001);
		const proc = sup.manager.get('dev:alice');
		expect(body.headers['x-docwriter-gateway']).toBe(proc.secret);
		expect(body.headers['x-forwarded-proto']).toBe('http');
		expect(body.headers['x-forwarded-host']).toBe(`127.0.0.1:${sup.port}`);
		expect(body.env.DOCWRITER_ROOT).toBe(join(dir, 'users', '20001', 'workspace'));
		expect(body.env.HOME).toBe(join(dir, 'users', '20001', 'home'));
		expect(body.env.PUBLIC_DOCWRITER_WS_URL).toBe('ws://localhost:8080/ws');
		expect(body.pid).toBe(proc.pid);
	});

	it('rejects direct access to the user process without the secret', async () => {
		const alice = sup.registry.get('dev:alice');
		const res = await fetch(`http://127.0.0.1:${alice.appPort}/echo`);
		expect(res.status).toBe(403);
		const ws = new WebSocket(`ws://127.0.0.1:${alice.wsPort}/`);
		await expect(new Promise((_, reject) => ws.on('error', reject).on('open', () => reject(new Error('opened')))))
			.rejects.toThrow(/401|403/);
	});

	it('proxies the WebSocket on /ws for the signed-in user only', async () => {
		const cookie = await cookieFor('alice');
		const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } });
		const reply = await new Promise((resolve, reject) => {
			ws.on('open', () => ws.send('hi'));
			ws.on('message', (m) => resolve(String(m)));
			ws.on('error', reject);
		});
		expect(reply).toBe('echo:hi');
		expect(sup.manager.get('dev:alice').wsConnections).toBe(1);
		ws.close();
		await new Promise((r) => ws.on('close', r));
		await new Promise((r) => setTimeout(r, 50));
		expect(sup.manager.get('dev:alice').wsConnections).toBe(0);

		const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`);
		await expect(new Promise((_, reject) => anon.on('error', reject))).rejects.toThrow(/401/);
	});

	it('streams server-sent events through', async () => {
		const cookie = await cookieFor('alice');
		const res = await fetch(`${base}/sse`, { headers: { cookie } });
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(await res.text()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
	});

	it('gives a second user their own process and directories', async () => {
		const cookie = await cookieFor('bob');
		const body = await (await fetch(`${base}/echo`, { headers: { cookie } })).json();
		expect(body.env.DOCWRITER_ROOT).toBe(join(dir, 'users', '20002', 'workspace'));
		expect(body.pid).not.toBe(sup.manager.get('dev:alice').pid);
		expect(sup.manager.stats().running).toBe(2);
	});

	it('reaps idle processes and respawns on the next request', async () => {
		const before = sup.manager.get('dev:alice').pid;
		await new Promise((r) => setTimeout(r, 20));
		await sup.manager.reapIdle();
		expect(sup.manager.get('dev:alice')).toBeNull();
		expect(sup.manager.get('dev:bob')).toBeNull();
		const cookie = await cookieFor('alice');
		const body = await (await fetch(`${base}/echo`, { headers: { cookie } })).json();
		expect(body.pid).not.toBe(before);
		expect(sup.metrics.snapshot()).toMatchObject({ spawns: 3, reaps: 2, spawn_failures: 0 });
	});

	it('serves metrics to localhost', async () => {
		const text = await (await fetch(`${base}/__supervisor/metrics`)).text();
		expect(text).toContain('docwriter_supervisor_spawns_total 3');
		expect(text).toContain('docwriter_supervisor_users_total 2');
	});
});
