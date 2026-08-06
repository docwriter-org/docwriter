/**
 * Deterministic feature measurements over NormalizedDocuments.
 */
import type { NormalizedDocument } from './schemas';
import { computeLexiconMetrics, type LexiconMetrics } from './lexicon';
import { analyzePunctuation, type PunctuationMetrics } from './punctuation';

export type MetricValue = number | Record<string, number> | string[] | unknown;

export type FeatureMeasurement = {
	metricId: string;
	family: string;
	summary: string;
	value: MetricValue;
	sourceIds: string[];
	exampleSpanIds?: string[];
};

function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function sentenceWordLengths(doc: NormalizedDocument): number[] {
	return doc.sentences.map((s) => s.text.trim().split(/\s+/).filter(Boolean).length);
}

function hedgeCount(doc: NormalizedDocument): number {
	const hedges = /\b(may|might|could|perhaps|possibly|likely|seem|seems|suggest|suggests|somewhat|rather|often|sometimes)\b/gi;
	return (doc.text.match(hedges) ?? []).length;
}

function passiveProxy(doc: NormalizedDocument): number {
	const re = /\b(?:is|are|was|were|be|been|being)\s+\w+ed\b/gi;
	return (doc.text.match(re) ?? []).length;
}

function citationDensity(doc: NormalizedDocument): number {
	const cites = doc.text.match(/\[[0-9,\s–-]+\]|\([A-Z][A-Za-z-]+(?:\s+et\s+al\.)?,?\s*\d{4}\)/g) ?? [];
	const words = Math.max(1, doc.tokens.length);
	return (cites.length / words) * 1000;
}

export type StyleMeasurements = {
	metrics: FeatureMeasurement[];
	lexicon: LexiconMetrics;
	punctuationBySource: Record<string, PunctuationMetrics>;
	metricIndex: Map<string, FeatureMeasurement>;
};

