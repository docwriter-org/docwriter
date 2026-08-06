/**
 * Code-side confidence for style propositions.
 */
import {
	ACTIVE_CONFIDENCE_THRESHOLD,
	ROLE_CONFLICT_CAP,
	SINGLE_SOURCE_CAP,
	type EvidenceRef,
	type StyleProposition
} from './schemas';

export type ConfidenceInput = {
	evidenceRefs: EvidenceRef[];
	counterevidence: EvidenceRef[];
	sourceCount: number;
	matchingContextRepetition: number; // 0–1
	agentInterpretation: number; // 0–1
	extractorReliability: number; // 0–1
	authoredAgree: boolean;
	inspirationAgree: boolean;
	roleConflict: boolean;
};

export function computeEvidenceScore(input: ConfidenceInput): number {
	const uniqueSources = new Set(input.evidenceRefs.map((e) => e.sourceId));
	const sourceCoverage = Math.min(1, uniqueSources.size / Math.max(1, input.sourceCount));
	const agreementAcrossDocs = Math.min(1, uniqueSources.size / Math.max(1, Math.min(3, input.sourceCount)));
	const repetition = Math.min(1, Math.max(0, input.matchingContextRepetition));
	const roleAgreement =
		input.roleConflict ? 0.35 : input.authoredAgree || input.inspirationAgree ? 0.9 : 0.55;

	return (
		0.35 * sourceCoverage +
		0.3 * agreementAcrossDocs +
		0.2 * repetition +
		0.15 * roleAgreement
	);
}

export function computeFinalConfidence(input: ConfidenceInput): {
	evidence: number;
	final: number;
} {
	const evidence = computeEvidenceScore(input);
	let final =
		input.extractorReliability * (0.75 * evidence + 0.25 * input.agentInterpretation);

	const uniqueSources = new Set(input.evidenceRefs.map((e) => e.sourceId));
	if (uniqueSources.size <= 1) final = Math.min(final, SINGLE_SOURCE_CAP);
	if (input.roleConflict) final = Math.min(final, ROLE_CONFLICT_CAP);

	return { evidence, final: clamp01(final) };
}

function clamp01(n: number) {
	return Math.max(0, Math.min(1, n));
}

export function statusFromConfidence(
	final: number,
	actionable: boolean
): StyleProposition['status'] {
	if (!actionable) return 'observation';
	if (final >= ACTIVE_CONFIDENCE_THRESHOLD) return 'active';
	return 'calibration';
}

export const EXTRACTOR_RELIABILITY: Record<string, number> = {
	document_organization: 0.85,
	section_structure: 0.8,
	paragraph_structure: 0.85,
	sentence_rhythm: 0.9,
	grammar_voice: 0.75,
	vocabulary_register: 0.85,
	punctuation: 0.92,
	rhetorical_structure: 0.7,
	evidence_citations: 0.85,
	formatting: 0.8
};
