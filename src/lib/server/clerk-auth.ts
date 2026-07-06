import { createClerkClient } from '@clerk/backend';
import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import type { IncomingMessage } from 'node:http';
import { IS_HOSTED_LANDING, isMultiTenant } from '$lib/server/deploy-mode';
import { hasClerkParams } from '$lib/shared/clerk-params';
import { runWithUser } from './request-context';
import { ensureUserWorkspace } from './workspace';

export const CLERK_AUTH_REQUIRED =
	IS_HOSTED_LANDING || isMultiTenant() || process.env.CLERK_AUTH_REQUIRED === '1';

interface AuthorizedUserEntry {
	authorized: boolean;
	user: { email: string | null; name: string | null } | null;
}

const authorizedUserCache = new Map<string, AuthorizedUserEntry>();

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

export function isPublicRoute(pathname: string): boolean {
	return (
		pathname === '/sign-in' ||
		pathname === '/welcome' ||
		pathname === '/api/auth/status' ||
		pathname === '/api/health' ||
		pathname === '/api/waitlist' ||
		isStaticAsset(pathname)
	);
}

function acceptsHtml(request: Request): boolean {
	return request.headers.get('accept')?.includes('text/html') ?? false;
}

// Clerk attaches a `location` header even to some RESOLVED (non-handshake)
// request states. Forwarding it onto an ordinary response would turn the
// page into a redirect, so copyHeaders always drops it; clerkRedirect below
// promotes it into a real 307 in the one case it's meaningful — the request
// URL still carries handshake params that need cleaning up.
function copyHeaders(from: Headers, to: Headers): void {
	for (const [key, value] of from) {
		if (key.toLowerCase() === 'location') continue;
		to.append(key, value);
	}
}

function afterAuthUrl(): string {
	return IS_HOSTED_LANDING ? '/welcome' : '/';
}

function signInUrl(event: Parameters<Handle>[0]['event']): URL {
	return new URL('/sign-in', event.url.origin);
}

function clerkAuthOptions(event: Parameters<Handle>[0]['event']) {
	const redirectUrl = afterAuthUrl();
	const authUrl = signInUrl(event).toString();
	return {
		authorizedParties: authorizedParties(event.url.origin),
		afterSignInUrl: redirectUrl,
		afterSignUpUrl: redirectUrl,
		signInUrl: authUrl,
		signUpUrl: authUrl
	};
}

/** The redirect Clerk's request state asks for, if any: a handshake, or a
 * cleanup redirect stripping leftover handshake params (see copyHeaders). */
function clerkRedirect(
	event: Parameters<Handle>[0]['event'],
	requestState: { status: string; headers: Headers }
): Response | null {
	if (requestState.status === 'handshake') {
		return new Response(null, { status: 307, headers: requestState.headers });
	}
	if (requestState.headers.get('location') && hasClerkParams(event.url)) {
		return new Response(null, { status: 307, headers: requestState.headers });
	}
	return null;
}

let cachedClerkClient: ReturnType<typeof createClerkClient> | null = null;

