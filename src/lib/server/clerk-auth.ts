import { createClerkClient } from '@clerk/backend';
import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { IS_HOSTED_LANDING } from '$lib/server/deploy-mode';
import { runWithUser } from './request-context';
import { isMultiTenant, ensureUserWorkspace } from './workspace';

export const CLERK_AUTH_REQUIRED = IS_HOSTED_LANDING || process.env.DOCWRITER_HOSTED === '1' || process.env.CLERK_AUTH_REQUIRED === '1';

const authorizedUserCache = new Map<string, boolean>();

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
		pathname === '/api/waitlist' ||
		isStaticAsset(pathname)
	);
}

function acceptsHtml(request: Request): boolean {
	return request.headers.get('accept')?.includes('text/html') ?? false;
}

function copyHeaders(from: Headers, to: Headers): void {
	for (const [key, value] of from) {
		if (key.toLowerCase() === 'location') continue;
		to.append(key, value);
	}
}

function afterAuthUrl(): string {
	return IS_HOSTED_LANDING ? '/welcome' : '/';
}

function signInUrl(event: Parameters<Handle>[0]['event']): string {
	return new URL('/sign-in', event.url.origin).toString();
}

function clerkAuthOptions(event: Parameters<Handle>[0]['event']) {
	const redirectUrl = afterAuthUrl();
	const authUrl = signInUrl(event);
	return {
		authorizedParties: authorizedParties(event.url.origin),
		afterSignInUrl: redirectUrl,
		afterSignUpUrl: redirectUrl,
		signInUrl: authUrl,
		signUpUrl: authUrl
	};
}

function hasClerkHandshakeParams(url: URL): boolean {
	return (
		url.searchParams.has('__clerk_handshake') ||
		url.searchParams.has('__clerk_handshake_nonce') ||
		url.searchParams.has('__clerk_help')
	);
}

function clerkLocationRedirect(event: Parameters<Handle>[0]['event'], headers: Headers): Response | null {
	const location = headers.get('location');
	if (!location || !hasClerkHandshakeParams(event.url)) return null;
	return new Response(null, { status: 307, headers });
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

export async function isAuthorizedUser(
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>,
	userId: string
): Promise<boolean> {
	const cached = authorizedUserCache.get(userId);
	if (cached !== undefined) return cached;
	const allowed = authorizedEmails();
	if (allowed.size === 0) {
		authorizedUserCache.set(userId, false);
		return false;
	}
	const user = await clerkClient.users.getUser(userId);
	const isAllowed = user.emailAddresses.some((email) => {
		if (email.verification?.status !== 'verified') return false;
		return allowed.has(email.emailAddress.toLowerCase());
	});
	authorizedUserCache.set(userId, isAllowed);
	return isAllowed;
}

async function revokeSession(
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
	const redirectUrl = new URL(signInUrl(event));
	redirectUrl.searchParams.set('denied', '1');
	return Response.redirect(redirectUrl, 303);
}

async function handleAuthStatus(
	event: Parameters<Handle>[0]['event'],
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>
): Promise<Response> {
	const requestState = await clerkClient.authenticateRequest(event.request, clerkAuthOptions(event));
	if (requestState.status === 'handshake') {
		return new Response(null, { status: 307, headers: requestState.headers });
	}
	const cleanupRedirect = clerkLocationRedirect(event, requestState.headers);
	if (cleanupRedirect) return cleanupRedirect;
	if (!requestState.isAuthenticated) {
		return json({ authenticated: false, authorized: false });
	}
	const auth = requestState.toAuth();
	if (!auth.userId) {
		return json({ authenticated: false, authorized: false });
	}
	const authorized = await isAuthorizedUser(clerkClient, auth.userId);
	let userSummary: { email: string | null; name: string | null } | null = null;
	if (authorized) {
		try {
			const user = await clerkClient.users.getUser(auth.userId);
			const primaryEmail =
				user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ??
				user.emailAddresses[0]?.emailAddress ??
				null;
			const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || null;
			userSummary = { email: primaryEmail, name };
		} catch {
			userSummary = null;
		}
	}
	return json({ authenticated: true, authorized, user: userSummary });
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

	if (requestState.status === 'handshake') {
		return new Response(null, { status: 307, headers: requestState.headers });
	}
	const cleanupRedirect = clerkLocationRedirect(event, requestState.headers);
	if (cleanupRedirect) return cleanupRedirect;

	if (!requestState.isAuthenticated) {
		if (event.url.pathname.startsWith('/api/') && !acceptsHtml(event.request)) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
		if (event.url.pathname === '/') {
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

	if (isMultiTenant() && auth.userId) {
		ensureUserWorkspace(auth.userId);
	}

	const resolveRequest = () => resolve(event);
	const response = isMultiTenant() && auth.userId
		? await runWithUser(auth.userId, resolveRequest)
		: await resolveRequest();
	copyHeaders(requestState.headers, response.headers);
	return response;
}
