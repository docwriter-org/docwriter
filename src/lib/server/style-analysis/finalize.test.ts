import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	hasUnpublishedStyleChanges,
	publishedStylePropositions,
	type StyleAnalysisReport,
	type StyleProfile
} from '$lib/style-profile';

let testRoot = '';
let closeDb: typeof import('$lib/server/db').closeDb;
let finalizeStyleProfile: typeof import('./finalize').finalizeStyleProfile;
let writeStyleProfile: typeof import('./profile-store').writeStyleProfile;
let writeStyleReport: typeof import('./profile-store').writeStyleReport;
let readStyleProfile: typeof import('./profile-store').readStyleProfile;
let readStylePropositionSnapshots: typeof import('./proposition-store').readStylePropositionSnapshots;

const report: StyleAnalysisReport = {
	schemaVersion: 2,
	analyzerVersion: '2.0.0',
	createdAt: 1,
	sourceSnapshotHash: 'snapshot',
	documents: [{ sourceId: 'source', role: 'authored', format: 'text', contentHash: 'hash', wordCount: 20 }],
	measurements: [],
	conventions: [],
	occurrences: [],
	examples: []
};

function profile(status: 'active' | 'pending' = 'active'): StyleProfile {
	return {
		schemaVersion: 2,
		analyzerVersion: '2.0.0',
		status: status === 'pending' ? 'needs-calibration' : 'active',
		createdAt: 1,
		updatedAt: 1,
		sourceSnapshotHash: 'snapshot',
		lastRun: {
			id: 'run-finalize', status: 'completed', provider: 'claude', phase: 'completed',
			progress: 100, startedAt: 1, updatedAt: 2, completedAt: 2, specialists: []
		},
		propositions: [{
			id: 'style-1', family: 'grammatical', statement: 'The author varies sentence length.',
			instruction: 'Vary sentence length.', examples: ['A grounded example sentence.'],
			confidence: 1, status, createdAt: 1, updatedAt: 1
		}],
		calibrations: []
	};
}

beforeAll(async () => {
	testRoot = mkdtempSync(join(tmpdir(), 'docwriter-style-finalize-'));
	process.env.DOCWRITER_ROOT = testRoot;
	({ closeDb } = await import('$lib/server/db'));
	({ finalizeStyleProfile } = await import('./finalize'));
	({ readStyleProfile, writeStyleProfile, writeStyleReport } = await import('./profile-store'));
	({ readStylePropositionSnapshots } = await import('./proposition-store'));
});

beforeEach(() => {
	writeStyleReport(report);
	writeStyleProfile(profile());
});

afterAll(() => {
	closeDb();
	rmSync(testRoot, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('style finalization', () => {
	it('publishes the reviewed propositions and records the published snapshot', () => {
		const compile = vi.fn(() => ({
			skillId: 'author-style',
			skillPath: join(testRoot, '.docwriter', 'skills', 'author-style')
		}));
		const result = finalizeStyleProfile(compile as Parameters<typeof finalizeStyleProfile>[0]);

		expect(compile).toHaveBeenCalledOnce();
		expect(result.publishedAt).toBeTypeOf('number');
		expect(result.publishedPropositions).toEqual(result.propositions);
		expect(result.skillId).toBe('author-style');
		expect(hasUnpublishedStyleChanges(result)).toBe(false);
		expect(readStylePropositionSnapshots('run-finalize').some((item) => item.stage === 'published')).toBe(true);

		writeStyleProfile({
			...result,
			propositions: result.propositions.map((item) => ({ ...item, instruction: 'A new draft instruction.' }))
		});
		const draft = readStyleProfile()!;
		expect(hasUnpublishedStyleChanges(draft)).toBe(true);
		expect(publishedStylePropositions(draft)[0].instruction).toBe('Vary sentence length.');
	});

	it('does not publish while a proposition still needs review', () => {
		writeStyleProfile(profile('pending'));
		const compile = vi.fn(() => ({ skillId: 'author-style', skillPath: '/unused' }));
		expect(() => finalizeStyleProfile(compile as Parameters<typeof finalizeStyleProfile>[0]))
			.toThrow('Finish or skip every pending proposition');
		expect(compile).not.toHaveBeenCalled();
	});
});
