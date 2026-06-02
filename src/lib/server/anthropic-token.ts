import type { Cookies } from '@sveltejs/kit';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { kvGet, kvSet } from './db-writes';

const KV_ANTHROPIC_API_KEY = 'anthropicApiKey';
const COOKIE_ANTHROPIC_API_KEY = 'docwriter_anthropic_api_key';

type TokenSource = 'cookie' | 'saved' | 'environment' | 'none';

export type AnthropicTokenStatus = {
	configured: boolean;
	source: TokenSource;
};

function tokenSecret(): string | undefined {
	return (
		process.env.DOCWRITER_TOKEN_SECRET ||
		process.env.CLERK_SECRET_KEY ||
		process.env.AUTH_SECRET ||
		process.env.SESSION_SECRET
	);
}

function cipherKey(secret: string): Buffer {
	return createHash('sha256').update(secret).digest();
}

function encryptToken(token: string): string | null {
	const secret = tokenSecret();
	if (!secret) return null;
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', cipherKey(secret), iv);
	const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptToken(value: string | undefined): string | null {
	if (!value) return null;
	const secret = tokenSecret();
	if (!secret) return null;
	const [version, iv, tag, encrypted] = value.split('.');
	if (version !== 'v1' || !iv || !tag || !encrypted) return null;
	try {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			cipherKey(secret),
			Buffer.from(iv, 'base64url')
		);
		decipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(encrypted, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch {
		return null;
	}
}

function cookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
		maxAge: 60 * 60 * 24 * 365
	};
}

function savedToken(): string | null {
	const token = kvGet(KV_ANTHROPIC_API_KEY)?.trim();
	return token || null;
}

function environmentToken(): string | null {
	const token = process.env.ANTHROPIC_API_KEY?.trim();
	return token || null;
}

export function getAnthropicApiKey(cookies?: Cookies): string | null {
	return (
		decryptToken(cookies?.get(COOKIE_ANTHROPIC_API_KEY)) ||
		savedToken() ||
		environmentToken()
	);
}

export function getAnthropicTokenStatus(cookies?: Cookies): AnthropicTokenStatus {
	if (decryptToken(cookies?.get(COOKIE_ANTHROPIC_API_KEY))) {
		return { configured: true, source: 'cookie' };
	}
	if (savedToken()) return { configured: true, source: 'saved' };
	if (environmentToken()) return { configured: true, source: 'environment' };
	return { configured: false, source: 'none' };
}

export function saveAnthropicApiKey(token: string, cookies?: Cookies): AnthropicTokenStatus {
	const clean = token.trim();
	kvSet(KV_ANTHROPIC_API_KEY, clean);

	const encrypted = encryptToken(clean);
	if (encrypted && cookies) {
		cookies.set(COOKIE_ANTHROPIC_API_KEY, encrypted, cookieOptions());
		return { configured: true, source: 'cookie' };
	}

	return { configured: true, source: 'saved' };
}

export function clearAnthropicApiKey(cookies?: Cookies): AnthropicTokenStatus {
	kvSet(KV_ANTHROPIC_API_KEY, '');
	cookies?.delete(COOKIE_ANTHROPIC_API_KEY, { path: '/' });
	return getAnthropicTokenStatus(cookies);
}
