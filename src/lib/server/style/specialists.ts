/**
 * Specialist + synthesis Agent SDK runs with typed submission tools.
 * Heuristics are only used when explicitly requested (tests/dev).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProvider } from '../providers';
import type { ProviderId, ToolDefinition } from '../providers/types';
import {
	FEATURE_FAMILIES,
	PROPOSITION_TYPES,
	SpecialistSubmissionSchema,
	type NormalizedDocument,
	type SpecialistSubmission,
	type StyleProposition
} from './schemas';
import {
	metricsForFamilies,
	SPECIALIST_FAMILIES,
	type FeatureMeasurement,
	type StyleMeasurements
} from './measure';
import { quoteMatchesSpan } from './normalize';
import { computeFinalConfidence, EXTRACTOR_RELIABILITY, statusFromConfidence } from './confidence';
import { buildHeuristicPropositions } from './heuristic-propositions';

export type SpecialistName = 'organization' | 'language' | 'discourse' | 'synthesis';

export type SpecialistResult = {
	name: SpecialistName;
	ok: boolean;
	error?: string;
	submission?: SpecialistSubmission;
	rawPropositions: StyleProposition[];
};

function docsById(docs: NormalizedDocument[]) {
	return new Map(docs.map((d) => [d.sourceId, d]));
}

export function validateSubmission(
	raw: unknown,
	docs: NormalizedDocument[],
	allowedFamilies: readonly string[],
	metricIndex: Map<string, FeatureMeasurement>
): { ok: true; submission: SpecialistSubmission } | { ok: false; error: string } {
	const parsed = SpecialistSubmissionSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.message };
	}
	const familySet = new Set(allowedFamilies);
	const docMap = docsById(docs);
	const propositions = [];
	for (const prop of parsed.data.propositions) {
		if (!familySet.has(prop.family)) {
			return { ok: false, error: `Unsupported family for this specialist: ${prop.family}` };
		}
		for (const mid of prop.metricIds) {
			if (!metricIndex.has(mid)) {
				return { ok: false, error: `Unknown metric id: ${mid}` };
			}
		}
		const evidence = [];
		for (const ev of prop.evidence ?? []) {
			const doc = docMap.get(ev.sourceId);
			if (!doc) return { ok: false, error: `Unknown sourceId in evidence: ${ev.sourceId}` };
			if (!quoteMatchesSpan(doc, ev.spanId, ev.quote)) {
				return {
					ok: false,
					error: `Evidence quote/span mismatch for ${ev.spanId}`
				};
			}
			evidence.push({ ...ev, role: doc.role });
		}
		const counterevidence = [];
		for (const ev of prop.counterevidence ?? []) {
			const doc = docMap.get(ev.sourceId);
			if (!doc) return { ok: false, error: `Unknown sourceId in evidence: ${ev.sourceId}` };
			if (!quoteMatchesSpan(doc, ev.spanId, ev.quote)) {
				return {
					ok: false,
					error: `Evidence quote/span mismatch for ${ev.spanId}`
				};
			}
			counterevidence.push({ ...ev, role: doc.role });
		}
		if (
			prop.interpretationConfidence < 0 ||
			prop.interpretationConfidence > 1 ||
			Number.isNaN(prop.interpretationConfidence)
		) {
			return { ok: false, error: 'Invalid interpretationConfidence' };
		}
		propositions.push({
			...prop,
			evidence,
			counterevidence
		});
	}
	return { ok: true, submission: { propositions } };
}

export function submissionToPropositions(
	submission: SpecialistSubmission,
	docs: NormalizedDocument[],
	runId: string,
	metricIndex: Map<string, FeatureMeasurement>,
	specialistName: SpecialistName = 'language'
): StyleProposition[] {
	const now = Date.now();
	const sourceCount = docs.length;
	return submission.propositions.map((p, idx) => {
		const uniqueSources = new Set(p.evidence.map((e) => e.sourceId));
		const roles = new Set(p.evidence.map((e) => e.role));
		const roleConflict = roles.has('authored') && roles.has('inspiration');
		const conf = computeFinalConfidence({
			evidenceRefs: p.evidence,
			counterevidence: p.counterevidence,
			sourceCount,
			matchingContextRepetition: Math.min(1, uniqueSources.size / Math.max(1, sourceCount)),
			agentInterpretation: p.interpretationConfidence,
			extractorReliability: EXTRACTOR_RELIABILITY[p.family] ?? 0.75,
			authoredAgree: roles.has('authored'),
			inspirationAgree: roles.has('inspiration'),
			roleConflict
		});
		const metrics = p.metricIds.map((metricId) => {
			const m = metricIndex.get(metricId);
			return {
				metricId,
				summary: m?.summary ?? metricId,
				value: typeof m?.value === 'number' ? m.value : undefined
			};
		});
		return {
			id: `prop_${specialistName}_${p.type}_${runId.slice(0, 6)}_${idx}`,
			schemaVersion: 1 as const,
			family: p.family,
			type: p.type,
			instruction: p.instruction,
			claim: p.claim,
			scope: p.scope ?? {},
			metrics,
			evidence: p.evidence,
			counterevidence: p.counterevidence,
			examples: p.examples.map((ex, i) => ({
				id: `ex_${specialistName}_${idx}_${i}`,
				text: ex.text,
				sourceId: ex.sourceId,
				polarity: 'positive' as const
			})),
			confidence: {
				evidence: conf.evidence,
				agentInterpretation: p.interpretationConfidence,
				extractorReliability: EXTRACTOR_RELIABILITY[p.family] ?? 0.75,
				final: conf.final
			},
			origin: p.origin ?? (roleConflict ? 'mixed' : roles.has('inspiration') ? 'aspirational' : 'authored'),
			status: statusFromConfidence(conf.final, p.actionable),
			enabled: true,
			createdAt: now,
			updatedAt: now,
			sourceRunId: runId
		};
	});
}

function specialistPrompt(
	name: SpecialistName,
	metrics: FeatureMeasurement[],
	extra = ''
): string {
	const metricBlob = JSON.stringify(
		metrics.map((m) => ({
			metricId: m.metricId,
			family: m.family,
			summary: m.summary,
			value: m.value,
			exampleSpanIds: m.exampleSpanIds?.slice(0, 4),
			sourceIds: m.sourceIds
		})),
		null,
		2
	);

	const languageBrief =
		name === 'language'
			? `
WORD CHOICE IS YOUR PRIMARY JOB.
- Prioritize unusual or characteristic word/phrase choices from lexicon.signature_words and lexicon.signature_phrases.
- Emit concrete "do not use" guidance from lexicon.ai_isms_absent.
- Prefer instructions like "Say X, not Y" over vague "use varied vocabulary".
- Every word-choice claim must cite metric IDs and evidence span quotes from the metric examples.
`
			: '';

	const allowed =
		name === 'synthesis'
			? [...FEATURE_FAMILIES]
			: [...SPECIALIST_FAMILIES[name as keyof typeof SPECIALIST_FAMILIES]];

	return `You are the ${name} style specialist for DocWriter. You cannot edit documents or run shell commands.
Analyze ONLY these metrics / examples and submit typed propositions via the submit_style_propositions tool.

Allowed families: ${allowed.join(', ')}
Allowed proposition types: ${PROPOSITION_TYPES.join(', ')}

${languageBrief}
${extra}

METRICS:
${metricBlob}

Call submit_style_propositions exactly once with your best propositions. Do not invent metric IDs, quotations, or spans.`;
}

function buildSubmitTool(
	onSubmit: (input: unknown) => { ok: boolean; error?: string }
): ToolDefinition {
	return {
		name: 'submit_style_propositions',
		description: 'Submit typed style propositions with metric and evidence citations.',
		inputSchema: {
			type: 'object',
			properties: {
				propositions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							family: { type: 'string', enum: [...FEATURE_FAMILIES] },
							type: { type: 'string', enum: [...PROPOSITION_TYPES] },
							instruction: { type: 'string' },
							claim: { type: 'string' },
							metricIds: { type: 'array', items: { type: 'string' } },
							evidence: { type: 'array' },
							counterevidence: { type: 'array' },
							examples: { type: 'array' },
							interpretationConfidence: { type: 'number' },
							actionable: { type: 'boolean' },
							origin: { type: 'string' },
							scope: { type: 'object' }
						},
						required: ['family', 'type', 'instruction', 'metricIds', 'interpretationConfidence']
					}
				}
			},
			required: ['propositions']
		},
		execute: async (input) => {
			const result = onSubmit(input);
			if (!result.ok) {
				return {
					content: [{ type: 'text', text: `Rejected: ${result.error}` }],
					isError: true
				};
			}
			return { content: [{ type: 'text', text: 'Propositions accepted.' }] };
		}
	};
}

/** Claude MCP server for specialist submission (mounted alongside restricted tools). */
export function buildStyleSpecialistMcp(
	onSubmit: (input: unknown) => { ok: boolean; error?: string }
) {
	return createSdkMcpServer({
		name: 'docwriter-style',
		version: '0.0.1',
		tools: [
			tool(
				'submit_style_propositions',
				'Submit typed style propositions with metric and evidence citations.',
				{
					propositions: z.array(
						z.object({
							family: z.enum(FEATURE_FAMILIES),
							type: z.enum(PROPOSITION_TYPES),
							instruction: z.string(),
							claim: z.string().optional(),
							metricIds: z.array(z.string()).min(1),
							evidence: z
								.array(
									z.object({
										sourceId: z.string(),
										spanId: z.string(),
										quote: z.string(),
										role: z.enum(['authored', 'inspiration'])
									})
								)
								.optional(),
							counterevidence: z
								.array(
									z.object({
										sourceId: z.string(),
										spanId: z.string(),
										quote: z.string(),
										role: z.enum(['authored', 'inspiration'])
									})
								)
								.optional(),
							examples: z
								.array(
									z.object({
										text: z.string(),
										sourceId: z.string().optional(),
										spanId: z.string().optional()
									})
								)
								.optional(),
							interpretationConfidence: z.number().min(0).max(1),
							actionable: z.boolean().optional(),
							origin: z.enum(['authored', 'aspirational', 'mixed']).optional(),
							scope: z
								.object({
									genres: z.array(z.string()).optional(),
									audiences: z.array(z.string()).optional(),
									sections: z.array(z.string()).optional(),
									appliesWhen: z.string().optional()
								})
								.optional()
						})
					)
				},
				async (input) => {
					const result = onSubmit(input);
					if (!result.ok) {
						return {
							content: [{ type: 'text', text: `Rejected: ${result.error}` }],
							isError: true
						};
					}
					return { content: [{ type: 'text', text: 'Propositions accepted.' }] };
				}
			)
		]
	});
}

