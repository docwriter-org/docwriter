import { describe, expect, it } from 'vitest';
import { STYLE_FAMILIES } from '$lib/style-profile';
import { STYLE_FEATURE_REGISTRY, propositionTypeIsAllowed, uncoveredChecklistItems } from './feature-registry';

describe('style feature registry', () => {
	it('defines measurements, evidence, contexts, propositions, examples, and close calls for every family', () => {
		expect(Object.keys(STYLE_FEATURE_REGISTRY).sort()).toEqual([...STYLE_FAMILIES].sort());
		for (const family of STYLE_FAMILIES) {
			const definition = STYLE_FEATURE_REGISTRY[family];
			expect(definition.metricPrefix).toBe(family === 'cohesion-context' ? 'cohesion.' : `${family}.`);
			expect(definition.contexts.length).toBeGreaterThan(0);
			expect(definition.propositionTypes.length).toBeGreaterThan(0);
			expect(definition.exampleSelector.perMetric).toBeGreaterThan(0);
			expect(definition.closeCall.minimumLexicalOverlap).toBeGreaterThan(0);
		}
	});

	it('rejects free-form proposition types', () => {
		expect(propositionTypeIsAllowed('grammatical', 'punctuation-rhythm')).toBe(true);
		expect(propositionTypeIsAllowed('grammatical', 'whatever-the-agent-invented')).toBe(false);
	});

	it('covers every Leech and Short checklist section', () => {
		expect(uncoveredChecklistItems()).toEqual([]);
	});
});
