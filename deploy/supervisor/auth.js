/**
 * Sign-in for the supervisor. Two modes:
 *
 * - `github`: OAuth web flow with the `read:user` scope. The user id is
 *   `gh:<numeric id>` (stable across renames) and the login is display only.
 *   An optional allowlist file (one login per line, `#` comments) gates
 *   who may in.
 * - `dev`: `/auth/login?user=<name>` signs in as that name. For laptops
 *   and tests only; the config refuses it unless SUPERVISOR_AUTH=dev.
 *
 * The app processes never see any of this. They trust the gateway header.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cookieHeader, issueSession, parseCookies, verifySession } from './session.js';
import { notAllowedPage, signInPage } from './pages.js';

export function readAllowlist(path) {
	if (!path) return null;
	try {
		const logins = readFileSync(path, 'utf8')
			.split('\n')
			.map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
			.filter(Boolean);
		return new Set(logins);
	} catch {
		return null; // missing file = open
	}
}

export function createAuth({ config, metrics, fetchImpl = fetch, allowlist = () => readAllowlist(config.allowlistPath) }) {
	const secret = config.cookieSecret || randomBytes(32).toString('hex');
	const cookieOpts = { secure: config.secure, maxAgeSeconds: config.sessionDays * 86_400 };

	function userFromRequest(req) {
		const token = parseCookies(req.headers.cookie).get(config.cookieName);
		return verifySession(token, secret);
	}

	function setSession(res, user) {
		res.setHeader('set-cookie', cookieHeader(config.cookieName, issueSession(user, secret, { days: config.sessionDays }), cookieOpts));
	}

	function redirect(res, to) {
		res.writeHead(302, { location: to });
		res.end();
	}

	function html(res, status, body) {
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		res.end(body);
	}

	function isAllowed(login) {
		const list = allowlist();
		return !list || list.size === 0 || list.has(login.toLowerCase());
	}

	async function githubLogin(res) {
		const state = issueSession({ id: 'state', login: randomBytes(8).toString('hex') }, secret, { days: 1 / 144 }); // 10 min
		res.setHeader('set-cookie', cookieHeader('dw_oauth_state', state, { secure: config.secure, maxAgeSeconds: 600 }));
		const params = new URLSearchParams({
			client_id: config.github.clientId,
			redirect_uri: `${config.publicOrigin}/auth/callback`,
			scope: 'read:user',
			state
		});
		redirect(res, `https://github.com/login/oauth/authorize?${params}`);
	}

	async function githubCallback(req, res, url) {
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		const expected = parseCookies(req.headers.cookie).get('dw_oauth_state');
		if (!code || !state || state !== expected || !verifySession(state, secret)) {
			metrics?.inc('auth_denied');
			return html(res, 400, signInPage({ mode: 'github' }));
		}
		const tokenRes = await fetchImpl('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({
				client_id: config.github.clientId,
				client_secret: config.github.clientSecret,
				code,
				redirect_uri: `${config.publicOrigin}/auth/callback`
			})
		});
		const token = (await tokenRes.json())?.access_token;
		if (!token) {
			metrics?.inc('auth_denied');
			return html(res, 401, signInPage({ mode: 'github' }));
		}
		const userRes = await fetchImpl('https://api.github.com/user', {
			headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'docwriter-supervisor' }
		});
		const gh = await userRes.json();
		if (!gh?.id || !gh?.login) {
			metrics?.inc('auth_denied');
			return html(res, 401, signInPage({ mode: 'github' }));
		}
		if (!isAllowed(gh.login)) {
			metrics?.inc('auth_denied');
			return html(res, 403, notAllowedPage(gh.login));
		}
		setSession(res, { id: `gh:${gh.id}`, login: gh.login });
		redirect(res, '/');
	}

	function devLogin(res, url) {
		const name = (url.searchParams.get('user') ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
		if (!name) return html(res, 200, signInPage({ mode: 'dev' }));
		if (!isAllowed(name)) return html(res, 403, notAllowedPage(name));
		setSession(res, { id: `dev:${name}`, login: name });
		redirect(res, '/');
	}

	/** Handles /auth/* routes. Returns true when the response was written. */
	async function handle(req, res, url) {
		switch (url.pathname) {
			case '/auth/login':
				if (config.auth === 'github') await githubLogin(res);
				else devLogin(res, url);
				return true;
			case '/auth/callback':
				if (config.auth === 'github') await githubCallback(req, res, url);
				else redirect(res, '/auth/login');
				return true;
			case '/auth/logout':
				res.setHeader('set-cookie', cookieHeader(config.cookieName, '', { secure: config.secure, maxAgeSeconds: 0 }));
				redirect(res, '/auth/login');
				return true;
			default:
				return false;
		}
	}

	function signInResponse(res) {
		html(res, 401, signInPage({ mode: config.auth }));
	}

	return { userFromRequest, handle, signInResponse, isAllowed };
}
