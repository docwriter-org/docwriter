/**
 * Close-call calibration: agent-generated A/B variants + resolve user responses.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProvider } from '../providers';
import type { ProviderId, ToolDefinition } from '../providers/types';
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

	return { ok: true };
}

type CloseCallDraft = {
	propositionId: string;
	brief: string;
	variantA: string;
	variantB: string;
	supportsProposition: 'a' | 'b';
};

function buildCloseCallSubmitTool(
	allowedIds: Set<string>,
	propById: Map<string, StyleProposition>,
	onAccept: (drafts: CloseCallDraft[]) => { ok: boolean; error?: string }
): ToolDefinition {
	return {
		name: 'submit_close_calls',
		description:
			'Submit A/B close-call calibration pairs for uncertain style propositions.',
		inputSchema: {
			type: 'object',
			properties: {
				closeCalls: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							propositionId: { type: 'string' },
							brief: { type: 'string' },
							variantA: { type: 'string' },
							variantB: { type: 'string' },
							supportsProposition: { type: 'string', enum: ['a', 'b'] }
						},
						required: [
							'propositionId',
							'brief',
							'variantA',
							'variantB',
							'supportsProposition'
						]
					}
				}
			},
			required: ['closeCalls']
		},
		execute: async (input) => {
			const parsed = z
				.object({
					closeCalls: z.array(
						z.object({
							propositionId: z.string(),
							brief: z.string().min(1),
							variantA: z.string().min(1),
							variantB: z.string().min(1),
							supportsProposition: z.enum(['a', 'b'])
						})
					)
				})
				.safeParse(input);
			if (!parsed.success) {
				return {
					content: [{ type: 'text', text: `Rejected: ${parsed.error.message}` }],
					isError: true
				};
			}
			for (const c of parsed.data.closeCalls) {
				if (!allowedIds.has(c.propositionId)) {
					return {
						content: [
							{ type: 'text', text: `Rejected: unknown propositionId ${c.propositionId}` }
						],
						isError: true
					};
				}
				const prop = propById.get(c.propositionId)!;
				const v = validateCloseCall({ a: c.variantA, b: c.variantB, proposition: prop });
				if (!v.ok) {
					return {
						content: [
							{
								type: 'text',
								text: `Rejected close call for ${c.propositionId}: ${v.error}`
							}
						],
						isError: true
					};
				}
			}
			const result = onAccept(parsed.data.closeCalls);
			if (!result.ok) {
				return {
					content: [{ type: 'text', text: `Rejected: ${result.error}` }],
					isError: true
				};
			}
			return { content: [{ type: 'text', text: 'Close calls accepted.' }] };
		}
	};
}

function buildCloseCallMcp(
	allowedIds: Set<string>,
	propById: Map<string, StyleProposition>,
	onAccept: (drafts: CloseCallDraft[]) => { ok: boolean; error?: string }
) {
	return createSdkMcpServer({
		name: 'docwriter-style-calibrate',
		version: '0.0.1',
		tools: [
			tool(
				'submit_close_calls',
				'Submit A/B close-call calibration pairs for uncertain style propositions.',
				{
					closeCalls: z.array(
						z.object({
							propositionId: z.string(),
							brief: z.string().min(1),
							variantA: z.string().min(1),
							variantB: z.string().min(1),
							supportsProposition: z.enum(['a', 'b'])
						})
					)
				},
				async (input) => {
					for (const c of input.closeCalls) {
						if (!allowedIds.has(c.propositionId)) {
							return {
								content: [
									{
										type: 'text',
										text: `Rejected: unknown propositionId ${c.propositionId}`
									}
								],
								isError: true
							};
						}
						const prop = propById.get(c.propositionId)!;
						const v = validateCloseCall({
							a: c.variantA,
							b: c.variantB,
							proposition: prop
						});
						if (!v.ok) {
							return {
								content: [
									{
										type: 'text',
										text: `Rejected close call for ${c.propositionId}: ${v.error}`
									}
								],
								isError: true
							};
						}
					}
					const result = onAccept(input.closeCalls);
					if (!result.ok) {
						return {
							content: [{ type: 'text', text: `Rejected: ${result.error}` }],
							isError: true
						};
					}
					return { content: [{ type: 'text', text: 'Close calls accepted.' }] };
				}
			)
		]
	});
}

function draftsToTrials(drafts: CloseCallDraft[], propById: Map<string, StyleProposition>): CalibrationTrial[] {
	const now = Date.now();
	return drafts.map((c, i) => {
		const prop = propById.get(c.propositionId)!;
		const flip = Math.random() < 0.5;
		return {
			id: `cal_${c.propositionId}_${now.toString(36)}_${i}`,
			propositionId: c.propositionId,
			schemaVersion: 1 as const,
			brief: c.brief,
			variantA: flip ? c.variantB : c.variantA,
			variantB: flip ? c.variantA : c.variantB,
			supportsProposition: flip
				? c.supportsProposition === 'a'
					? ('b' as const)
					: ('a' as const)
				: c.supportsProposition,
			targetMetricId: prop.metrics[0]?.metricId ?? prop.type,
			status: 'pending' as const,
			createdAt: now,
			updatedAt: now
		};
	});
}

/**
 * Ask the selected provider to write close-call A/B pairs for uncertain
 * propositions. No deterministic string mangling — the user's agent authors
 * the variants via submit_close_calls.
 */
