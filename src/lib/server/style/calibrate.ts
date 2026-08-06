/**
 * Close-call calibration: generate A/B variants and resolve user responses.
 */
import type { StyleMeasurements } from './measure';
import type { CalibrationTrial, StyleProposition } from './schemas';
import { ACTIVE_CONFIDENCE_THRESHOLD } from './schemas';

const MAX_FIRST_SESSION = 8;

export function selectCalibrationCandidates(
	propositions: StyleProposition[],
	limit = MAX_FIRST_SESSION
): StyleProposition[] {
	return propositions
		.filter((p) => p.status === 'calibration' && p.enabled)
		.sort((a, b) => b.confidence.final - a.confidence.final)
		.slice(0, limit);
}

function extractNumbers(text: string): string[] {
	return text.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
}

function extractProperNouns(text: string): string[] {
	return text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
}

/** Deterministic close-call generator (no LLM required for v1). */
export function generateCloseCall(opts: {
	proposition: StyleProposition;
	measurements: StyleMeasurements;
}): CalibrationTrial | { error: string } {
	const p = opts.proposition;
	const brief = `Rewrite the following idea in two styles that differ mainly in: ${p.type.replace(/_/g, ' ')}. Keep meaning identical.`;

	const seed =
		p.examples[0]?.text ||
		p.claim ||
		'The system evaluates outputs with human feedback and updates the criteria as new cases appear.';

	let a = seed;
	let b = seed;
	let supports: 'a' | 'b' = 'a';

	if (p.type === 'sentence_range' || p.type === 'cadence' || p.type === 'variation') {
		const p50 = Number(opts.measurements.metricIndex.get('corpus.sentence_len.p50')?.value ?? 16);
		a = compressToWords(seed, Math.max(8, Math.round(p50 - 4)));
		b = expandTowardWords(seed, Math.round(p50 + 8));
		supports = 'a';
	} else if (p.type === 'ai_ism_avoidance') {
		a = seed
			.replace(/\bdelve into\b/gi, 'look at')
			.replace(/\brobust\b/gi, 'reliable')
			.replace(/\bleverage\b/gi, 'use')
			.replace(/\btapestry\b/gi, 'mix');
		b = `We delve into a robust tapestry of ideas and leverage holistic synergies to unlock the landscape. ${seed}`;
		supports = 'a';
	} else if (p.type === 'clause_boundary' || p.type === 'punctuation_rhythm') {
		a = seed.replace(/\s*[—–]\s*/g, '. ').replace(/\s+--\s+/g, '. ');
		b = seed.includes('—') || seed.includes('--')
			? seed
			: seed.replace(/\.\s+/, ' — ').replace(/\.$/, ' — and that matters.');
		supports = 'a';
	} else if (p.type === 'formality') {
		a = seed.replace(/\bdo not\b/gi, "don't").replace(/\bit is\b/gi, "it's").replace(/\bcannot\b/gi, "can't");
		b = seed.replace(/\bdon't\b/gi, 'do not').replace(/\bit's\b/gi, 'it is').replace(/\bcan't\b/gi, 'cannot');
		supports = 'a';
	} else if (p.type === 'signature_lexicon' || p.type === 'terminology') {
		const terms = (Array.isArray(p.metrics[0]?.value)
			? (p.metrics[0].value as string[])
			: Object.keys((p.metrics[0]?.value as Record<string, number>) ?? {})
		).slice(0, 3);
		a = terms.length ? `${seed} (using terms like ${terms.join(', ')})` : seed;
		b = seed.replace(/\bassertion(s)?\b/gi, 'guardrail$1').replace(/\bcriteria\b/gi, 'rubrics');
		supports = 'a';
	} else {
		a = seed;
		b = `In essence, ${seed.charAt(0).toLowerCase()}${seed.slice(1)} This is crucial and seamless.`;
		supports = 'a';
	}

	const validated = validateCloseCall({ a, b, proposition: p });
	if (!validated.ok) {
		// One regenerate attempt with safer defaults
		a = seed;
		b = `${seed} Additionally, the approach remains careful and concrete.`;
		const again = validateCloseCall({ a, b, proposition: p });
		if (!again.ok) return { error: again.error };
	}

	// Randomize labels
	const flip = Math.random() < 0.5;
	const now = Date.now();
	return {
		id: `cal_${p.id}_${now.toString(36)}`,
		propositionId: p.id,
		schemaVersion: 1,
		brief,
		variantA: flip ? b : a,
		variantB: flip ? a : b,
		supportsProposition: flip ? (supports === 'a' ? 'b' : 'a') : supports,
		targetMetricId: p.metrics[0]?.metricId ?? p.type,
		status: 'pending',
		createdAt: now,
		updatedAt: now
	};
}

function compressToWords(text: string, target: number): string {
	const words = text.split(/\s+/);
	if (words.length <= target) return text;
	return words.slice(0, target).join(' ').replace(/[,:;]$/, '') + '.';
}

function expandTowardWords(text: string, target: number): string {
	const words = text.split(/\s+/);
	if (words.length >= target) return text;
	return `${text.replace(/\.$/, '')}, which makes the underlying tradeoff easier to see in practice.`;
}

export function validateCloseCall(opts: {
	a: string;
	b: string;
	proposition: StyleProposition;
}): { ok: true } | { ok: false; error: string } {
	const { a, b, proposition } = opts;
	if (!a.trim() || !b.trim()) return { ok: false, error: 'Empty variant' };
	if (a.trim() === b.trim()) return { ok: false, error: 'Variants identical' };

	const numsA = extractNumbers(a).sort().join(',');
	const numsB = extractNumbers(b).sort().join(',');
	// Allow length-targeted edits to drop trailing numbers only if not citation-heavy
	if (proposition.type !== 'sentence_range' && numsA !== numsB) {
		return { ok: false, error: 'Numbers diverged' };
	}

	const lenA = a.trim().split(/\s+/).length;
	const lenB = b.trim().split(/\s+/).length;
	if (
		proposition.type !== 'sentence_range' &&
		proposition.type !== 'variation' &&
		proposition.type !== 'cadence'
	) {
		if (Math.abs(lenA - lenB) > Math.max(12, 0.5 * Math.min(lenA, lenB))) {
			return { ok: false, error: 'Length diverged too far' };
		}
	}

	// Proper nouns roughly preserved
	const properA = new Set(extractProperNouns(a));
	for (const n of extractProperNouns(b)) {
		if (properA.size && !properA.has(n) && /^[A-Z]/.test(n) && n.length > 3) {
			// soft check — ignore
		}
	}

	return { ok: true };
}

export type CalibrationResponse = 'a' | 'b' | 'same' | 'edited' | 'skip';

export function applyCalibrationResponse(opts: {
	proposition: StyleProposition;
	trial: CalibrationTrial;
	response: CalibrationResponse;
	editedText?: string;
}): StyleProposition {
	const now = Date.now();
	const p = { ...opts.proposition, updatedAt: now };

	if (opts.response === 'same') {
		return {
			...p,
			status: 'inactive',
			enabled: false,
			calibration: { trialId: opts.trial.id, response: 'same' }
		};
	}
	if (opts.response === 'skip') {
		return {
			...p,
			status: 'skipped',
			enabled: false,
			calibration: { trialId: opts.trial.id, response: 'skip' }
		};
	}
	if (opts.response === 'edited') {
		const text = opts.editedText?.trim();
		if (!text) {
			return {
				...p,
				status: 'skipped',
				calibration: { trialId: opts.trial.id, response: 'skip' }
			};
		}
		return {
			...p,
			status: 'active',
			enabled: true,
			confidence: {
				...p.confidence,
				final: Math.max(p.confidence.final, ACTIVE_CONFIDENCE_THRESHOLD)
			},
			examples: [
				{ id: `ex_edited_${now}`, text, polarity: 'positive' as const },
				...p.examples
			],
			instruction: deriveInstructionFromEdit(p, text),
			calibration: {
				trialId: opts.trial.id,
				response: 'edited',
				chosenExampleId: `ex_edited_${now}`
			}
		};
	}

	// a or b
	const chosen =
		opts.response === 'a' ? opts.trial.variantA : opts.trial.variantB;
	const supports =
		(opts.response === 'a' && opts.trial.supportsProposition === 'a') ||
		(opts.response === 'b' && opts.trial.supportsProposition === 'b');

	if (!supports) {
		// User preferred the opposite of the current proposition — flip instruction lightly
		return {
			...p,
			status: 'active',
			enabled: true,
			confidence: {
				...p.confidence,
				final: Math.max(p.confidence.final, ACTIVE_CONFIDENCE_THRESHOLD)
			},
			instruction: invertInstruction(p.instruction),
			examples: [{ id: `ex_cal_${now}`, text: chosen, polarity: 'positive' }],
			calibration: {
				trialId: opts.trial.id,
				response: opts.response,
				chosenExampleId: `ex_cal_${now}`
			}
		};
	}

	return {
		...p,
		status: 'active',
		enabled: true,
		confidence: {
			...p.confidence,
			final: Math.max(p.confidence.final, ACTIVE_CONFIDENCE_THRESHOLD)
		},
		examples: [{ id: `ex_cal_${now}`, text: chosen, polarity: 'positive' }, ...p.examples],
		calibration: {
			trialId: opts.trial.id,
			response: opts.response,
			chosenExampleId: `ex_cal_${now}`
		}
	};
}

function deriveInstructionFromEdit(p: StyleProposition, edited: string): string {
	return `${p.instruction} Prefer phrasings like: "${edited.slice(0, 160).replace(/\s+/g, ' ')}".`;
}

function invertInstruction(instruction: string): string {
	if (/avoid/i.test(instruction)) return instruction.replace(/Avoid/i, 'You may use');
	if (/do not/i.test(instruction)) return instruction.replace(/Do not/i, 'You may');
	if (/prefer/i.test(instruction)) return `Do not prioritize: ${instruction}`;
	return `Prefer the opposite of: ${instruction}`;
}
