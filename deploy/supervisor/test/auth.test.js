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
