/**
 * Supervisor configuration, read once from the environment at boot.
 *
 * Every knob has a default that works for a laptop run in `dev` auth mode
 * with `SUPERVISOR_SANDBOX=none`. Production sets the public origin, the
 * GitHub OAuth app, a cookie secret, and leaves the sandbox on `bwrap`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SANDBOXES = new Set(['bwrap', 'none']);
const AUTHS = new Set(['clerk', 'github', 'dev']);

function int(value, fallback) {
	const n = parseInt(value ?? '', 10);
	return Number.isFinite(n) ? n : fallback;
}

function list(value) {
	return (value ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

export function loadConfig(env = process.env) {
	const publicOrigin = (env.SUPERVISOR_PUBLIC_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
	const originUrl = new URL(publicOrigin);
	const secure = originUrl.protocol === 'https:';

	const sandbox = env.SUPERVISOR_SANDBOX || 'bwrap';
	if (!SANDBOXES.has(sandbox)) throw new Error(`SUPERVISOR_SANDBOX must be one of ${[...SANDBOXES].join(', ')}`);

	const auth = env.SUPERVISOR_AUTH || 'github';
	if (!AUTHS.has(auth)) throw new Error(`SUPERVISOR_AUTH must be one of ${[...AUTHS].join(', ')}`);

	const appDir = resolve(env.SUPERVISOR_APP_DIR || process.cwd());
	const appEntry = resolve(appDir, env.SUPERVISOR_APP_ENTRY || 'build/index.js');
	if (!existsSync(appEntry)) throw new Error(`App entry not found: ${appEntry} (set SUPERVISOR_APP_DIR)`);

	const cookieSecret = env.SUPERVISOR_COOKIE_SECRET || '';
	if (auth === 'github' && !(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)) {
		throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for SUPERVISOR_AUTH=github');
	}
	if (auth === 'clerk' && !(env.CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY)) {
		throw new Error('CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are required for SUPERVISOR_AUTH=clerk');
	}
	if (auth !== 'dev' && cookieSecret.length < 32) {
		throw new Error('SUPERVISOR_COOKIE_SECRET must be at least 32 characters');
	}

	return {
		port: int(env.SUPERVISOR_PORT, 8080),
		bind: env.SUPERVISOR_BIND || '127.0.0.1',
		publicOrigin,
		secure,
		/** Same-origin WebSocket URL handed to every user process. */
		wsUrl: `${secure ? 'wss' : 'ws'}://${originUrl.host}/ws`,

		dataDir: resolve(env.SUPERVISOR_DATA_DIR || './data'),
		appDir,
		appEntry,
		nodePath: env.SUPERVISOR_NODE || process.execPath,

		sandbox,
		uidBase: int(env.SUPERVISOR_UID_BASE, 20000),
		portBase: int(env.SUPERVISOR_PORT_BASE, 41000),
		maxProcesses: int(env.SUPERVISOR_MAX_PROCESSES, 60),
		idleSeconds: int(env.SUPERVISOR_IDLE_SECONDS, 600),
		killGraceSeconds: int(env.SUPERVISOR_KILL_GRACE_SECONDS, 30),
		readyTimeoutMs: int(env.SUPERVISOR_READY_TIMEOUT_MS, 60_000),
		/** Minimum gap between two spawns of the same user (crash-loop brake). */
		respawnCooldownMs: int(env.SUPERVISOR_RESPAWN_COOLDOWN_MS, 10_000),
		memoryMax: env.SUPERVISOR_MEMORY_MAX || '1500M',
		pidsMax: int(env.SUPERVISOR_PIDS_MAX, 512),
		bodySizeLimit: env.SUPERVISOR_BODY_SIZE_LIMIT || '50M',
		/** Host env vars copied into every user process (API keys, model default). */
		passthroughEnv: list(env.SUPERVISOR_PASSTHROUGH_ENV || 'ANTHROPIC_API_KEY,DOCWRITER_DEFAULT_MODEL'),

		auth,
		cookieSecret,
		cookieName: 'dw_session',
		sessionDays: int(env.SUPERVISOR_SESSION_DAYS, 30),
		github: { clientId: env.GITHUB_CLIENT_ID || '', clientSecret: env.GITHUB_CLIENT_SECRET || '' },
		clerk: {
			publishableKey: env.CLERK_PUBLISHABLE_KEY || '',
			secretKey: env.CLERK_SECRET_KEY || '',
			/** Origins a Clerk token may have been issued to (its `azp` claim).
			 * Default: this deployment's public origin. Add more when the app
			 * answers on several hostnames. Set to the empty string to skip the
			 * check, which is only safe for server-minted test tokens. */
			authorizedParties:
				env.SUPERVISOR_CLERK_AUTHORIZED_PARTIES === undefined ? [publicOrigin] : list(env.SUPERVISOR_CLERK_AUTHORIZED_PARTIES)
		},
		/** File with one login (GitHub) or email (Clerk) per line. Missing or empty = everyone. */
		allowlistPath: env.SUPERVISOR_ALLOWLIST || '',
		/** Bearer token for /__supervisor/metrics; empty = localhost only. */
		metricsToken: env.SUPERVISOR_METRICS_TOKEN || ''
	};
}