const ALL_FAMILIES = [...FEATURE_FAMILIES];

async function runSpecialistWithProvider(opts: {
	name: SpecialistName;
	docs: NormalizedDocument[];
	measurements: StyleMeasurements;
	provider: ProviderId;
	model?: string;
	runId: string;
	abortSignal?: AbortSignal;
	allowedFamilies?: readonly string[];
	promptExtra?: string;
	metricsOverride?: FeatureMeasurement[];
}): Promise<SpecialistResult> {
	if (opts.abortSignal?.aborted) {
		return {
			name: opts.name,
			ok: false,
			error: 'cancelled',
			rawPropositions: []
		};
	}

	const families =
		opts.allowedFamilies ??
		(opts.name === 'synthesis'
			? ALL_FAMILIES
			: SPECIALIST_FAMILIES[opts.name as keyof typeof SPECIALIST_FAMILIES]);
	const metrics =
		opts.metricsOverride ??
		(opts.name === 'synthesis'
			? opts.measurements.metrics
			: metricsForFamilies(opts.measurements, families));
	let accepted: SpecialistSubmission | undefined;
	let lastError: string | undefined;

	const onSubmit = (input: unknown) => {
		const v = validateSubmission(input, opts.docs, families, opts.measurements.metricIndex);
		if (!v.ok) {
			lastError = v.error;
			return { ok: false, error: v.error };
		}
		accepted = v.submission;
		return { ok: true };
	};

	const tools = [buildSubmitTool(onSubmit)];
	const provider = await getProvider(opts.provider);
	const prompt = specialistPrompt(opts.name, metrics, opts.promptExtra ?? '');

	try {
		for await (const event of provider.query(
			{
				prompt,
				systemPrompt:
					'You extract executable writing-style propositions. Call submit_style_propositions once. No document edits.',
				model: opts.model,
				allowedTools: [
					'submit_style_propositions',
					'mcp__docwriter-style__submit_style_propositions'
				],
				effort: 'medium',
				omitDefaultMcpServers: true,
				extraMcpServers: {
					'docwriter-style': buildStyleSpecialistMcp(onSubmit)
				},
				abortSignal: opts.abortSignal
			},
			tools
		)) {
			if (opts.abortSignal?.aborted) {
				lastError = 'cancelled';
				break;
			}
			if (event.type === 'error') {
				lastError = event.error;
			}
		}
	} catch (err) {
		lastError = (err as Error).message;
	}

	if (!accepted) {
		return {
			name: opts.name,
			ok: false,
			error: lastError ?? 'Specialist did not submit propositions',
			rawPropositions: []
		};
	}

	return {
		name: opts.name,
		ok: true,
		submission: accepted,
		rawPropositions: submissionToPropositions(
			accepted,
			opts.docs,
			opts.runId,
			opts.measurements.metricIndex,
			opts.name
		)
	};
}

