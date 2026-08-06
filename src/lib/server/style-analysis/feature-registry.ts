import type { StyleFamily } from '$lib/style-profile';

export interface StyleFeatureDefinition {
	family: StyleFamily;
	label: string;
	metricPrefix: string;
	minimumEvidence: {
		minimumSources: number;
		minimumOccurrences: number;
	};
	contexts: string[];
	propositionTypes: string[];
	exampleSelector: {
		perMetric: number;
		perFamily: number;
	};
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
	'document-organization': {
		family: 'document-organization',
		label: 'Document organization',
		metricPrefix: 'document-organization.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 1 },
		contexts: ['whole-document', 'opening', 'closing'],
		propositionTypes: ['overall-organization', 'hierarchy', 'section-balance', 'document-progression'],
		exampleSelector: { perMetric: 2, perFamily: 12 },
		closeCall: COMMON_CLOSE_CALL
	},
	'section-structure': {
		family: 'section-structure',
		label: 'Section structure',
		metricPrefix: 'section-structure.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 2 },
		contexts: ['heading', 'section-opening', 'section-ending', 'transition'],
		propositionTypes: ['heading-style', 'section-opening', 'section-ending', 'transition-pattern'],
		exampleSelector: { perMetric: 3, perFamily: 16 },
		closeCall: COMMON_CLOSE_CALL
	},
	'paragraph-structure': {
		family: 'paragraph-structure',
		label: 'Paragraph structure',
		metricPrefix: 'paragraph-structure.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 3 },
		contexts: ['opening-paragraph', 'body-paragraph', 'closing-paragraph'],
		propositionTypes: ['paragraph-size', 'topic-sentence-placement', 'development-pattern', 'ending-pattern'],
		exampleSelector: { perMetric: 3, perFamily: 18 },
		closeCall: COMMON_CLOSE_CALL
	},
	'sentence-rhythm': {
		family: 'sentence-rhythm',
		label: 'Sentence and rhythm',
		metricPrefix: 'sentence-rhythm.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 6 },
		contexts: ['sentence', 'paragraph-opening', 'paragraph-ending'],
		propositionTypes: ['sentence-range', 'cadence', 'variation', 'complexity', 'short-sentence-use'],
		exampleSelector: { perMetric: 4, perFamily: 24 },
		closeCall: COMMON_CLOSE_CALL
	},
	'grammar-voice': {
		family: 'grammar-voice',
		label: 'Grammar and voice',
		metricPrefix: 'grammar-voice.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 4 },
		contexts: ['claim', 'instruction', 'explanation', 'qualification'],
		propositionTypes: ['voice', 'stance', 'person', 'certainty', 'directness'],
		exampleSelector: { perMetric: 3, perFamily: 20 },
		closeCall: COMMON_CLOSE_CALL
	},
	'vocabulary-register': {
		family: 'vocabulary-register',
		label: 'Vocabulary and register',
		metricPrefix: 'vocabulary-register.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 8 },
		contexts: ['sentence', 'paragraph', 'whole-document'],
		propositionTypes: ['register', 'lexical-density', 'repetition', 'terminology', 'formality'],
		exampleSelector: { perMetric: 3, perFamily: 20 },
		closeCall: COMMON_CLOSE_CALL
	},
	punctuation: {
		family: 'punctuation',
		label: 'Punctuation',
		metricPrefix: 'punctuation.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 3 },
		contexts: ['terminal', 'clause-boundary', 'enclosure', 'sequence', 'sentence-position'],
		propositionTypes: ['terminal-preference', 'clause-boundary-preference', 'enclosure-preference', 'sequence-preference', 'punctuation-rhythm'],
		exampleSelector: { perMetric: 4, perFamily: 36 },
		closeCall: { ...COMMON_CLOSE_CALL, minimumTargetDelta: 0.02 }
	},
	'rhetorical-structure': {
		family: 'rhetorical-structure',
		label: 'Rhetorical structure',
		metricPrefix: 'rhetorical-structure.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 3 },
		contexts: ['opening', 'claim', 'explanation', 'example', 'concession', 'summary'],
		propositionTypes: ['rhetorical-move-order', 'contrast', 'explanation', 'concession', 'example', 'summary'],
		exampleSelector: { perMetric: 3, perFamily: 24 },
		closeCall: COMMON_CLOSE_CALL
	},
	'evidence-citations': {
		family: 'evidence-citations',
		label: 'Evidence and citations',
		metricPrefix: 'evidence-citations.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 2 },
		contexts: ['claim', 'sentence-ending', 'quotation', 'footnote'],
		propositionTypes: ['citation-placement', 'evidence-integration', 'attribution', 'quotation-style'],
		exampleSelector: { perMetric: 4, perFamily: 24 },
		closeCall: COMMON_CLOSE_CALL
	},
	formatting: {
		family: 'formatting',
		label: 'Formatting',
		metricPrefix: 'formatting.',
		minimumEvidence: { minimumSources: 1, minimumOccurrences: 2 },
		contexts: ['heading', 'list', 'table', 'code', 'blockquote', 'emphasis'],
		propositionTypes: ['formatting-convention', 'visual-hierarchy', 'heading-case', 'list-use', 'emphasis-use'],
		exampleSelector: { perMetric: 3, perFamily: 20 },
		closeCall: COMMON_CLOSE_CALL
	}
};

export function propositionTypeIsAllowed(family: StyleFamily, type: string): boolean {
	return STYLE_FEATURE_REGISTRY[family].propositionTypes.includes(type);
}
