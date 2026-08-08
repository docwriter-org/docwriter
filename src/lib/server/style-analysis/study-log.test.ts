import { describe, expect, it } from 'vitest';
import { scrubStyleStudyData } from './study-log';

describe('style study privacy', () => {
	it('removes raw references, prompts, passages, and edits at every depth', () => {
		expect(scrubStyleStudyData({
			condition: 'compiled-author-skill',
			prompt: 'private prompt',
			nested: { candidateA: 'private passage', durationMs: 20 },
			rows: [{ editedText: 'private edit', choice: 'a' }]
		})).toEqual({
			condition: 'compiled-author-skill',
			nested: { durationMs: 20 },
			rows: [{ choice: 'a' }]
		});
	});
});
