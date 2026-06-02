/**
 * SvelteKit server hooks — runs once at server startup.
 *
 * Handles one-shot CLI flags that are communicated via environment variables:
 *   DOCWRITER_NEW_SESSION=1   — clear the persisted SDK session ID so the
 *                               next render starts a fresh conversation.
 */
import { createClerkClient } from '@clerk/backend';
import type { Handle } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getRules, getSessionId, setSessionId } from '$lib/server/runtime-state';
import { syncRulesToClaudeMemory } from '$lib/server/claude-memory';
import { installBundledSkills } from '$lib/server/skills-install';
import { createWsServer } from '$lib/server/ws-server';

const IS_VERCEL = process.env.VERCEL === '1';
const CLERK_AUTH_REQUIRED = IS_VERCEL || process.env.CLERK_AUTH_REQUIRED === '1';

function envOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const raw = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
	try {
		return new URL(raw).origin;
	} catch {
		console.warn(`[docwriter] ignoring invalid auth origin: ${value}`);
		return undefined;
	}
}

function getClerkPublishableKey(): string | undefined {
	return process.env.PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY;
}

function missingClerkKeys(): string[] {
	const missing = [];
	if (!process.env.CLERK_SECRET_KEY) missing.push('CLERK_SECRET_KEY');
	if (!getClerkPublishableKey()) missing.push('PUBLIC_CLERK_PUBLISHABLE_KEY');
	return missing;
}

function isStaticAsset(pathname: string): boolean {
	return (
		pathname.startsWith('/_app/') ||
		pathname.startsWith('/pdfjs/') ||
		pathname === '/favicon.svg' ||
		pathname === '/social-card.png' ||
		pathname === '/robots.txt'
	);
}

function isPublicRoute(pathname: string): boolean {
	return pathname === '/sign-in' || isStaticAsset(pathname);
}

function acceptsHtml(request: Request): boolean {
	return request.headers.get('accept')?.includes('text/html') ?? false;
}

function copyHeaders(from: Headers, to: Headers): void {
	for (const [key, value] of from) {
		to.append(key, value);
	}
}

let cachedClerkClient: ReturnType<typeof createClerkClient> | null = null;
function getClerkClient() {
	const secretKey = process.env.CLERK_SECRET_KEY;
	const publishableKey = getClerkPublishableKey();
	if (!secretKey || !publishableKey) return null;
	cachedClerkClient ??= createClerkClient({ secretKey, publishableKey });
	return cachedClerkClient;
}

function authorizedParties(eventOrigin: string): string[] {
	return Array.from(
		new Set(
			[
				eventOrigin,
				envOrigin(process.env.APP_URL),
				envOrigin(process.env.VERCEL_URL)
			].filter((origin): origin is string => Boolean(origin))
		)
	);
}

// A fresh UUID per server process. Clients compare this against the one they
// last synced with; a mismatch means they're talking to a different server
// instance than the one their in-memory Y.Docs were synced against, so
// those Y.Docs must be discarded before the WebSocket provider attaches —
// otherwise stale client state syncs up and the server flushes it back to
// disk, silently overwriting external edits made while docwriter was down.
// Stashed on globalThis so the same module scope survives Vite HMR.
const SERVER_INSTANCE_ID_KEY = '__docwriterServerInstanceId';
const globalAny = globalThis as unknown as Record<string, string | undefined>;
if (!globalAny[SERVER_INSTANCE_ID_KEY]) {
	globalAny[SERVER_INSTANCE_ID_KEY] = randomUUID();
}

if (!IS_VERCEL) {
	// Install DocWriter's bundled project skill(s) into the workspace's
	// `.claude/skills/` dir so the SDK picks them up via the 'project'
	// settingSource. Idempotent — only overwrites the built-in skill files.
	installBundledSkills();

	// Start the Hocuspocus WebSocket Y.Doc sync server on a separate port
	// alongside Vite's HTTP server. Module-scope singleton guard keeps Vite
	// HMR (which re-executes this file on save) from double-binding.
	const WS_PORT = parseInt(process.env.DOCWRITER_WS_PORT ?? '', 10) || 3001;
	let wsServer: ReturnType<typeof createWsServer> | null = (globalThis as unknown as { __docwriterWsServer?: ReturnType<typeof createWsServer> }).__docwriterWsServer ?? null;
	if (!wsServer) {
		try {
			wsServer = createWsServer(WS_PORT);
			wsServer.listen();
			(globalThis as unknown as { __docwriterWsServer?: ReturnType<typeof createWsServer> }).__docwriterWsServer = wsServer;
			console.log(`[docwriter] Y.Doc sync listening on ws://localhost:${WS_PORT}`);
		} catch (err) {
			console.error('[docwriter] failed to start Y.Doc WebSocket server:', err);
		}
	}

	// Safety-net re-sync of rules → .claude/CLAUDE.md on every server boot.
	// Catches the rare case where a previous mutation landed the DB write
	// but crashed before the file write — without this, the drift would
	// persist until the next rule edit. Cheap: hash-checked, no-ops when
	// the file already matches.
	try {
		syncRulesToClaudeMemory(getRules());
	} catch {
		/* fresh workspace or DB not yet initialized — ignore */
	}

	// Run at module load (= server startup), not per-request.
	if (process.env.DOCWRITER_NEW_SESSION === '1') {
		try {
			if (getSessionId()) {
				// Overwrite with an empty session; the next query() will create a new one.
				setSessionId('');
				console.log('[docwriter] --new-session: cleared persisted session ID');
			}
		} catch {
			// Fresh workspace or early DB init failure — ignore.
		}
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.auth = { isAuthenticated: false, userId: null, sessionId: null };

	const clerkClient = getClerkClient();
	if (isPublicRoute(event.url.pathname)) {
		return resolve(event);
	}
	if (!clerkClient) {
		const missing = missingClerkKeys();
		if (CLERK_AUTH_REQUIRED || missing.length !== 2) {
			return new Response(`Clerk auth is not fully configured. Missing: ${missing.join(', ')}.`, {
				status: 503,
				headers: { 'content-type': 'text/plain' }
			});
		}
		return resolve(event);
	}

	const requestState = await clerkClient.authenticateRequest(event.request, {
		authorizedParties: authorizedParties(event.url.origin),
		afterSignInUrl: '/',
		afterSignUpUrl: '/',
		signInUrl: `${event.url.origin}/sign-in`,
		signUpUrl: `${event.url.origin}/sign-in`
	});

	if (requestState.status === 'handshake') {
		return new Response(null, { status: 307, headers: requestState.headers });
	}

	if (!requestState.isAuthenticated) {
		if (event.url.pathname.startsWith('/api/') && !acceptsHtml(event.request)) {
			return Response.json({ error: 'Unauthorized' }, { status: 401 });
		}
		const signInUrl = new URL('/sign-in', event.url.origin);
		signInUrl.searchParams.set('redirect_url', event.url.href);
		return Response.redirect(signInUrl, 303);
	}

	const auth = requestState.toAuth();
	event.locals.auth = {
		isAuthenticated: true,
		userId: auth.userId,
		sessionId: auth.sessionId
	};

	const response = await resolve(event);
	copyHeaders(requestState.headers, response.headers);
	return response;
};