export function measureDocuments(docs: NormalizedDocument[]): StyleMeasurements {
	const metrics: FeatureMeasurement[] = [];
	const punctuationBySource: Record<string, PunctuationMetrics> = {};
	const allLengths: number[] = [];
	const sourceIds = docs.map((d) => d.sourceId);

	for (const doc of docs) {
		const lengths = sentenceWordLengths(doc);
		allLengths.push(...lengths);
		const punct = analyzePunctuation(doc);
		punctuationBySource[doc.sourceId] = punct;

		metrics.push({
			metricId: `doc.${doc.sourceId}.sentence_len.median`,
			family: 'sentence_rhythm',
			summary: `Median sentence length in ${doc.label ?? doc.sourceId}`,
			value: percentile([...lengths].sort((a, b) => a - b), 0.5),
			sourceIds: [doc.sourceId],
			exampleSpanIds: doc.sentences.slice(0, 2).map((s) => s.id)
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.paragraph.count`,
			family: 'paragraph_structure',
			summary: `Paragraph count`,
			value: doc.paragraphs.length,
			sourceIds: [doc.sourceId]
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.heading.depth_max`,
			family: 'document_organization',
			summary: `Max heading depth`,
			value: Math.max(0, ...doc.sections.map((s) => s.level ?? 0)),
			sourceIds: [doc.sourceId]
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.hedge.rate`,
			family: 'grammar_voice',
			summary: `Hedge markers per 1k words`,
			value: (hedgeCount(doc) / Math.max(1, doc.tokens.length)) * 1000,
			sourceIds: [doc.sourceId]
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.passive.rate`,
			family: 'grammar_voice',
			summary: `Passive-voice proxy per 1k words`,
			value: (passiveProxy(doc) / Math.max(1, doc.tokens.length)) * 1000,
			sourceIds: [doc.sourceId]
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.citation.density`,
			family: 'evidence_citations',
			summary: `Citation markers per 1k words`,
			value: citationDensity(doc),
			sourceIds: [doc.sourceId]
		});
		metrics.push({
			metricId: `doc.${doc.sourceId}.punct.per_thousand`,
			family: 'punctuation',
			summary: `Punctuation rates per 1k words`,
			value: punct.perThousand,
			sourceIds: [doc.sourceId],
			exampleSpanIds: punct.occurrences.slice(0, 5).map((o) => o.spanId)
		});
	}

	const sorted = [...allLengths].sort((a, b) => a - b);
	metrics.push({
		metricId: 'corpus.sentence_len.p25',
		family: 'sentence_rhythm',
		summary: 'Corpus sentence length 25th percentile',
		value: percentile(sorted, 0.25),
		sourceIds
	});
	metrics.push({
		metricId: 'corpus.sentence_len.p50',
		family: 'sentence_rhythm',
		summary: 'Corpus sentence length median',
		value: percentile(sorted, 0.5),
		sourceIds
	});
	metrics.push({
		metricId: 'corpus.sentence_len.p75',
		family: 'sentence_rhythm',
		summary: 'Corpus sentence length 75th percentile',
		value: percentile(sorted, 0.75),
		sourceIds
	});
	metrics.push({
		metricId: 'corpus.sentence_len.iqr',
		family: 'sentence_rhythm',
		summary: 'Corpus sentence length IQR (variation)',
		value: percentile(sorted, 0.75) - percentile(sorted, 0.25),
		sourceIds
	});

	const lexicon = computeLexiconMetrics(docs);
	metrics.push({
		metricId: 'lexicon.signature_words',
		family: 'vocabulary_register',
		summary: 'Distinctive signature words across authored sources',
		value: lexicon.signatureWords.map((w) => w.term),
		sourceIds: lexicon.signatureWords.flatMap((w) => w.sourceIds),
		exampleSpanIds: lexicon.signatureWords.flatMap((w) => w.exampleSpanIds).slice(0, 12)
	});
	metrics.push({
		metricId: 'lexicon.signature_phrases',
		family: 'vocabulary_register',
		summary: 'Recurring distinctive phrases',
		value: lexicon.signaturePhrases.map((w) => w.term),
		sourceIds: lexicon.signaturePhrases.flatMap((w) => w.sourceIds),
		exampleSpanIds: lexicon.signaturePhrases.flatMap((w) => w.exampleSpanIds).slice(0, 12)
	});
	metrics.push({
		metricId: 'lexicon.ai_isms_absent',
		family: 'vocabulary_register',
		summary: 'Common AI-overuse words absent from authored text',
		value: lexicon.aiIsmsAbsent,
		sourceIds
	});
	metrics.push({
		metricId: 'lexicon.diversity',
		family: 'vocabulary_register',
		summary: 'Type/token ratio on content words',
		value: lexicon.lexicalDiversity,
		sourceIds
	});
	metrics.push({
		metricId: 'lexicon.contraction_rate',
		family: 'vocabulary_register',
		summary: 'Contractions per 1k words',
		value: lexicon.contractionRatePerThousand,
		sourceIds
	});
	metrics.push({
		metricId: 'lexicon.avg_word_length',
		family: 'vocabulary_register',
		summary: 'Average content-word length',
		value: lexicon.avgWordLength,
		sourceIds
	});

	let dashRate = 0;
	const punctSources = Object.keys(punctuationBySource);
	for (const punct of Object.values(punctuationBySource)) {
		dashRate +=
			(punct.perThousand['—'] ?? 0) +
			(punct.perThousand['–'] ?? 0) +
			(punct.perThousand['--'] ?? 0);
	}
	dashRate /= Math.max(1, punctSources.length);
	metrics.push({
		metricId: 'corpus.dash.rate',
		family: 'punctuation',
		summary: 'Em/en dash and double-hyphen rate per 1k words',
		value: dashRate,
		sourceIds
	});

	// List/table/code density heuristics
	for (const doc of docs) {
		const listLines = doc.blocks.filter((b) => /^[-*+]\s|\d+\.\s/.test(b.text)).length;
		metrics.push({
			metricId: `doc.${doc.sourceId}.list.density`,
			family: 'formatting',
			summary: 'List-like block density',
			value: listLines / Math.max(1, doc.blocks.length),
			sourceIds: [doc.sourceId]
		});
	}

	const metricIndex = new Map(metrics.map((m) => [m.metricId, m]));
	return { metrics, lexicon, punctuationBySource, metricIndex };
}

/** Families each specialist owns. */
export const SPECIALIST_FAMILIES = {
	organization: [
		'document_organization',
		'section_structure',
		'paragraph_structure',
		'formatting'
	],
	language: ['sentence_rhythm', 'grammar_voice', 'vocabulary_register', 'punctuation'],
	discourse: ['rhetorical_structure', 'evidence_citations']
} as const;

export function metricsForFamilies(
	measurements: StyleMeasurements,
	families: readonly string[]
): FeatureMeasurement[] {
	const set = new Set(families);
	return measurements.metrics.filter((m) => set.has(m.family));
}
