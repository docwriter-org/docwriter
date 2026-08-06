/**
 * Deterministic proposition seeds from measurements (used when specialists
 * are unavailable, and as a baseline the synthesis can merge with).
 */
import { computeFinalConfidence, EXTRACTOR_RELIABILITY, statusFromConfidence } from './confidence';
import type { StyleMeasurements } from './measure';
import type { NormalizedDocument, StyleProposition } from './schemas';
import { lookupSpan } from './normalize';

function evidenceFromSpans(
	docs: NormalizedDocument[],
	spanIds: string[] | undefined,
	role: 'authored' | 'inspiration' = 'authored'
) {
	const byId = new Map(docs.map((d) => [d.sourceId, d]));
	const out = [];
	for (const spanId of spanIds ?? []) {
		const sourceId = spanId.split('_')[1] ? spanId.replace(/^[a-z]+_/, '').replace(/_\d+$/, '') : '';
		// span ids look like s_<sourceId>_<n> — sourceId may contain underscores
		const m = spanId.match(/^[a-z]+_(.+)_\d+$/);
		const sid = m?.[1] ?? sourceId;
		const doc = byId.get(sid);
		if (!doc) continue;
		const span = lookupSpan(doc, spanId);
		if (!span) continue;
		out.push({
			sourceId: doc.sourceId,
			spanId,
			quote: span.text.slice(0, 240),
			role: doc.role
		});
	}
	return out;
}

