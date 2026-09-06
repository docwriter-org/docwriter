import { describe, expect, it } from 'vitest';
import { cookieHeader, issueSession, parseCookies, verifySession } from '../session.js';

const secret = 'x'.repeat(32);

describe('session cookies', () => {
	it('round-trips a user', () => {
		const token = issueSession({ id: 'gh:1', login: 'alice' }, secret);
		expect(verifySession(token, secret)).toEqual({ id: 'gh:1', login: 'alice' });
	});
	it('rejects tampering, wrong secret, and expiry', () => {
		const token = issueSession({ id: 'gh:1', login: 'alice' }, secret, { now: 1000, days: 1 });
		expect(verifySession(token.slice(0, -2) + 'zz', secret)).toBeNull();
		expect(verifySession(token, 'y'.repeat(32))).toBeNull();
		expect(verifySession(token, secret, { now: 1000 + 86_400_000 + 1 })).toBeNull();
		expect(verifySession(token, secret, { now: 1000 + 86_400_000 - 1 })).not.toBeNull();
		expect(verifySession('', secret)).toBeNull();
		expect(verifySession('garbage', secret)).toBeNull();
	});
	it('parses and builds cookie headers', () => {
		expect(parseCookies('a=1; dw_session=abc%2Edef; b=2').get('dw_session')).toBe('abc.def');
		expect(cookieHeader('c', 'v', { secure: true, maxAgeSeconds: 5 })).toBe('c=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=5');
	});
});