export async function generateCloseCallsWithAgent(opts: {
	propositions: StyleProposition[];
	measurements: StyleMeasurements;
	provider: ProviderId;
	model?: string;
	abortSignal?: AbortSignal;
}): Promise<CalibrationTrial[]> {
	const candidates = selectCalibrationCandidates(opts.propositions, MAX_FIRST_SESSION);
	if (!candidates.length) return [];

	const propById = new Map(candidates.map((p) => [p.id, p]));
	const allowedIds = new Set(propById.keys());
	let accepted: CloseCallDraft[] | undefined;
	let lastError: string | undefined;

	const onAccept = (drafts: CloseCallDraft[]) => {
		if (!drafts.length) return { ok: false, error: 'No close calls submitted' };
		accepted = drafts;
		return { ok: true };
	};

	const tools = [buildCloseCallSubmitTool(allowedIds, propById, onAccept)];
	const provider = await getProvider(opts.provider);

	const candidateBlob = JSON.stringify(
		candidates.map((p) => ({
			id: p.id,
			family: p.family,
			type: p.type,
			instruction: p.instruction,
			claim: p.claim,
			metrics: p.metrics,
			examples: p.examples.slice(0, 2).map((e) => e.text),
			evidenceQuotes: p.evidence.slice(0, 3).map((e) => e.quote)
		})),
		null,
		2
	);

	const metricHint = JSON.stringify(
		opts.measurements.metrics
			.filter((m) =>
				candidates.some((p) => p.metrics.some((pm) => pm.metricId === m.metricId))
			)
			.slice(0, 40)
			.map((m) => ({
				metricId: m.metricId,
				summary: m.summary,
				value: m.value
			})),
		null,
		2
	);

	const prompt = `You write close-call calibration pairs for DocWriter's author-style skill.
For each uncertain proposition below, invent TWO short prose variants (A and B) that differ mainly on that style dimension, with nearly identical meaning.
Mark which label currently supports the proposition (supportsProposition).
Write in a register that fits the proposition's claim — do not default every pair to generic "plain writing" / anti-AI style.
Do not invent facts. Keep numbers/names stable unless the proposition is about sentence length.
Call submit_close_calls exactly once covering as many propositions as you can (max ${candidates.length}).

PROPOSITIONS:
${candidateBlob}

RELATED METRICS:
${metricHint}`;

	try {
		for await (const event of provider.query(
			{
				prompt,
				systemPrompt:
					'You create A/B style close calls. Call submit_close_calls once. No document edits.',
				model: opts.model,
				allowedTools: [
					'submit_close_calls',
					'mcp__docwriter-style-calibrate__submit_close_calls'
				],
				effort: 'medium',
				omitDefaultMcpServers: true,
				extraMcpServers: {
					'docwriter-style-calibrate': buildCloseCallMcp(allowedIds, propById, onAccept)
				},
				abortSignal: opts.abortSignal
			},
			tools
		)) {
			if (opts.abortSignal?.aborted) break;
			if (event.type === 'error') lastError = event.error;
		}
	} catch (err) {
		lastError = (err as Error).message;
	}

	if (!accepted?.length) {
		throw new Error(lastError ?? 'Calibration agent did not submit close calls');
	}

	return draftsToTrials(accepted, propById);
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
	const chosen = opts.response === 'a' ? opts.trial.variantA : opts.trial.variantB;
	const supports =
		(opts.response === 'a' && opts.trial.supportsProposition === 'a') ||
		(opts.response === 'b' && opts.trial.supportsProposition === 'b');

	if (!supports) {
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
