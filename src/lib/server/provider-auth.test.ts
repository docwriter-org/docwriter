import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	decodeJwtPayload,
	describeClaudeAuthMethod,
	readClaudeAccount,
	readCodexLoginDetails
} from './provider-auth';

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'docwriter-provider-auth-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('decodeJwtPayload', () => {
	it('decodes a base64url payload without verifying', () => {
		const token = `${b64url({ alg: 'none' })}.${b64url({ email: 'a@b.c' })}.sig`;
		expect(decodeJwtPayload(token)).toEqual({ email: 'a@b.c' });
	});
	it('returns null for garbage', () => {
		expect(decodeJwtPayload('nope')).toBeNull();
		expect(decodeJwtPayload('a.!!!.c')).toBeNull();
	});
});

describe('describeClaudeAuthMethod', () => {
	it('labels known methods and passes unknown ones through', () => {
		expect(describeClaudeAuthMethod('claude.ai')).toBe('Claude subscription (claude.ai)');
		expect(describeClaudeAuthMethod('oauth_token')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(describeClaudeAuthMethod('something_new')).toBe('something_new');
		expect(describeClaudeAuthMethod(undefined)).toBeUndefined();
	});
});

describe('readClaudeAccount', () => {
	it('reads email and organization from the oauthAccount stamp', () => {
		const p = join(dir, '.claude.json');
		writeFileSync(
			p,
			JSON.stringify({
				oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' },
				projects: {}
			})
		);
		expect(readClaudeAccount(p)).toEqual({ email: 'me@example.com', organization: 'Acme' });
	});
	it('is empty when the file is missing or has no account', () => {
		expect(readClaudeAccount(join(dir, 'missing.json'))).toEqual({});
		const p = join(dir, '.claude.json');
		writeFileSync(p, JSON.stringify({ projects: {} }));
		expect(readClaudeAccount(p)).toEqual({});
	});
});

describe('readCodexLoginDetails', () => {
	it('names the ChatGPT account and plan from the id_token, never the tokens', () => {
		const idToken = `${b64url({ alg: 'none' })}.${b64url({
			email: 'me@example.com',
			'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'x' }
		})}.sig`;
		const p = join(dir, 'auth.json');
		writeFileSync(
			p,
			JSON.stringify({
				auth_mode: 'chatgpt',
				tokens: { id_token: idToken, access_token: 'secret', refresh_token: 'secret2' }
			})
		);
		const details = readCodexLoginDetails(p);
		expect(details).toEqual({
			loggedIn: true,
			method: 'ChatGPT account',
			email: 'me@example.com',
			plan: 'pro'
		});
		expect(JSON.stringify(details)).not.toContain('secret');
	});
	it('reports an API-key login without exposing the key', () => {
		const p = join(dir, 'auth.json');
		writeFileSync(p, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-hidden' }));
		const details = readCodexLoginDetails(p);
		expect(details.loggedIn).toBe(true);
		expect(JSON.stringify(details)).not.toContain('sk-hidden');
	});
	it('is logged out for a missing file', () => {
		expect(readCodexLoginDetails(join(dir, 'auth.json'))).toEqual({ loggedIn: false });
	});
});
