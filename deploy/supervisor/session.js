/**
 * Signed session cookies. Payload is base64url JSON, signature is
 * HMAC-SHA256 over the payload with the cookie secret. No server-side
 * session store: the cookie is the session.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
	return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64, secret) {
	return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** @param {{ id: string, login: string }} user */
export function issueSession(user, secret, { days = 30, now = Date.now() } = {}) {
	const payload = { id: user.id, login: user.login, exp: now + days * 86_400_000 };
	const p = b64url(JSON.stringify(payload));
	return `${p}.${sign(p, secret)}`;
}

/** Returns the session payload, or null when missing, malformed, tampered, or expired. */
export function verifySession(token, secret, { now = Date.now() } = {}) {
	if (!token || typeof token !== 'string') return null;
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;
	const p = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = sign(p, secret);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!payload || typeof payload.id !== 'string' || typeof payload.exp !== 'number') return null;
	if (payload.exp <= now) return null;
	return { id: payload.id, login: String(payload.login ?? payload.id) };
}

export function parseCookies(header) {
	const out = new Map();
	for (const part of (header ?? '').split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k) out.set(k, decodeURIComponent(v));
	}
	return out;
}

export function cookieHeader(name, value, { secure, maxAgeSeconds }) {
	const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
	if (secure) parts.push('Secure');
	if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
	return parts.join('; ');
}
