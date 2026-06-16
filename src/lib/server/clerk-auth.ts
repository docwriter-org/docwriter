import { createClerkClient } from '@clerk/backend';
import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';

export const IS_HOSTED_DEPLOY = process.env.VERCEL === '1' || process.env.LANDING_DEPLOY === '1';
export const CLERK_AUTH_REQUIRED = IS_HOSTED_DEPLOY || process.env.CLERK_AUTH_REQUIRED === '1';

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
		to.append(key, value);
	}
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
	const signInUrl = new URL('/sign-in', event.url.origin);
	signInUrl.searchParams.set('denied', '1');
	return Response.redirect(signInUrl, 303);
}

async function handleAuthStatus(
	event: Parameters<Handle>[0]['event'],
	clerkClient: NonNullable<ReturnType<typeof getClerkClient>>
): Promise<Response> {
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
		return json({ authenticated: false, authorized: false });
	}
	const auth = requestState.toAuth();
	if (!auth.userId) {
		return json({ authenticated: false, authorized: false });
	}
	const authorized = await isAuthorizedUser(clerkClient, auth.userId);
	return json({ authenticated: true, authorized });
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
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
		if (event.url.pathname === '/') {
			return Response.redirect(new URL('/welcome', event.url.origin), 303);
		}
		const signInUrl = new URL('/sign-in', event.url.origin);
		signInUrl.searchParams.set('redirect_url', event.url.href);
		return Response.redirect(signInUrl, 303);
	}

	const auth = requestState.toAuth();
	if (!auth.userId || !(await isAuthorizedUser(clerkClient, auth.userId))) {
		return redirectUnauthorizedUser(event, clerkClient, auth.sessionId);
	}

	event.locals.auth = {
		isAuthenticated: true,
		userId: auth.userId,
		sessionId: auth.sessionId
	};

	const response = await resolve(event);
	copyHeaders(requestState.headers, response.headers);
	return response;
}
