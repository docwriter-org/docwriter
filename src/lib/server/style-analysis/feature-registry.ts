import type { StyleFamily } from '$lib/style-profile';

export const CHECKLIST_ITEMS = [
	'a1-general', 'a2-nouns', 'a3-adjectives', 'a4-verbs', 'a5-adverbs',
	'b1-sentence-types', 'b2-sentence-complexity', 'b3-clause-types',
	'b4-clause-structure', 'b5-noun-phrases', 'b6-verb-phrases',
	'b7-other-phrases', 'b8-function-words', 'b9-general-grammar',
	'c1-schemes', 'c2-phonological', 'c3-tropes',
	'd1-cohesion', 'd2-context'
] as const;

export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

/** Deliberate checklist omissions must be named and justified here. */
export const EXCLUDED_CHECKLIST_ITEMS: Partial<Record<ChecklistItem, string>> = {};

export interface StyleFeatureDefinition {
	family: StyleFamily;
	label: string;
	metricPrefix: string;
	minimumEvidence: { minimumSources: number; minimumOccurrences: number };
	contexts: string[];
	propositionTypes: string[];
	exampleSelector: { perMetric: number; perFamily: number };
	closeCall: {
		minimumLexicalOverlap: number;
		maximumLengthDelta: number;
		minimumTargetDelta: number;
	};
}

const COMMON_CLOSE_CALL = {
	minimumLexicalOverlap: 0.48,
	maximumLengthDelta: 0.2,
	minimumTargetDelta: 0.01
};

export const STYLE_FEATURE_REGISTRY: Record<StyleFamily, StyleFeatureDefinition> = {
	lexical: {
		family: 'lexical',
		label: 'Lexis (words)',
		metricPrefix: 'lexical.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 1 },
		contexts: ['word', 'phrase', 'sentence', 'whole-source'],
		propositionTypes: [
			'a1-general', 'a2-nouns', 'a3-adjectives', 'a4-verbs', 'a5-adverbs',
			'word-complexity', 'register', 'evaluation', 'concreteness', 'idiom',
			'signature-phrasing', 'semantic-fields', 'noun-choice', 'adjective-use',
			'verb-choice', 'adverb-and-stance'
		],
		exampleSelector: { perMetric: 4, perFamily: 30 },
		closeCall: COMMON_CLOSE_CALL
	},
	grammatical: {
		family: 'grammatical',
		label: 'Grammar (sentences)',
		metricPrefix: 'grammatical.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 1 },
		contexts: ['sentence', 'clause', 'sentence-opening', 'phrase', 'punctuation'],
		propositionTypes: [
			'b1-sentence-types', 'b2-sentence-complexity', 'b3-clause-types',
			'b4-clause-structure', 'b5-noun-phrases', 'b6-verb-phrases',
			'b7-other-phrases', 'b8-function-words', 'b9-general-grammar',
			'sentence-range', 'clause-linking', 'sentence-openers', 'phrase-shape',
			'tense-aspect-voice', 'function-word-pattern', 'punctuation-rhythm'
		],
		exampleSelector: { perMetric: 4, perFamily: 44 },
		closeCall: { ...COMMON_CLOSE_CALL, minimumTargetDelta: 0.02 }
	},
	figures: {
		family: 'figures',
		label: 'Figures (patterns and comparisons)',
		metricPrefix: 'figures.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 1 },
		contexts: ['sentence', 'clause', 'paragraph', 'cross-paragraph'],
		propositionTypes: [
			'c1-schemes', 'c2-phonological', 'c3-tropes', 'repetition',
			'parallelism', 'sound-patterning', 'comparison', 'metaphor-and-analogy',
			'irony-paradox-and-deviation'
		],
		exampleSelector: { perMetric: 4, perFamily: 28 },
		closeCall: COMMON_CLOSE_CALL
	},
	'cohesion-context': {
		family: 'cohesion-context',
		label: 'Discourse (passages and relationships)',
		metricPrefix: 'cohesion.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 1 },
		contexts: ['sentence-link', 'paragraph', 'passage', 'reader-address', 'other-voice'],
		propositionTypes: [
			'd1-cohesion', 'd2-context', 'connective-pattern', 'reference-and-repetition',
			'lexical-chains', 'reader-relationship', 'author-presence', 'stance',
			'quotation-citation-and-attribution'
		],
		exampleSelector: { perMetric: 4, perFamily: 36 },
		closeCall: COMMON_CLOSE_CALL
	}
};

export function propositionTypeIsAllowed(family: StyleFamily, type: string): boolean {
	return STYLE_FEATURE_REGISTRY[family].propositionTypes.includes(type);
}

export function uncoveredChecklistItems(): ChecklistItem[] {
	const covered = new Set(Object.values(STYLE_FEATURE_REGISTRY).flatMap((item) => item.propositionTypes));
	return CHECKLIST_ITEMS.filter((item) => !covered.has(item) && !EXCLUDED_CHECKLIST_ITEMS[item]);
}
