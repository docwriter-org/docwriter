#!/usr/bin/env node
/**
 * DocWriter hosting supervisor.
 *
 * One process, one public port. Signs users in, gives each a sandboxed
 * DocWriter process on first request, proxies HTTP and the `/ws` WebSocket
 * to it, and stops it after ten idle minutes. See docs/contribute/hosting.mdx.
 */
import http from 'node:http';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openRegistry } from './registry.js';
import { createCgroups } from './cgroup.js';
import { probeHost } from './sandbox.js';
import { createProcessManager, CapacityError, CooldownError, SpawnError } from './processes.js';
import { createAuth } from './auth.js';
import { createClerkVerifier } from './clerk.js';
import { createMetrics } from './metrics.js';
import { proxyRequest, proxyUpgrade } from './proxy.js';
import { capacityPage, failedPage, restartingPage, startingPage } from './pages.js';
import { info, warn, error } from './log.js';

const READY_WAIT_MS = 25_000;
const REAP_INTERVAL_MS = 30_000;

export async function startSupervisor(config) {
	mkdirSync(config.dataDir, { recursive: true });
	const registry = openRegistry(join(config.dataDir, 'supervisor.db'), config);
	const metrics = createMetrics();

	let host = null;
	let cgroups = null;
	if (config.sandbox === 'bwrap') {
		if (spawnSync('bwrap', ['--version']).status !== 0) throw new Error('bwrap is not installed or not on PATH');
		host = probeHost({ lstatSync, existsSync, realpathSync }, config.nodePath);
		cgroups = createCgroups();
		cgroups.init();
	} else {
		warn('SANDBOX DISABLED: user processes are not isolated. Never run this way with real users.');
	}

	const manager = createProcessManager({ config, cgroups, host, metrics });
	const clerk = config.auth === 'clerk' ? createClerkVerifier({ ...config.clerk, publicOrigin: config.publicOrigin }) : null;
	if (clerk && config.clerk.authorizedParties.length === 0) {
		warn('SUPERVISOR_CLERK_AUTHORIZED_PARTIES is empty: Clerk tokens from any origin are accepted. Only for tests.');
	}
	const auth = createAuth({ config, metrics, clerk });

	function wantsHtml(req) {
		return (req.headers.accept ?? '').includes('text/html');
	}

	function htmlResponse(res, status, body) {
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		res.end(body);
	}

	function supervisorRoutes(req, res, url) {
		const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
		const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
		if (!(local || (config.metricsToken && token === config.metricsToken))) {
			res.writeHead(403);
			return res.end();
		}
		if (url.pathname === '/__supervisor/metrics') {
			const s = manager.stats();
			res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
			return res.end(
				metrics.render({ processes_running: s.running, processes_starting: s.starting, ws_connections: s.wsConnections, users_total: registry.all().length })
			);
		}
		if (url.pathname === '/__supervisor/healthz') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ ok: true, ...manager.stats() }));
		}
		res.writeHead(404);
		res.end();
	}

	async function ensureProc(user) {
		const reg = registry.getOrCreate(user.id, user.login);
		const started = manager.get(reg.id);
		const pending = manager.ensureRunning(reg);
		const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), started?.status === 'ready' ? 5_000 : READY_WAIT_MS));
		const result = await Promise.race([pending.then((p) => p), timeout]);
		if (result === 'timeout') {
			pending.catch(() => {}); // keep spawning in the background; the refresh will find it ready
			return { reg, proc: null };
		}
		return { reg, proc: result };
	}

	async function onRequest(req, res) {
		const url = new URL(req.url ?? '/', config.publicOrigin);
		try {
			if (url.pathname.startsWith('/__supervisor/')) return supervisorRoutes(req, res, url);
			if (await auth.handle(req, res, url)) return;
			const user = auth.userFromRequest(req);
			if (!user) {
				if (wantsHtml(req)) return auth.signInResponse(res);
				res.writeHead(401, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ error: 'sign in required' }));
			}
			const { reg, proc } = await ensureProc(user);
			if (!proc) return htmlResponse(res, 503, startingPage());
			manager.markActivity(reg.id);
			proxyRequest(req, res, {
				port: reg.appPort,
				secret: proc.secret,
				secure: config.secure,
				onError: (err) => {
					metrics.inc('proxy_errors');
					warn('proxy error', { user: reg.login, reason: String(err?.message ?? err) });
				}
			});
		} catch (err) {
			if (err instanceof CapacityError) return htmlResponse(res, 503, capacityPage());
			if (err instanceof CooldownError) return htmlResponse(res, 503, restartingPage());
			if (err instanceof SpawnError) return htmlResponse(res, 502, failedPage(err.message));
			error('request failed', { path: url.pathname, reason: String(err?.stack ?? err) });
			if (!res.headersSent) htmlResponse(res, 500, failedPage('Internal error'));
			else res.destroy();
		}
	}

	async function onUpgrade(req, socket, head) {
		const url = new URL(req.url ?? '/', config.publicOrigin);
		const reject = (status, text) => {
			socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\n\r\n`);
			socket.destroy();
		};
		try {
			const user = auth.userFromRequest(req);
			if (!user) return reject(401, 'Unauthorized');
			if (url.pathname !== '/ws') return reject(404, 'Not Found');
			const reg = registry.getOrCreate(user.id, user.login);
			const proc = await manager.ensureRunning(reg);
			manager.wsOpened(reg.id);
			proxyUpgrade(req, socket, head, {
				port: reg.wsPort,
				secret: proc.secret,
				secure: config.secure,
				onClose: () => manager.wsClosed(reg.id),
				onError: (err) => {
					metrics.inc('proxy_errors');
					warn('ws proxy error', { user: reg.login, reason: String(err?.message ?? err) });
				}
			});
		} catch (err) {
			warn('upgrade failed', { reason: String(err?.message ?? err) });
			reject(503, 'Service Unavailable');
		}
	}

	const server = http.createServer(onRequest);
	server.on('upgrade', onUpgrade);
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;
	server.requestTimeout = 0; // SSE renders can run for minutes
	await new Promise((resolve) => server.listen(config.port, config.bind, resolve));
	info('listening', { bind: config.bind, port: config.port, origin: config.publicOrigin, sandbox: config.sandbox, auth: config.auth });

	const reaper = setInterval(() => manager.reapIdle().catch((e) => error('reaper failed', { reason: String(e) })), REAP_INTERVAL_MS);

	async function shutdown(signal) {
		info('shutting down', { signal });
		clearInterval(reaper);
		server.close();
		await manager.stopAll('shutdown');
		registry.close();
	}

	return { server, manager, registry, auth, metrics, shutdown, port: server.address().port };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
	let sup;
	try {
		sup = await startSupervisor(loadConfig());
	} catch (err) {
		error('failed to start', { reason: String(err?.message ?? err) });
		process.exit(1);
	}
	for (const sig of ['SIGTERM', 'SIGINT']) {
		process.once(sig, async () => {
			await sup.shutdown(sig);
			process.exit(0);
		});
	}
}
