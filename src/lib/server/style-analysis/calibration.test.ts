import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StyleAnalysisReport, StyleProfile, StyleProposition } from '$lib/style-profile';
import { analyzeDocuments, normalizeText } from './analyze-style.mjs';

vi.mock('./run-manager', () => ({
	runStructuredStyleAgent: vi.fn(async () => ({
		statement: 'The user confirmed the revised direction.',
		instruction: 'Use the user confirmed form.'
	}))
}));

let testRoot = '';
let answerCalibrationTrial: typeof import('./calibration').answerCalibrationTrial;
let writeStyleProfile: typeof import('./profile-store').writeStyleProfile;
let writeStyleReport: typeof import('./profile-store').writeStyleReport;
let closeDb: typeof import('$lib/server/db').closeDb;

const report: StyleAnalysisReport = {
	schemaVersion: 2,
	analyzerVersion: '2.0.0',
	createdAt: 1,
	sourceSnapshotHash: 'snapshot',
	documents: [{ sourceId: 'source', role: 'authored', format: 'text', contentHash: 'hash', wordCount: 20 }],
	measurements: [{
		id: 'grammatical.b2.words-mean', family: 'grammatical', label: 'Sentence words', unit: 'words', value: 10,
		count: 4, sourceCount: 1, roleValues: { authored: 10 }, reliability: 0.9, occurrenceIds: []
	}],
	conventions: [],
	occurrences: [],
	examples: [{ id: 'example', sourceId: 'source', start: 0, end: 12, text: 'Example text.', kind: 'grammatical' }]
};

function baseProfile(): StyleProfile {
	return {
		schemaVersion: 2,
		analyzerVersion: '2.0.0',
		status: 'needs-calibration',
		createdAt: 1,
		updatedAt: 1,
		sourceSnapshotHash: 'snapshot',
		propositions: [{
			id: 'proposition', family: 'grammatical', statement: 'The author uses a measured range.',
			instruction: 'Use the measured sentence range.', examples: ['A grounded example sentence.'],
			confidence: 0.7, status: 'pending', createdAt: 1, updatedAt: 1
		}],
		calibrations: [{
			id: 'trial', propositionId: 'proposition', status: 'generated', candidateA: 'Candidate A is a good complete passage.',
			candidateB: 'Candidate B is another good complete passage.', targetCandidate: 'a', generatedAt: Date.now() - 100
		}]
	};
}

beforeAll(async () => {
	testRoot = mkdtempSync(join(tmpdir(), 'docwriter-calibration-'));
	process.env.DOCWRITER_ROOT = testRoot;
	({ answerCalibrationTrial } = await import('./calibration'));
	({ writeStyleProfile, writeStyleReport } = await import('./profile-store'));
	({ closeDb } = await import('$lib/server/db'));
});

beforeEach(() => {
	writeStyleReport(report);
	writeStyleProfile(baseProfile());
});

afterAll(() => {
	closeDb();
	rmSync(testRoot, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('calibration answers', () => {
	it('keeps only the chosen passage as the positive example', async () => {
		const result = await answerCalibrationTrial({ id: 'trial', choice: 'a', provider: 'claude' });
		const proposition = result.profile.propositions[0];
		expect(proposition.status).toBe('confirmed');
		expect(proposition.examples[0]).toBe('Candidate A is a good complete passage.');
		expect(proposition).not.toHaveProperty('negativeExample');
	});

	it('revises the instruction when the user chooses the other close call', async () => {
		const result = await answerCalibrationTrial({ id: 'trial', choice: 'b', provider: 'claude' });
		expect(result.profile.propositions[0]).toMatchObject({
			status: 'confirmed',
			instruction: 'Use the user confirmed form.'
		});
		// The chosen passage leads; earlier examples stay behind it.
		expect(result.profile.propositions[0].examples[0]).toBe('Candidate B is another good complete passage.');
	});

	it('marks equivalent candidates as not actionable', async () => {
		const result = await answerCalibrationTrial({ id: 'trial', choice: 'same', provider: 'claude' });
		expect(result.profile.propositions[0].status).toBe('not-actionable');
	});

	it('requires an acceptable edit after neither', async () => {
		await expect(answerCalibrationTrial({ id: 'trial', choice: 'neither', provider: 'claude' }))
			.rejects.toThrow('Edit one candidate');
		await expect(answerCalibrationTrial({ id: 'trial', choice: 'neither', editedText: 'Candidate A is a good complete passage.', provider: 'claude' }))
			.rejects.toThrow('Change one candidate');
		const result = await answerCalibrationTrial({
			id: 'trial', choice: 'neither', editedText: 'This is the user edited acceptable passage.', provider: 'claude'
		});
		expect(result.profile.propositions[0].status).toBe('confirmed');
		expect(result.profile.propositions[0].examples[0]).toBe('This is the user edited acceptable passage.');
	});

	it('skips the unresolved proposition', async () => {
		const result = await answerCalibrationTrial({ id: 'trial', choice: 'skip', provider: 'claude' });
		expect(result.profile.propositions[0].status).toBe('skipped');
		expect(result.trial.status).toBe('skipped');
	});
});
