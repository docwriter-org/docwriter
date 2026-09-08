import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasCodexLogin, isUsableCodexAuthFile, linkCodexAuth } from './codex-auth';

let root: string;
let codexHome: string;
let userAuth: string;

const CHATGPT_AUTH = JSON.stringify({
	auth_mode: 'chatgpt',
	OPENAI_API_KEY: null,
	tokens: { id_token: 'x', access_token: 'tok', refresh_token: 'r', account_id: 'a' }
});
const APIKEY_AUTH = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'docwriter-codex-auth-'));
	codexHome = join(root, 'ws', '.docwriter', 'codex');
	mkdirSync(codexHome, { recursive: true });
	mkdirSync(join(root, 'home', '.codex'), { recursive: true });
	userAuth = join(root, 'home', '.codex', 'auth.json');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('isUsableCodexAuthFile', () => {
	it('accepts a ChatGPT login with an access token', () => {
		writeFileSync(userAuth, CHATGPT_AUTH);
		expect(isUsableCodexAuthFile(userAuth)).toBe(true);
	});
	it('accepts an API key stored by `codex login --with-api-key`', () => {
		writeFileSync(userAuth, APIKEY_AUTH);
		expect(isUsableCodexAuthFile(userAuth)).toBe(true);
	});
	it('rejects a logged-out or missing file', () => {
		expect(isUsableCodexAuthFile(userAuth)).toBe(false);
		writeFileSync(userAuth, JSON.stringify({ auth_mode: 'chatgpt', tokens: null }));
		expect(isUsableCodexAuthFile(userAuth)).toBe(false);
	});
});

describe('linkCodexAuth', () => {
	it('symlinks the user login into the workspace CODEX_HOME', () => {
		writeFileSync(userAuth, CHATGPT_AUTH);
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'linked', target: userAuth });
		const local = join(codexHome, 'auth.json');
		expect(lstatSync(local).isSymbolicLink()).toBe(true);
		expect(readFileSync(local, 'utf8')).toBe(CHATGPT_AUTH);
		// Idempotent.
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'linked', target: userAuth });
	});

	it('reports none when the user has never logged in', () => {
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'none' });
		expect(() => lstatSync(join(codexHome, 'auth.json'))).toThrow();
	});

	it('leaves a real workspace-local auth.json alone', () => {
		writeFileSync(userAuth, CHATGPT_AUTH);
		writeFileSync(join(codexHome, 'auth.json'), APIKEY_AUTH);
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'own' });
		expect(lstatSync(join(codexHome, 'auth.json')).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toBe(APIKEY_AUTH);
	});

	it('replaces a dangling link left by an earlier logout', () => {
		const local = join(codexHome, 'auth.json');
		symlinkSync(join(root, 'gone.json'), local);
		writeFileSync(userAuth, CHATGPT_AUTH);
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'linked', target: userAuth });
		expect(readFileSync(local, 'utf8')).toBe(CHATGPT_AUTH);
	});

	it('is a no-op for a dangling link when the user is logged out too', () => {
		const local = join(codexHome, 'auth.json');
		symlinkSync(join(root, 'gone.json'), local);
		expect(linkCodexAuth(codexHome, userAuth)).toEqual({ kind: 'none' });
	});
});

describe('hasCodexLogin', () => {
	it('sees the user login even before the link exists', () => {
		writeFileSync(userAuth, CHATGPT_AUTH);
		expect(hasCodexLogin(codexHome, userAuth)).toBe(true);
	});
	it('prefers a real workspace-local file over the user login', () => {
		writeFileSync(join(codexHome, 'auth.json'), APIKEY_AUTH);
		expect(hasCodexLogin(codexHome, userAuth)).toBe(true);
	});
	it('is false with no credential anywhere', () => {
		expect(hasCodexLogin(codexHome, userAuth)).toBe(false);
	});
});
