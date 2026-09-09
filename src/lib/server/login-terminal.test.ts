import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	findOnPath,
	isLoginProvider,
	killLoginSession,
	resolveLoginCommand,
	startLoginSession,
	subscribeLoginSession,
	writeLoginInput
} from './login-terminal';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('findOnPath', () => {
	it('finds an executable in a PATH entry and ignores missing ones', () => {
		const dir = mkdtempSync(join(tmpdir(), 'docwriter-path-'));
		dirs.push(dir);
		writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
		chmodSync(join(dir, 'claude'), 0o755);
		expect(findOnPath('claude', { PATH: `/nonexistent:${dir}` })).toBe(join(dir, 'claude'));
		expect(findOnPath('codex', { PATH: dir })).toBeNull();
	});
});

describe('resolveLoginCommand', () => {
	it('only knows the fixed provider commands and never takes an argv', () => {
		expect(isLoginProvider('claude')).toBe(true);
		expect(isLoginProvider('codex')).toBe(true);
		expect(isLoginProvider('bash')).toBe(false);
		expect(isLoginProvider('claude; rm -rf /')).toBe(false);
		// Codex is a dependency, so it always resolves (PATH or bundled launcher).
		const codex = resolveLoginCommand('codex');
		expect(codex.display).toBe('codex login');
		expect(codex.args[codex.args.length - 1]).toBe('login');
	});
});

describe('login sessions', () => {
	it('streams PTY output, replays it to late subscribers, and reports exit', async () => {
		// Exercise the session plumbing with a stand-in for the CLI: a script on
		// a private PATH named `codex`, so resolveLoginCommand picks it up.
		const dir = mkdtempSync(join(tmpdir(), 'docwriter-pty-'));
		dirs.push(dir);
		writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho "fake login: $1"\nread line\necho "got $line"\nexit 3\n');
		chmodSync(join(dir, 'codex'), 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = dir;
		try {
			const started = await startLoginSession('codex', { cols: 80, rows: 24 });
			expect(started.display).toBe('codex login');
			expect(started.source).toBe('path');
			const seen: string[] = [];
			let exitCode: number | null = null;
			const done = new Promise<void>((resolve) => {
				subscribeLoginSession(started.id, (ev) => {
					if (ev.type === 'data') seen.push(ev.data);
					else {
						exitCode = ev.code;
						resolve();
					}
				});
			});
			// Wait for the prompt line before answering, then answer.
			for (let i = 0; i < 50 && !seen.join('').includes('fake login'); i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(writeLoginInput(started.id, 'hello\r')).toBe(true);
			await done;
			const text = seen.join('');
			expect(text).toContain('fake login: login');
			expect(text).toContain('got hello');
			expect(exitCode).toBe(3);
			// A subscriber arriving after exit gets the replay and the exit.
			const late: string[] = [];
			let lateExit: number | null = null;
			subscribeLoginSession(started.id, (ev) => {
				if (ev.type === 'data') late.push(ev.data);
				else lateExit = ev.code;
			});
			expect(late.join('')).toContain('got hello');
			expect(lateExit).toBe(3);
			expect(writeLoginInput(started.id, 'x')).toBe(false);
			expect(killLoginSession(started.id)).toBe(true);
			expect(subscribeLoginSession(started.id, () => {})).toBeNull();
		} finally {
			process.env.PATH = savedPath;
		}
	}, 15000);
});