export function getClerkClient() {
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

function authorizedEmails(): Set<string> {
	const configured = (process.env.DOCWRITER_AUTHORIZED_EMAILS ?? '')
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
	return new Set(configured);
}

/** Authorization + display summary in one cached lookup, so the frequent
 * /api/auth/status poll doesn't hit the Clerk API on every page load. */
async function lookupAuthorizedUser(
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>,
	userId: string
): Promise<AuthorizedUserEntry> {
	const cached = authorizedUserCache.get(userId);
	if (cached !== undefined) return cached;
	const allowed = authorizedEmails();
	let entry: AuthorizedUserEntry = { authorized: false, user: null };
	if (allowed.size > 0) {
		const user = await clerkClient.users.getUser(userId);
		const authorized = user.emailAddresses.some((email) => {
			if (email.verification?.status !== 'verified') return false;
			return allowed.has(email.emailAddress.toLowerCase());
		});
		const email =
			user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
			user.emailAddresses[0]?.emailAddress ??
			null;
		const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || null;
		entry = { authorized, user: { email, name } };
	}
	authorizedUserCache.set(userId, entry);
	return entry;
}

export async function isAuthorizedUser(
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>,
	userId: string
): Promise<boolean> {
	return (await lookupAuthorizedUser(clerkClient, userId)).authorized;
}

export async function revokeSession(
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>,
	sessionId: string | null
): Promise<void> {
	if (!sessionId) return;
	try {
		await clerkClient.sessions.revokeSession(sessionId);
	} catch {
		/* session may already be invalid */
	}
}

async function redirectUnauthorizedUser(
	event: Parameters<Handle>[0]['event'],
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>,
	sessionId: string | null
): Promise<Response> {
	await revokeSession(clerkClient, sessionId);
	if (event.url.pathname.startsWith('/api/') && !acceptsHtml(event.request)) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const redirectUrl = signInUrl(event);
	redirectUrl.searchParams.set('denied', '1');
	return Response.redirect(redirectUrl, 303);
}

async function handleAuthStatus(
	event: Parameters<Handle>[0]['event'],
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>
): Promise<Response> {
	const requestState = await clerkClient.authenticateRequest(event.request, clerkAuthOptions(event));
	const redirect = clerkRedirect(event, requestState);
	if (redirect) return redirect;
	if (!requestState.isAuthenticated) {
		return json({ authenticated: false, authorized: false });
	}
	const auth = requestState.toAuth();
	if (!auth.userId) {
		return json({ authenticated: false, authorized: false });
	}
	let entry: AuthorizedUserEntry;
	try {
		entry = await lookupAuthorizedUser(clerkClient, auth.userId);
	} catch {
		entry = { authorized: false, user: null };
	}
	return json({
		authenticated: true,
		authorized: entry.authorized,
		user: entry.authorized ? entry.user : null
	});
}

export async function maybeHandleClerkAuth(
	event: Parameters<Handle>[0]['event'],
	resolve: Parameters<Handle>[0]['resolve']
): Promise<Response | null> {
	event.locals.auth = { isAuthenticated: false, userId: null, sessionId: null };

	const clerkClient = getClerkClient();
	if (event.url.pathname === '/api/auth/status') {
		if (!clerkClient) {
			return json({ authenticated: false, authorized: false });
		}
		return handleAuthStatus(event, clerkClient);
	}

	if (isPublicRoute(event.url.pathname)) {
		return null;
	}

	if (!clerkClient) {
		const missing = missingClerkKeys();
		if (CLERK_AUTH_REQUIRED || missing.length !== 2) {
			return new Response(`Clerk auth is not fully configured. Missing: ${missing.join(', ')}.`, {
				status: 503,
				headers: { 'content-type': 'text/plain' }
			});
		}
		return null;
	}

	const requestState = await clerkClient.authenticateRequest(event.request, clerkAuthOptions(event));

	const redirect = clerkRedirect(event, requestState);
	if (redirect) return redirect;

	if (!requestState.isAuthenticated) {
		if (event.url.pathname.startsWith('/api/') && !acceptsHtml(event.request)) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
		if (event.url.pathname === '/' && IS_HOSTED_LANDING) {
			return Response.redirect(new URL('/welcome', event.url.origin), 303);
		}
		const redirectUrl = new URL(signInUrl(event));
		redirectUrl.searchParams.set('redirect_url', event.url.href);
		return Response.redirect(redirectUrl, 303);
	}

	const auth = requestState.toAuth();
	if (!auth.userId || !(await isAuthorizedUser(clerkClient, auth.userId))) {
		return redirectUnauthorizedUser(event, clerkClient, auth.sessionId);
	}

	if (IS_HOSTED_LANDING && !isPublicRoute(event.url.pathname)) {
		return Response.redirect(new URL('/welcome', event.url.origin), 303);
	}

	event.locals.auth = {
		isAuthenticated: true,
		userId: auth.userId,
		sessionId: auth.sessionId
	};

	// auth.userId is guaranteed non-null past the unauthorized guard above.
	const resolveRequest = () => resolve(event);
	let response: Response;
	if (isMultiTenant()) {
		ensureUserWorkspace(auth.userId);
		response = await runWithUser(auth.userId, resolveRequest);
	} else {
		response = await resolveRequest();
	}
	copyHeaders(requestState.headers, response.headers);
	return response;
}

// ── WebSocket upgrade authentication ─────────────────────────────────────

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function upgradeRequestOrigin(request: IncomingMessage): string {
	const origin = firstHeader(request.headers.origin);
	if (origin) {
		try {
			return new URL(origin).origin;
		} catch {
			/* fall through to forwarded headers */
		}
	}
	const proto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
	const host =
		firstHeader(request.headers['x-forwarded-host']) ??
		firstHeader(request.headers.host) ??
		'localhost';
	return new URL(`${proto}://${host}`).origin;
}

/** Authenticate a WebSocket upgrade request via the Clerk session cookie.
 * Returns the authorized userId; throws on any failure. */
export async function authenticateWsUpgrade(request: IncomingMessage): Promise<string> {
	const clerkClient = getClerkClient();
	if (!clerkClient) throw new Error('clerk-not-configured');
	const origin = upgradeRequestOrigin(request);
	const url = new URL(request.url || '/', origin);
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else if (typeof value === 'string') {
			headers.set(key, value);
		}
	}
	const state = await clerkClient.authenticateRequest(new Request(url, { headers }), {
		authorizedParties: [origin]
	});
	if (!state.isAuthenticated) throw new Error('not-authenticated');
	const auth = state.toAuth();
	if (!auth.userId) throw new Error('no-user');
	if (!(await isAuthorizedUser(clerkClient, auth.userId))) throw new Error('unauthorized');
	return auth.userId;
}
