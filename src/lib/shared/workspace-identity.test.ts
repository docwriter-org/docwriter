import { describe, expect, it } from 'vitest';
import {
	describeWorkspace,
	findConflictingStateDir,
	formatConflictWarning,
	resolveWorkspaceRoot
} from './workspace-identity';

describe('resolveWorkspaceRoot', () => {
	it('uses a positional / --root argument over cwd', () => {
		expect(
			resolveWorkspaceRoot({
				rootArg: '/writing/book',
				cwd: '/repos/docwriter'
			})
		).toBe('/writing/book');
	});

	it('resolves a relative folder argument against cwd', () => {
		expect(
			resolveWorkspaceRoot({
				rootArg: 'notes',
				cwd: '/home/ada'
			})
		).toBe('/home/ada/notes');
	});

	it('falls back to DOCWRITER_ROOT, then cwd', () => {
		expect(
			resolveWorkspaceRoot({
				envRoot: '/from/env',
				cwd: '/repos/docwriter'
			})
		).toBe('/from/env');
		expect(resolveWorkspaceRoot({ cwd: '/repos/docwriter' })).toBe('/repos/docwriter');
	});
});

describe('describeWorkspace', () => {
	it('puts .docwriter inside the opened folder, not the invoke cwd', () => {
		const identity = describeWorkspace('/writing/book');
		expect(identity.root).toBe('/writing/book');
		expect(identity.stateDir).toBe('/writing/book/.docwriter');
		expect(identity.name).toBe('book');
	});
});

describe('findConflictingStateDir', () => {
	it('warns when cwd has its own .docwriter and is not the workspace', () => {
		const conflict = findConflictingStateDir({
			root: '/writing/book',
			cwd: '/repos/docwriter',
			cwdHasState: true
		});
		expect(conflict).toEqual({
			cwd: '/repos/docwriter',
			cwdStateDir: '/repos/docwriter/.docwriter'
		});
		const identity = describeWorkspace('/writing/book');
		expect(formatConflictWarning(identity, conflict!)).toContain(
			'/repos/docwriter/.docwriter'
		);
		expect(formatConflictWarning(identity, conflict!)).toContain(
			'/writing/book/.docwriter'
		);
	});

	it('is silent when cwd is the workspace or has no .docwriter', () => {
		expect(
			findConflictingStateDir({
				root: '/writing/book',
				cwd: '/writing/book',
				cwdHasState: true
			})
		).toBeNull();
		expect(
			findConflictingStateDir({
				root: '/writing/book',
				cwd: '/repos/docwriter',
				cwdHasState: false
			})
		).toBeNull();
	});
});
