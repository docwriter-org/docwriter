import { describe, expect, it } from 'vitest';
import { createAuth } from '../auth.js';
import { parseCookies } from '../session.js';

function fakeRes() {
	const res = { headers: {}, status: 0, body: '' };
	res.setHeader = (k, v) => (res.headers[k] = v);
	res.writeHead = (status, headers = {}) => {
		res.status = status;
		Object.assign(res.headers, headers);
	};
	res.end = (body = '') => (res.body = String(body));
	return res;
}

const config = {
	auth: 'github',
	secure: true,
	publicOrigin: 'https://app.example.org',
	cookieName: 'dw_session',
	cookieSecret: 'c'.repeat(40),
	sessionDays: 30,
	github: { clientId: 'cid', clientSecret: 'csec' },
	allowlistPath: ''
};

async function run(auth, path, { cookie = '' } = {}) {
	const url = new URL(path, config.publicOrigin);
	const req = { headers: { cookie } };
	const res = fakeRes();
	const handled = await auth.handle(req, res, url);
	return { handled, res };
}

describe('github auth', () => {
	it('redirects to GitHub with a signed state cookie', async () => {
		const auth = createAuth({ config });
		const { handled, res } = await run(auth, '/auth/login');
		expect(handled).toBe(true);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.location);
		expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(location.searchParams.get('client_id')).toBe('cid');
		expect(location.searchParams.get('redirect_uri')).toBe('https://app.example.org/auth/callback');
		const state = parseCookies(res.headers['set-cookie']).get('dw_oauth_state');
		expect(location.searchParams.get('state')).toBe(state);
	});

	it('rejects a callback whose state does not match the cookie', async () => {
		const auth = createAuth({ config, fetchImpl: async () => { throw new Error('must not be called'); } });
		const { res } = await run(auth, '/auth/callback?code=abc&state=forged', { cookie: 'dw_oauth_state=other' });
		expect(res.status).toBe(400);
	});

	it('exchanges the code, checks the allowlist, and issues a session', async () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push({ url, init });
			if (url.includes('access_token')) return { json: async () => ({ access_token: 'tok' }) };
			if (url.includes('/user')) return { json: async () => ({ id: 42, login: 'Alice' }) };
			throw new Error('unexpected ' + url);
		};
		const allowed = new Set(['alice']);
		const auth = createAuth({ config, fetchImpl, allowlist: () => allowed });
		const login = await run(auth, '/auth/login');
		const state = parseCookies(login.res.headers['set-cookie']).get('dw_oauth_state');
		const { res } = await run(auth, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { cookie: `dw_oauth_state=${encodeURIComponent(state)}` });
		expect(res.status).toBe(302);
		expect(res.headers.location).toBe('/');
		expect(JSON.parse(calls[0].init.body)).toMatchObject({ code: 'abc', client_secret: 'csec' });
		expect(calls[1].init.headers.authorization).toBe('Bearer tok');
		const session = parseCookies(res.headers['set-cookie']).get('dw_session');
		expect(auth.userFromRequest({ headers: { cookie: `dw_session=${encodeURIComponent(session)}` } })).toEqual({ id: 'gh:42', login: 'Alice' });
		expect(res.headers['set-cookie']).toContain('Secure');

		allowed.clear();
		allowed.add('someone-else');
		const login2 = await run(auth, '/auth/login');
		const state2 = parseCookies(login2.res.headers['set-cookie']).get('dw_oauth_state');
		const denied = await run(auth, `/auth/callback?code=abc&state=${encodeURIComponent(state2)}`, { cookie: `dw_oauth_state=${encodeURIComponent(state2)}` });
		expect(denied.res.status).toBe(403);
		expect(denied.res.body).toContain('Alice');
	});

	it('logs out by clearing the cookie', async () => {
		const auth = createAuth({ config });
		const { res } = await run(auth, '/auth/logout');
		expect(res.status).toBe(302);
		expect(res.headers['set-cookie']).toContain('Max-Age=0');
	});
});

describe('clerk auth', () => {
	const clerkConfig = { ...config, auth: 'clerk', clerk: { publishableKey: 'pk_test_abc', secretKey: 'sk_test_abc' } };
	const fakeClerk = ({ users = { tok_alice: 'user_1' }, emails = { user_1: 'alice@example.org' } } = {}) => ({
		scriptUrls: () => ({ js: 'https://x.clerk.accounts.dev/js.js', ui: 'https://x.clerk.accounts.dev/ui.js' }),
		verify: async (token) => users[token] ?? null,
		email: async (id) => emails[id] ?? null
	});
	const post = async (auth, token) => {
		const url = new URL('/auth/clerk/session', clerkConfig.publicOrigin);
		const req = { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} };
		const res = fakeRes();
		await auth.handle(req, res, url);
		return res;
	};

	it('serves a sign-in page that loads ClerkJS with the publishable key', async () => {
		const auth = createAuth({ config: clerkConfig, clerk: fakeClerk() });
		const { res } = await run(auth, '/auth/login');
		expect(res.status).toBe(200);
		expect(res.body).toContain('https://x.clerk.accounts.dev/js.js');
		expect(res.body).toContain('data-clerk-publishable-key="pk_test_abc"');
		expect(res.body).toContain('/auth/clerk/session');
	});

	it('trades a verified Clerk token for a supervisor session keyed by Clerk user id', async () => {
		const auth = createAuth({ config: clerkConfig, clerk: fakeClerk() });
		const res = await post(auth, 'tok_alice');
		expect(res.status).toBe(204);
		const session = parseCookies(res.headers['set-cookie']).get('dw_session');
		expect(auth.userFromRequest({ headers: { cookie: `dw_session=${encodeURIComponent(session)}` } })).toEqual({ id: 'clerk:user_1', login: 'alice@example.org' });
	});

	it('refuses missing, unverifiable, and uninvited tokens', async () => {
		const allowed = new Set(['someone@else.org']);
		const auth = createAuth({ config: clerkConfig, clerk: fakeClerk(), allowlist: () => allowed });
		expect((await post(auth, '')).status).toBe(401);
		expect((await post(auth, 'tok_bogus')).status).toBe(401);
		const denied = await post(auth, 'tok_alice');
		expect(denied.status).toBe(403);
		expect(denied.body).toContain('alice@example.org');
		expect(denied.headers['set-cookie']).toBeUndefined();
	});

	it('signs out by clearing our cookie and ending the Clerk session on the page', async () => {
		const auth = createAuth({ config: clerkConfig, clerk: fakeClerk() });
		const { res } = await run(auth, '/auth/logout');
		expect(res.status).toBe(200);
		expect(res.headers['set-cookie']).toContain('Max-Age=0');
		expect(res.body).toContain('signOut()');
	});

	it('refuses to start in clerk mode without a verifier', () => {
		expect(() => createAuth({ config: clerkConfig })).toThrow(/clerk verifier/);
	});
});