/** Local dedupe: keep highest-confidence prop per type. */
export function dedupePropositions(propositions: StyleProposition[]): StyleProposition[] {
	const byType = new Map<string, StyleProposition>();
	for (const p of propositions) {
		const prev = byType.get(p.type);
		if (!prev || p.confidence.final > prev.confidence.final) {
			byType.set(p.type, p);
		}
	}
	return [...byType.values()].sort((a, b) => b.confidence.final - a.confidence.final);
}

/** @deprecated use dedupePropositions — kept for call-site clarity during migration */
export function synthesizePropositions(propositions: StyleProposition[]): StyleProposition[] {
	return dedupePropositions(propositions);
}

export async function runSynthesisAgent(opts: {
	docs: NormalizedDocument[];
	measurements: StyleMeasurements;
	provider: ProviderId;
	model?: string;
	runId: string;
	candidates: StyleProposition[];
	abortSignal?: AbortSignal;
}): Promise<{ result: SpecialistResult; propositions: StyleProposition[] }> {
	const candidateBlob = JSON.stringify(
		opts.candidates.map((p) => ({
			family: p.family,
			type: p.type,
			instruction: p.instruction,
			claim: p.claim,
			metricIds: p.metrics.map((m) => m.metricId),
			evidence: p.evidence,
			counterevidence: p.counterevidence,
			examples: p.examples.slice(0, 2).map((e) => ({ text: e.text, sourceId: e.sourceId })),
			interpretationConfidence: p.confidence.agentInterpretation,
			origin: p.origin,
			scope: p.scope
		})),
		null,
		2
	);

	const result = await runSpecialistWithProvider({
		name: 'synthesis',
		docs: opts.docs,
		measurements: opts.measurements,
		provider: opts.provider,
		model: opts.model,
		runId: opts.runId,
		abortSignal: opts.abortSignal,
		allowedFamilies: ALL_FAMILIES,
		metricsOverride: opts.measurements.metrics,
		promptExtra: `
You are the SYNTHESIS pass. Merge the specialist candidates below into a coherent, non-redundant set.
- Prefer concrete imperative instructions.
- Drop duplicates and weak / ungrounded claims.
- Keep distinctive lexicon / AI-ism guidance when well supported.
- Cite only metric IDs and evidence spans that appear in the metrics or candidate evidence.

CANDIDATE PROPOSITIONS:
${candidateBlob}
`
	});

	if (result.ok && result.rawPropositions.length) {
		return { result, propositions: dedupePropositions(result.rawPropositions) };
	}
	// Fallback: local dedupe of specialist output (never heuristics).
	return {
		result: {
			...result,
			ok: false,
			error: result.error ?? 'Synthesis agent failed; using local dedupe'
		},
		propositions: dedupePropositions(opts.candidates)
	};
}

