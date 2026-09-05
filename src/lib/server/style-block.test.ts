import { describe, expect, it } from 'vitest';
import type { StyleProfile, StyleProposition } from '$lib/style-profile';
import { buildStyleBlock, snapshotStyle } from './style-block';

function proposition(instruction: string, status: StyleProposition['status'] = 'active'): StyleProposition {
	return {
		id: 'style-' + instruction.length,
		family: 'grammatical',
		statement: 'The author does this.',
		instruction,
		examples: ['A grounded example sentence.'],
		confidence: 1,
		status,
		createdAt: 1,
		updatedAt: 1
	};
}

function profile(instructions: string[], skillId = 'author-style'): StyleProfile {
	return {
		schemaVersion: 2,
		analyzerVersion: '2.0.0',
		status: 'active',
		createdAt: 1,
		updatedAt: 1,
		sourceSnapshotHash: 'snapshot',
		skillId,
		propositions: [],
		publishedPropositions: instructions.map((text) => proposition(text)),
		calibrations: []
	};
}

const ONE = profile(['Write "row-by-row" instead of "one row at a time".']);

describe('the author_style block says the whole style once per transcript', () => {
	// Every turn used to carry the full instruction list, so the author's own
	// words sat under the same bullets each time. A transcript that already
	// holds the list gets a one-line reminder; one that does not gets the list.
	it('is absent when no style is published', () => {
		expect(buildStyleBlock({ profile: null, prior: null, fresh: true }).text).toBeNull();
		expect(snapshotStyle(null)).toBe('');
		expect(buildStyleBlock({ profile: profile([]), prior: null, fresh: true }).text).toBeNull();
	});

	it('sends the full instructions on the first turn of a session', () => {
		const { text, snapshot } = buildStyleBlock({ profile: ONE, prior: null, fresh: true });
		expect(text).toContain('How I write, learned from a handful of pieces I wrote.');
		expect(text).toContain('- Write "row-by-row" instead of "one row at a time".');
		expect(text).toContain('Read the `author-style` skill before you write.');
		expect(snapshot).toBe(snapshotStyle(ONE));
	});

	it('sends the full instructions on a fresh session even when a stale snapshot exists', () => {
		// The snapshot belongs to another transcript (New session, a provider
		// switch, a warmup-minted session): this one has seen nothing.
		const { text } = buildStyleBlock({ profile: ONE, prior: snapshotStyle(ONE), fresh: true });
		expect(text).toContain('- Write "row-by-row"');
		expect(text).not.toContain('has changed since my last message');
	});

	it('sends a one-line reminder when the transcript already holds the current list', () => {
		const { text, snapshot } = buildStyleBlock({ profile: ONE, prior: snapshotStyle(ONE), fresh: false });
		expect(text).toMatch(/^How I write: unchanged since my last message\./);
		expect(text).toContain('`author-style` skill');
		expect(text).not.toContain('- Write "row-by-row"');
		expect(text?.split('\n').length).toBe(1);
		expect(snapshot).toBe(snapshotStyle(ONE));
	});

	it('resends the full list, marked as changed, when an instruction changes mid-session', () => {
		const changed = profile(['Write "row-by-row" instead of "one row at a time".', 'Open with "Consider".']);
		const { text } = buildStyleBlock({ profile: changed, prior: snapshotStyle(ONE), fresh: false });
		expect(text).toContain('How I write has changed since my last message. This replaces what I said before.');
		expect(text).toContain('- Open with "Consider".');
		expect(text).toContain('Read the `author-style` skill before you write.');
	});

	it('says once that a style the transcript knew is gone', () => {
		const { text, snapshot } = buildStyleBlock({ profile: profile([]), prior: snapshotStyle(ONE), fresh: false });
		expect(text).toContain('no longer active');
		expect(snapshot).toBe('');
		// And nothing more on the turn after that.
		expect(buildStyleBlock({ profile: profile([]), prior: '', fresh: false }).text).toBeNull();
	});

	it('ignores propositions that are not active and names the profile\'s own skill', () => {
		const p = profile([], 'my-voice');
		p.publishedPropositions = [proposition('Keep this.'), proposition('Drop this.', 'disabled')];
		const { text } = buildStyleBlock({ profile: p, prior: null, fresh: true });
		expect(text).toContain('- Keep this.');
		expect(text).not.toContain('Drop this.');
		expect(text).toContain('Read the `my-voice` skill');
	});
});
