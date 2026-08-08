import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PropositionStatus, StyleProfile } from '$lib/style-profile';

let testRoot = '';
let closeDb: typeof import('$lib/server/db').closeDb;
let failInterruptedStyleRun: typeof import('./interrupted-run').failInterruptedStyleRun;
let readStyleProfile: typeof import('./profile-store').readStyleProfile;
let writeStyleProfile: typeof import('./profile-store').writeStyleProfile;

/** A profile as it is left on disk when the process dies mid-pass: the run
 *  still says running, and whatever the specialists finished is already saved. */
function interruptedProfile(propositionStatus?: PropositionStatus): StyleProfile {
	return {
		schemaVersion: 2,
		analyzerVersion: '2.0.0',
		status: 'analyzing',
		createdAt: 1,
		updatedAt: 1,
		sourceSnapshotHash: 'snapshot',
		lastRun: {
			id: 'run-interrupted',
			status: 'running',
			provider: 'claude',
			phase: 'reflecting',
			progress: 40,
			startedAt: 1,
			updatedAt: 2,
			specialists: [
				{ id: 'lexis', status: 'completed', families: [], completedAt: 2 },
				{ id: 'grammar', status: 'running', families: [] },
				{ id: 'discourse', status: 'pending', families: [] },
				{ id: 'synthesis', status: 'pending', families: [] }
			]
		},
		propositions: propositionStatus
			? [{
					id: 'style-1',
					family: 'grammatical',
					statement: 'The author varies sentence length.',
					instruction: 'Vary sentence length.',
					examples: ['A grounded example sentence.'],
					confidence: 1,
					status: propositionStatus,
					createdAt: 1,
					updatedAt: 1
				}]
			: [],
		calibrations: []
	};
}

beforeAll(async () => {
	testRoot = mkdtempSync(join(tmpdir(), 'docwriter-style-interrupted-'));
	process.env.DOCWRITER_ROOT = testRoot;
	({ closeDb } = await import('$lib/server/db'));
	({ failInterruptedStyleRun } = await import('./interrupted-run'));
	({ readStyleProfile, writeStyleProfile } = await import('./profile-store'));
});

beforeEach(() => {
	writeStyleProfile(interruptedProfile());
});

afterAll(() => {
	closeDb();
	rmSync(testRoot, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('recovering a style run the server was killed during', () => {
	it('fails the run and its unfinished specialists instead of leaving it analyzing forever', () => {
		failInterruptedStyleRun();

		const profile = readStyleProfile();
		expect(profile?.lastRun?.status).toBe('error');
		expect(profile?.lastRun?.error).toMatch(/stopped while this pass was running/i);
		// Nothing was saved, so the profile goes back to the starting line.
		expect(profile?.status).toBe('ready-to-analyze');

		const specialists = profile?.lastRun?.specialists ?? [];
		expect(specialists.find((s) => s.id === 'lexis')?.status).toBe('completed');
		for (const id of ['grammar', 'discourse', 'synthesis']) {
			expect(specialists.find((s) => s.id === id)?.status).toBe('error');
		}
	});

	it('keeps propositions that were saved before the stop', () => {
		writeStyleProfile(interruptedProfile('pending'));
		failInterruptedStyleRun();

		const profile = readStyleProfile();
		expect(profile?.propositions).toHaveLength(1);
		// Something is waiting on the writer, so say so rather than claiming active.
		expect(profile?.status).toBe('needs-calibration');
	});

	it('reports active when the saved propositions need no further answers', () => {
		writeStyleProfile(interruptedProfile('active'));
		failInterruptedStyleRun();

		expect(readStyleProfile()?.status).toBe('active');
	});

	it('does not call a profile active when nothing in it survived review', () => {
		// The drift this pins: propositions exist but are all skipped, so the
		// profile must read ready-to-analyze, exactly as every other path
		// deriving status would report it.
		writeStyleProfile(interruptedProfile('skipped'));
		failInterruptedStyleRun();

		expect(readStyleProfile()?.status).toBe('ready-to-analyze');
	});

	it('leaves a run that finished normally alone', () => {
		const completed = interruptedProfile();
		completed.status = 'active';
		completed.lastRun = { ...completed.lastRun!, status: 'completed', progress: 100, completedAt: 3 };
		writeStyleProfile(completed);

		failInterruptedStyleRun();

		const profile = readStyleProfile();
		expect(profile?.lastRun?.status).toBe('completed');
		expect(profile?.status).toBe('active');
	});
});