export async function runSpecialists(opts: {
	docs: NormalizedDocument[];
	measurements: StyleMeasurements;
	provider?: ProviderId;
	model?: string;
	runId: string;
	useHeuristicsOnly?: boolean;
	abortSignal?: AbortSignal;
}): Promise<{ results: SpecialistResult[]; propositions: StyleProposition[] }> {
	if (opts.useHeuristicsOnly) {
		const raw = buildHeuristicPropositions(opts.docs, opts.measurements, opts.runId);
		const inFamilies = (families: readonly string[]) =>
			raw.filter((p) => (families as readonly string[]).includes(p.family));
		return {
			results: [
				{ name: 'organization', ok: true, rawPropositions: inFamilies(SPECIALIST_FAMILIES.organization) },
				{ name: 'language', ok: true, rawPropositions: inFamilies(SPECIALIST_FAMILIES.language) },
				{ name: 'discourse', ok: true, rawPropositions: inFamilies(SPECIALIST_FAMILIES.discourse) }
			],
			propositions: raw
		};
	}

	if (!opts.provider) {
		throw new Error('Provider required for specialist agent passes');
	}

	const names: Array<'organization' | 'language' | 'discourse'> = [
		'organization',
		'language',
		'discourse'
	];
	const results = await Promise.all(
		names.map(async (name) => {
			let result = await runSpecialistWithProvider({
				...opts,
				name,
				provider: opts.provider!
			});
			if (!result.ok && !opts.abortSignal?.aborted) {
				result = await runSpecialistWithProvider({
					...opts,
					name,
					provider: opts.provider!
				});
			}
			return result;
		})
	);

	if (opts.abortSignal?.aborted) {
		throw new Error('cancelled');
	}

	const succeeded = results.filter((r) => r.ok);
	if (!succeeded.length) {
		const detail = results.map((r) => `${r.name}: ${r.error ?? 'failed'}`).join('; ');
		throw new Error(`All specialist agents failed (${detail})`);
	}

	// Partial success: keep only agent props. Never merge heuristics on the product path.
	const fromAgents = results.flatMap((r) => r.rawPropositions);
	if (!fromAgents.length) {
		throw new Error('Specialists returned no propositions');
	}

	return { results, propositions: fromAgents };
}
