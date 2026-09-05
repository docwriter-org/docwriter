import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testRoot = '';
let closeDb: typeof import('$lib/server/db').closeDb;
let getDb: typeof import('$lib/server/db').getDb;
let store: typeof import('./proposition-store');

beforeAll(async () => {
	testRoot = mkdtempSync(join(tmpdir(), 'docwriter-style-propositions-'));
	process.env.DOCWRITER_ROOT = testRoot;
	({ closeDb, getDb } = await import('$lib/server/db'));
	store = await import('./proposition-store');
});

afterAll(() => {
	closeDb();
	rmSync(testRoot, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('style proposition persistence', () => {
	it('stores each agent submission and the working profile in SQLite', () => {
		store.replaceStyleAgentPropositions('run-1', 'specialist', 'lexis', [
			{ family: 'lexical', instruction: 'Prefer concrete nouns.' },
			{ family: 'lexical', instruction: 'Use familiar words.' }
		]);
		store.replaceStyleAgentPropositions('run-1', 'synthesis', 'synthesis', [
			{ family: 'lexical', instruction: 'Use concrete, familiar words.' }
		]);
		store.writePersistedStyleProfile({
			lastRun: { id: 'run-1' },
			propositions: [{ id: 'style-1', instruction: 'Use concrete, familiar words.' }]
		});

		const snapshots = store.readStylePropositionSnapshots('run-1');
		expect(snapshots.filter((item) => item.stage === 'specialist')).toHaveLength(2);
		expect(snapshots.filter((item) => item.stage === 'synthesis')).toHaveLength(1);
		expect(snapshots.filter((item) => item.stage === 'profile')).toHaveLength(1);
		expect(store.readPersistedStyleProfile()).toMatchObject({
			lastRun: { id: 'run-1' },
			propositions: [{ id: 'style-1' }]
		});
		expect(getDb().pragma('user_version', { simple: true })).toBe(13);
	});

	it('replaces a retry from the same agent without duplicating propositions', () => {
		store.replaceStyleAgentPropositions('run-2', 'specialist', 'grammar', [
			{ family: 'grammatical', instruction: 'First attempt.' }
		]);
		store.replaceStyleAgentPropositions('run-2', 'specialist', 'grammar', [
			{ family: 'grammatical', instruction: 'Successful retry.' }
		]);
		const snapshots = store.readStylePropositionSnapshots('run-2');
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].proposition).toMatchObject({ instruction: 'Successful retry.' });
	});
});