export function buildHeuristicPropositions(
	docs: NormalizedDocument[],
	measurements: StyleMeasurements,
	runId: string
): StyleProposition[] {
	const now = Date.now();
	const props: StyleProposition[] = [];
	const sourceCount = docs.length;
	const authored = docs.filter((d) => d.role === 'authored');

	const p25 = Number(measurements.metricIndex.get('corpus.sentence_len.p25')?.value ?? 0);
	const p50 = Number(measurements.metricIndex.get('corpus.sentence_len.p50')?.value ?? 0);
	const p75 = Number(measurements.metricIndex.get('corpus.sentence_len.p75')?.value ?? 0);
	const iqr = Number(measurements.metricIndex.get('corpus.sentence_len.iqr')?.value ?? 0);

	const sentenceExampleIds =
		measurements.metricIndex.get(`doc.${docs[0]?.sourceId}.sentence_len.median`)?.exampleSpanIds ??
		docs[0]?.sentences.slice(0, 2).map((s) => s.id);

	{
		const evidence = evidenceFromSpans(docs, sentenceExampleIds);
		const conf = computeFinalConfidence({
			evidenceRefs: evidence,
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: Math.min(1, authored.length / 3),
			agentInterpretation: 0.7,
			extractorReliability: EXTRACTOR_RELIABILITY.sentence_rhythm,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		props.push({
			id: `prop_sentence_range_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'sentence_rhythm',
			type: 'sentence_range',
			instruction: `Keep most sentences around ${Math.round(p50)} words (roughly ${Math.round(p25)}–${Math.round(p75)}), matching the author's measured range.`,
			claim: `Median sentence length is about ${p50.toFixed(1)} words (IQR ${iqr.toFixed(1)}).`,
			scope: {},
			metrics: [
				{ metricId: 'corpus.sentence_len.p50', summary: 'Median sentence length', value: p50 },
				{ metricId: 'corpus.sentence_len.p25', summary: 'p25', value: p25 },
				{ metricId: 'corpus.sentence_len.p75', summary: 'p75', value: p75 }
			],
			evidence,
			counterevidence: [],
			examples: evidence.slice(0, 2).map((e, i) => ({
				id: `ex_sent_${i}`,
				text: e.quote,
				sourceId: e.sourceId,
				polarity: 'positive' as const
			})),
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.7,
				extractorReliability: EXTRACTOR_RELIABILITY.sentence_rhythm,
				final: conf.final
			},
			origin: 'authored',
			status: statusFromConfidence(conf.final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	if (iqr >= 6) {
		const conf = computeFinalConfidence({
			evidenceRefs: evidenceFromSpans(docs, sentenceExampleIds),
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: 0.6,
			agentInterpretation: 0.65,
			extractorReliability: EXTRACTOR_RELIABILITY.sentence_rhythm,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		props.push({
			id: `prop_variation_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'sentence_rhythm',
			type: 'variation',
			instruction:
				'Vary sentence length deliberately: mix longer explanatory sentences with occasional short ones, rather than keeping a flat cadence.',
			claim: `Sentence length IQR is ${iqr.toFixed(1)}, indicating real variation.`,
			scope: {},
			metrics: [{ metricId: 'corpus.sentence_len.iqr', summary: 'IQR', value: iqr }],
			evidence: evidenceFromSpans(docs, sentenceExampleIds),
			counterevidence: [],
			examples: [],
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.65,
				extractorReliability: EXTRACTOR_RELIABILITY.sentence_rhythm,
				final: conf.final
			},
			origin: 'authored',
			status: statusFromConfidence(conf.final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	const absent = measurements.lexicon.aiIsmsAbsent;
	if (absent.length) {
		const conf = computeFinalConfidence({
			evidenceRefs: [],
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: 1,
			agentInterpretation: 0.85,
			extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		// Absence evidence is corpus-wide — boost by treating as multi-doc agreement
		const boosted = Math.min(0.9, conf.final + (authored.length >= 2 ? 0.15 : 0));
		props.push({
			id: `prop_ai_ism_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'vocabulary_register',
			type: 'ai_ism_avoidance',
			instruction: `Do not use these AI-typical words the author avoids: ${absent.slice(0, 12).join(', ')}.`,
			claim: `These overused AI words are absent from the authored references.`,
			scope: {},
			metrics: [
				{
					metricId: 'lexicon.ai_isms_absent',
					summary: 'Absent AI-isms',
					value: Object.fromEntries(absent.slice(0, 12).map((w, i) => [w, i]))
				}
			],
			evidence: [],
			counterevidence: [],
			examples: [],
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.85,
				extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
				final: boosted
			},
			origin: 'authored',
			status: statusFromConfidence(boosted, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	const sig = measurements.lexicon.signatureWords.slice(0, 10);
	if (sig.length) {
		const spanIds = sig.flatMap((s) => s.exampleSpanIds).slice(0, 6);
		const evidence = evidenceFromSpans(docs, spanIds);
		const conf = computeFinalConfidence({
			evidenceRefs: evidence,
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: Math.min(1, sig[0]?.documentFrequency ?? 0 / 3),
			agentInterpretation: 0.7,
			extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		props.push({
			id: `prop_signature_lexicon_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'vocabulary_register',
			type: 'signature_lexicon',
			instruction: `Prefer the author's recurring vocabulary when it fits: ${sig.map((s) => s.term).join(', ')}.`,
			claim: 'Signature words recur across the authored references.',
			scope: {},
			metrics: [
				{
					metricId: 'lexicon.signature_words',
					summary: 'Signature words',
					value: Object.fromEntries(sig.map((s) => [s.term, s.count]))
				}
			],
			evidence,
			counterevidence: [],
			examples: evidence.slice(0, 3).map((e, i) => ({
				id: `ex_lex_${i}`,
				text: e.quote,
				sourceId: e.sourceId,
				polarity: 'positive' as const
			})),
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.7,
				extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
				final: conf.final
			},
			origin: 'authored',
			status: statusFromConfidence(conf.final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	const phrases = measurements.lexicon.signaturePhrases.slice(0, 6);
	if (phrases.length) {
		const conf = computeFinalConfidence({
			evidenceRefs: evidenceFromSpans(
				docs,
				phrases.flatMap((p) => p.exampleSpanIds).slice(0, 4)
			),
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: 0.7,
			agentInterpretation: 0.72,
			extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		props.push({
			id: `prop_terminology_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'vocabulary_register',
			type: 'terminology',
			instruction: `Reuse the author's characteristic phrases when relevant: ${phrases.map((p) => `"${p.term}"`).join(', ')}.`,
			claim: 'These multi-word phrases recur across sources.',
			scope: {},
			metrics: [
				{
					metricId: 'lexicon.signature_phrases',
					summary: 'Signature phrases',
					value: Object.fromEntries(phrases.map((p) => [p.term, p.count]))
				}
			],
			evidence: evidenceFromSpans(
				docs,
				phrases.flatMap((p) => p.exampleSpanIds).slice(0, 4)
			),
			counterevidence: [],
			examples: [],
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.72,
				extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
				final: conf.final
			},
			origin: 'authored',
			status: statusFromConfidence(conf.final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	const contraction = Number(measurements.metricIndex.get('lexicon.contraction_rate')?.value ?? 0);
	if (contraction > 5) {
		const conf = computeFinalConfidence({
			evidenceRefs: [],
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: 0.8,
			agentInterpretation: 0.75,
			extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		const final = Math.min(0.8, conf.final + 0.1);
		props.push({
			id: `prop_contractions_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'vocabulary_register',
			type: 'formality',
			instruction: 'Contractions are fine; prefer natural contracted forms over stiff expanded ones.',
			claim: `Contraction rate ≈ ${contraction.toFixed(1)} per 1k words.`,
			scope: { genres: ['blog', 'informal'] },
			metrics: [
				{ metricId: 'lexicon.contraction_rate', summary: 'Contractions/1k', value: contraction }
			],
			evidence: [],
			counterevidence: [],
			examples: [],
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.75,
				extractorReliability: EXTRACTOR_RELIABILITY.vocabulary_register,
				final
			},
			origin: 'authored',
			status: statusFromConfidence(final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	// Punctuation: em-dash / double-hyphen avoidance if rare
	let dashRate = 0;
	for (const punct of Object.values(measurements.punctuationBySource)) {
		dashRate += (punct.perThousand['—'] ?? 0) + (punct.perThousand['–'] ?? 0) + (punct.perThousand['--'] ?? 0);
	}
	dashRate /= Math.max(1, Object.keys(measurements.punctuationBySource).length);
	if (dashRate < 1) {
		const conf = computeFinalConfidence({
			evidenceRefs: [],
			counterevidence: [],
			sourceCount,
			matchingContextRepetition: 0.9,
			agentInterpretation: 0.8,
			extractorReliability: EXTRACTOR_RELIABILITY.punctuation,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		const final = Math.min(0.85, conf.final + (authored.length >= 2 ? 0.2 : 0.05));
		props.push({
			id: `prop_no_dash_${runId.slice(0, 6)}`,
			schemaVersion: 1,
			family: 'punctuation',
			type: 'clause_boundary',
			instruction:
				'Avoid em dashes and en dashes. Join clauses with a period or with words like "and" or "because".',
			claim: `Dash punctuation is rare in the references (≈ ${dashRate.toFixed(2)} / 1k words).`,
			scope: {},
			metrics: [{ metricId: 'corpus.dash.rate', summary: 'Dash rate', value: dashRate }],
			evidence: [],
			counterevidence: [],
			examples: [],
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: 0.8,
				extractorReliability: EXTRACTOR_RELIABILITY.punctuation,
				final
			},
			origin: 'authored',
			status: statusFromConfidence(final, true),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		});
	}

	return props;
}
