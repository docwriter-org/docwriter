import { EventEmitter } from 'node:events';
import type {
	FeatureMeasurement,
	NormalizedDocument,
	SpecialistRunState,
	StyleAnalysisReport,
	StyleAnalysisRun,
	StyleFamily,
	StyleProfile,
	StyleProposition
} from '$lib/style-profile';
import type { ProviderEvent, ProviderId, ToolDefinition } from '$lib/server/providers/types';
import { getProvider } from '$lib/server/providers';
import { analyzeDocuments } from './analyze-style.mjs';
import {
	materializeAllReferences,
	normalizedDocumentFromMaterialized
} from './materialize';
import {
	createStyleProfile,
	propositionFromDraft,
	readStyleProfile,
	validateDraftGrounding,
	writeStyleProfile,
	writeStyleReport
} from './profile-store';
import {
	SpecialistSubmissionSchema,
	SynthesisSubmissionSchema,
	type PropositionDraft,
	type SpecialistSubmission,
	type SynthesisSubmission
} from './schemas';
import { compileAuthorStyleSkill } from './skill-compiler';
import { appendStyleStudyEvent } from './study-log';
import { STYLE_FEATURE_REGISTRY } from './feature-registry';
import { listStyleReferences } from '$lib/server/references';

/** One line of a specialist's working trace, streamed as it happens. */
export interface SpecialistLogEntry {
	specialistId: SpecialistRunState['id'];
	kind: 'text' | 'thinking' | 'tool';
	text?: string;
	toolName?: string;
}

export interface StyleRunEvent {
	type: 'snapshot' | 'progress' | 'specialist' | 'specialist_log' | 'completed' | 'error' | 'cancelled';
	run: StyleAnalysisRun;
	message?: string;
	log?: SpecialistLogEntry;
}

interface ManagedRun {
	state: StyleAnalysisRun;
	abortController: AbortController;
	emitter: EventEmitter;
	profile?: StyleProfile;
	priorProfile: StyleProfile | null;
}

const jobs = new Map<string, ManagedRun>();
let activeRunId: string | null = null;

const SPECIALISTS: Array<{ id: SpecialistRunState['id']; families: StyleFamily[]; label: string }> = [
	{
		id: 'organization',
		label: 'organization specialist',
		families: ['document-organization', 'section-structure', 'paragraph-structure', 'formatting']
	},
	{
		id: 'language',
		label: 'language specialist',
		families: ['sentence-rhythm', 'grammar-voice', 'vocabulary-register', 'punctuation']
	},
	{
		id: 'discourse',
		label: 'discourse specialist',
		families: ['rhetorical-structure', 'evidence-citations']
	}
];

function now() {
	return Date.now();
}

function publicRun(run: ManagedRun): StyleAnalysisRun {
	return JSON.parse(JSON.stringify(run.state)) as StyleAnalysisRun;
}

function emit(run: ManagedRun, type: StyleRunEvent['type'], message?: string) {
	run.state.updatedAt = now();
	if (run.profile) {
		run.profile.lastRun = publicRun(run);
		run.profile = writeStyleProfile(run.profile);
	}
	run.emitter.emit('event', { type, run: publicRun(run), message } satisfies StyleRunEvent);
}

/** Trace lines are high-volume, so they skip the profile write that emit() does. */
function emitLog(run: ManagedRun, log: SpecialistLogEntry) {
	run.emitter.emit('event', {
		type: 'specialist_log',
		run: publicRun(run),
		log
	} satisfies StyleRunEvent);
}

function updateSpecialist(
	run: ManagedRun,
	id: SpecialistRunState['id'],
	patch: Partial<SpecialistRunState>
) {
	run.state.specialists = run.state.specialists.map((specialist) => specialist.id === id ? { ...specialist, ...patch } : specialist);
	emit(run, 'specialist');
}

function draftJsonSchema() {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['propositions'],
		properties: {
			propositions: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['family', 'statement', 'instruction', 'examples', 'confidence'],
					properties: {
						family: { type: 'string' },
						statement: {
							type: 'string',
							description: 'The pattern, phrased as something you could tell a ghostwriter.'
						},
						instruction: { type: 'string', description: 'What to do when writing.' },
						examples: {
							type: 'array',
							description: 'Three or more passages quoted verbatim from the sources that show this proposition in action.',
							items: { type: 'string' }
						},
						confidence: {
							type: 'number',
							minimum: 0,
							maximum: 1,
							description: 'How strongly the writing supports this pattern.'
						}
					}
				}
			},
			notes: { type: 'string' },
			summary: { type: 'string' }
		}
	};
}

/**
 * A metric that never fired says nothing about how someone writes — a personal
 * page with no tables should not produce a proposition about tables. Zero-valued
 * measurements are dropped before a specialist ever sees them.
 */
export function isMeasured(measurement: FeatureMeasurement): boolean {
	return measurement.count > 0 && measurement.value !== 0;
}

function reportSlice(report: StyleAnalysisReport, families: StyleFamily[]) {
	const measurements = report.measurements.filter(
		(measurement) => families.includes(measurement.family) && isMeasured(measurement)
	);
	const occurrenceIds = new Set(measurements.flatMap((measurement) => {
		const limit = STYLE_FEATURE_REGISTRY[measurement.family].exampleSelector.perMetric;
		return measurement.occurrenceIds.slice(0, limit);
	}));
	const occurrences = report.occurrences.filter((occurrence) => occurrenceIds.has(occurrence.id));
	const examples = families.flatMap((family) => report.examples
		.filter((example) => example.kind === family || example.kind.startsWith(`${family}.`))
		.slice(0, STYLE_FEATURE_REGISTRY[family].exampleSelector.perFamily));
	return {
		schemaVersion: report.schemaVersion,
		sourceSnapshotHash: report.sourceSnapshotHash,
		featureDefinitions: families.map((family) => STYLE_FEATURE_REGISTRY[family]),
		documents: report.documents,
		measurements,
		occurrences,
		examples
	};
}

function specialistSystemPrompt(families: StyleFamily[]): string {
	return `You analyze writing style by reading the author's actual writing. Work only on these families: ${families.join(', ')}.

You are given the measurements that fired, the author's characteristic vocabulary, and then the source texts themselves. The measurements tell you where to look; the writing tells you what is actually going on. Read the writing before you conclude anything.

Create actionable style propositions. Every one must carry at least three examples: passages quoted verbatim from the sources that show the proposition in action. Copy them exactly — an example that does not appear in the sources word for word is discarded, and the proposition with it. Quote whole sentences, not fragments. Do not supply counter-examples.

What makes a proposition worth emitting:
- It describes a choice another writer could imitate or violate — sentence shape, how evidence is introduced, how a point is landed, what register is held.
- It would change how a draft reads if applied.
- A reader could disagree with it. If nobody could plausibly write the opposite way, it is not a style choice.

What to leave out:
- Anything about a feature the author does not use. Only measured, non-zero behavior appears in the report; do not write propositions about what is absent.
- Corpus statistics. Medians, ranges, counts, and distributions across the sources are not style choices. "Document lengths range from 13 to 26,000 words (median 2,158)" and "paragraph count closely tracks block count" describe the sample, not how to write. Never put a number from the report into a statement.
- Observations that hold for the corpus but cannot guide a single sentence or paragraph the author is about to write.
- Restatements of a metric. "Heading density is 0" is a measurement, not a style proposition.
- Facts about the reference topics or the author's biography.

Write each statement as something you could tell a ghostwriter. If a statement only makes sense while looking at a spreadsheet of the sources, it does not belong.

Prefer fewer, sharper propositions over many mechanical ones. Do not call any tool except submit_style_families. Call that tool once with the complete result.`;
}

/** Every kept source as one blob, for checking quoted examples against. */
export function corpusText(documents: NormalizedDocument[]): string {
	return documents.map((document) => document.text).join('\n\n');
}

/** Vocabulary carries voice, so specialists see the author's words up front. */
function characteristicVocabulary(documents: NormalizedDocument[], limit = 60): string[] {
	const counts = new Map<string, number>();
	for (const document of documents) {
		for (const token of document.tokens) {
			if (token.kind !== 'word') continue;
			const word = token.normalized.toLowerCase();
			if (word.length < 5) continue;
			counts.set(word, (counts.get(word) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([word]) => word);
}

/** Enough of each source to judge how it is written, without flooding context. */
function sourceExcerpts(documents: NormalizedDocument[], perDocument = 6000): string {
	return documents
		.map((document, index) => {
			const text = document.text.trim();
			const excerpt = text.length > perDocument ? `${text.slice(0, perDocument)}\n[…]` : text;
			return `--- SOURCE ${index + 1} (${document.role}, ${document.format}) ---\n${excerpt}`;
		})
		.join('\n\n');
}

function specialistPrompt(
	report: StyleAnalysisReport,
	documents: NormalizedDocument[],
	families: StyleFamily[]
): string {
	const vocabulary = characteristicVocabulary(documents);
	return [
		'Measurements that fired for your families (zero-valued metrics are already removed):',
		JSON.stringify(reportSlice(report, families)),
		'',
		`Characteristic vocabulary: ${vocabulary.join(', ')}`,
		'',
		'The writing itself — read this before concluding anything:',
		'',
		sourceExcerpts(documents)
	].join('\n');
}

function synthesisSystemPrompt(): string {
	return `You synthesize writing style propositions from three specialists into the guidance a writer will actually see. Preserve metric IDs and evidence IDs exactly, and do not invent evidence.

Merge hard. Two propositions that would lead a writer to make the same edit are the same proposition, even when they are worded differently, cite different metrics, or came from different specialists — combine them and keep the sharpest wording. Only keep them separate when following one would produce a visibly different sentence than following the other.

Drop propositions that:
- restate a measurement instead of directing a choice,
- describe something the author does not do,
- are so general that no competent writer would do otherwise.

Keep authored behavior descriptive and inspiration preferences aspirational when they differ. Aim for the smallest set that fully captures this writer's voice — a focused profile beats an exhaustive one. Call submit_style_profile exactly once.`;
}

export async function runStructuredStyleAgent<T>(input: {
	providerId: ProviderId;
	model?: string;
	systemPrompt: string;
	prompt: string;
	toolName: string;
	toolDescription: string;
	inputSchema: Record<string, unknown>;
	parse: (value: unknown) => T;
	abortSignal: AbortSignal;
	/** Observe the agent's working trace. Purely for display. */
	onEvent?: (event: ProviderEvent) => void;
}): Promise<T> {
	let submission: T | undefined;
	const toolDefinition: ToolDefinition = {
		name: input.toolName,
		description: input.toolDescription,
		inputSchema: input.inputSchema,
		execute: async (value) => {
			try {
				submission = input.parse(value);
				return { content: [{ type: 'text', text: 'Style analysis accepted.' }] };
			} catch (error) {
				return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		}
	};
	const provider = await getProvider(input.providerId);
	let providerError: string | null = null;
	for await (const event of provider.query({
		prompt: input.prompt,
		systemPrompt: input.systemPrompt,
		model: input.model,
		allowedTools: [input.toolName],
		abortSignal: input.abortSignal,
		effort: 'medium',
		isolatedTools: true
	}, [toolDefinition])) {
		input.onEvent?.(event);
		if (event.type === 'error') providerError = event.error;
	}
	if (input.abortSignal.aborted) throw new Error('Style analysis was cancelled');
	if (!submission) throw new Error(providerError || `Agent did not call ${input.toolName}`);
	return submission;
}

/**
 * Turn a specialist's provider events into trace lines. Text and thinking arrive
 * as deltas, so they are accumulated per message and re-emitted whole — the
 * client replaces the open line rather than collecting half-words.
 */
function makeSpecialistForwarder(run: ManagedRun, specialistId: SpecialistRunState['id']) {
	let text = '';
	let thinking = '';
	return (event: ProviderEvent) => {
		if (event.type === 'assistant_text') {
			text += event.text;
			if (text.trim()) emitLog(run, { specialistId, kind: 'text', text: text.trim() });
		} else if (event.type === 'assistant_thinking') {
			thinking += event.text;
			if (thinking.trim()) emitLog(run, { specialistId, kind: 'thinking', text: thinking.trim() });
		} else if (event.type === 'tool_call') {
			text = '';
			thinking = '';
			emitLog(run, {
				specialistId,
				kind: 'tool',
				toolName: event.tool_name.split('__').pop() ?? event.tool_name
			});
		}
	};
}

const specialistForwarders = new Map<string, (event: ProviderEvent) => void>();

function forwardSpecialistEvent(
	run: ManagedRun,
	specialistId: SpecialistRunState['id'],
	event: ProviderEvent
) {
	const key = `${run.state.id}:${specialistId}`;
	let forwarder = specialistForwarders.get(key);
	if (!forwarder) {
		forwarder = makeSpecialistForwarder(run, specialistId);
		specialistForwarders.set(key, forwarder);
	}
	forwarder(event);
}

async function runSpecialist(
	run: ManagedRun,
	report: StyleAnalysisReport,
	documents: NormalizedDocument[],
	specialist: (typeof SPECIALISTS)[number]
): Promise<PropositionDraft[]> {
	updateSpecialist(run, specialist.id, { status: 'running', startedAt: now(), error: undefined });
	const execute = async () => runStructuredStyleAgent<SpecialistSubmission>({
		providerId: run.state.provider as ProviderId,
		model: run.state.model,
		systemPrompt: specialistSystemPrompt(specialist.families),
		prompt: specialistPrompt(report, documents, specialist.families),
		toolName: 'submit_style_families',
		toolDescription: 'Submit all grounded style propositions for the assigned feature families.',
		inputSchema: draftJsonSchema(),
		onEvent: (event) => forwardSpecialistEvent(run, specialist.id, event),
		parse: (value) => {
			const parsed = SpecialistSubmissionSchema.parse(value);
			const corpus = corpusText(documents);
			for (const draft of parsed.propositions) {
				if (!specialist.families.includes(draft.family)) throw new Error(`Family ${draft.family} is outside this specialist assignment`);
				validateDraftGrounding(draft, corpus);
			}
			return parsed;
		},
		abortSignal: run.abortController.signal
	});
	try {
		let result: SpecialistSubmission;
		try {
			result = await execute();
		} catch {
			result = await execute();
		}
		updateSpecialist(run, specialist.id, { status: 'completed', completedAt: now() });
		return result.propositions;
	} catch (error) {
		updateSpecialist(run, specialist.id, {
			status: run.abortController.signal.aborted ? 'cancelled' : 'error',
			completedAt: now(),
			error: error instanceof Error ? error.message : String(error)
		});
		return [];
	}
}

async function runSynthesis(
	run: ManagedRun,
	corpus: string,
	drafts: PropositionDraft[]
): Promise<PropositionDraft[]> {
	updateSpecialist(run, 'synthesis', { status: 'running', startedAt: now(), error: undefined });
	try {
		const result = await runStructuredStyleAgent<SynthesisSubmission>({
			providerId: run.state.provider as ProviderId,
			model: run.state.model,
			systemPrompt: synthesisSystemPrompt(),
			prompt: `Synthesize these specialist propositions.\n\n${JSON.stringify({ propositions: drafts })}`,
			toolName: 'submit_style_profile',
			toolDescription: 'Submit the complete merged and grounded author style profile.',
			inputSchema: draftJsonSchema(),
			parse: (value) => {
				const parsed = SynthesisSubmissionSchema.parse(value);
				for (const draft of parsed.propositions) validateDraftGrounding(draft, corpus);
				return parsed;
			},
			abortSignal: run.abortController.signal
		});
		updateSpecialist(run, 'synthesis', { status: 'completed', completedAt: now() });
		return result.propositions;
	} catch (error) {
		updateSpecialist(run, 'synthesis', {
			status: run.abortController.signal.aborted ? 'cancelled' : 'error',
			completedAt: now(),
			error: error instanceof Error ? error.message : String(error)
		});
		return drafts;
	}
}

/** A proposition the writer confirmed survives a re-run, unless this run found
 *  its own take on the same instruction. */
function carryConfirmed(previous: StyleProfile | null, next: StyleProposition[]): StyleProposition[] {
	if (!previous) return next;
	const carried = previous.propositions.filter((proposition) => proposition.status === 'confirmed'
		&& !next.some((candidate) => candidate.family === proposition.family
			&& candidate.instruction.trim().toLowerCase() === proposition.instruction.trim().toLowerCase()));
	return [...next, ...carried.map((proposition) => ({ ...proposition, updatedAt: now() }))];
}

async function executeRun(run: ManagedRun, force: boolean) {
	const previous = run.priorProfile;
	const started = now();
	try {
		run.state.status = 'running';
		run.state.phase = 'materializing';
		run.state.progress = 5;
		emit(run, 'progress', 'Reading reference sources');
		const materialized = await materializeAllReferences(force);
		if (run.abortController.signal.aborted) throw new Error('Style analysis was cancelled');

		run.state.phase = 'measuring';
		run.state.progress = 20;
		emit(run, 'progress', 'Computing deterministic style measurements');
		const documents = materialized.map(normalizedDocumentFromMaterialized);
		const report = writeStyleReport(analyzeDocuments(documents) as StyleAnalysisReport);
		run.profile = createStyleProfile(report.sourceSnapshotHash);
		run.profile.lastRun = publicRun(run);
		writeStyleProfile(run.profile);

		run.state.phase = 'reflecting';
		run.state.progress = 35;
		emit(run, 'progress', 'Running three style specialists');
		const specialistResults = await Promise.all(
			SPECIALISTS.map((specialist) => runSpecialist(run, report, documents, specialist))
		);
		if (run.abortController.signal.aborted) throw new Error('Style analysis was cancelled');
		const drafts = specialistResults.flat();

		run.state.phase = 'synthesizing';
		run.state.progress = 75;
		emit(run, 'progress', 'Merging grounded propositions');
		const synthesized = drafts.length ? await runSynthesis(run, corpusText(documents), drafts) : [];
		const corpus = corpusText(documents);
		const grounded: StyleProposition[] = [];
		synthesized.forEach((draft, index) => {
			// A proposition whose examples are not in the sources is dropped, not
			// surfaced — the writer should never be shown invented evidence.
			try {
				grounded.push(propositionFromDraft(draft, corpus, index));
			} catch {
				// Skip it.
			}
		});
		const propositions = carryConfirmed(previous, grounded);
		const pending = propositions.filter((proposition) => proposition.status === 'pending');
		const active = propositions.filter((proposition) => ['active', 'confirmed'].includes(proposition.status));
		run.profile.propositions = propositions;
		run.profile.calibrations = pending.map((proposition) => ({
			id: `cal_${proposition.id}`,
			propositionId: proposition.id,
			status: 'pending'
		}));
		run.profile.status = pending.length ? 'needs-calibration' : active.length ? 'active' : 'error';

		run.state.phase = 'compiling';
		run.state.progress = 90;
		emit(run, 'progress', 'Compiling the author skill');
		if (active.length) {
			const skill = compileAuthorStyleSkill(run.profile, report);
			run.profile.skillId = skill.skillId;
			run.profile.skillPath = skill.skillPath;
		}

		run.state.status = 'completed';
		run.state.phase = 'completed';
		run.state.progress = 100;
		run.state.completedAt = now();
		run.profile.lastRun = publicRun(run);
		run.profile = writeStyleProfile(run.profile);
		appendStyleStudyEvent('analysis_completed', {
			durationMs: now() - started,
			provider: run.state.provider,
			model: run.state.model,
			activeCount: active.length,
			pendingCount: pending.length,
			referenceCount: report.documents.length,
			authoredReferenceCount: report.documents.filter((document) => document.role === 'authored').length,
			inspirationReferenceCount: report.documents.filter((document) => document.role === 'inspiration').length,
			confidenceBins: {
				low: propositions.filter((item) => item.confidence < 0.5).length,
				medium: propositions.filter((item) => item.confidence >= 0.5 && item.confidence < 0.75).length,
				high: propositions.filter((item) => item.confidence >= 0.75).length
			},
			failedSpecialists: run.state.specialists.filter((item) => item.status === 'error').map((item) => item.id)
		});
		emit(run, 'completed', 'Author style analysis is complete');
	} catch (error) {
		const cancelled = run.abortController.signal.aborted;
		run.state.status = cancelled ? 'cancelled' : 'error';
		run.state.phase = cancelled ? 'cancelled' : 'error';
		run.state.error = error instanceof Error ? error.message : String(error);
		run.state.completedAt = now();
		if (run.priorProfile) {
			run.profile = {
				...run.priorProfile,
				status: cancelled ? run.priorProfile.status : 'error',
				lastRun: publicRun(run)
			};
		} else if (run.profile) {
			run.profile.status = cancelled ? 'ready-to-analyze' : 'error';
		}
		emit(run, cancelled ? 'cancelled' : 'error', run.state.error);
	} finally {
		if (activeRunId === run.state.id) activeRunId = null;
		for (const key of specialistForwarders.keys()) {
			if (key.startsWith(`${run.state.id}:`)) specialistForwarders.delete(key);
		}
	}
}

export function startStyleAnalysisRun(input: { provider: ProviderId; model?: string; force?: boolean }): StyleAnalysisRun {
	if (listStyleReferences().length === 0) throw new Error('Add at least one writing reference before analysis');
	if (activeRunId) {
		const active = jobs.get(activeRunId);
		if (active && ['queued', 'running'].includes(active.state.status)) throw new Error('A style analysis is already running');
	}
	const runId = `style_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
	const state: StyleAnalysisRun = {
		id: runId,
		status: 'queued',
		provider: input.provider,
		model: input.model,
		phase: 'queued',
		progress: 0,
		startedAt: now(),
		updatedAt: now(),
		specialists: [
			...SPECIALISTS.map((specialist) => ({ id: specialist.id, status: 'pending' as const, families: specialist.families })),
			{ id: 'synthesis', status: 'pending', families: [] }
		]
	};
	const priorProfile = readStyleProfile();
	const provisionalProfile = priorProfile
		? { ...priorProfile, status: 'analyzing' as const, lastRun: state }
		: { ...createStyleProfile('pending'), lastRun: state };
	const run: ManagedRun = {
		state,
		abortController: new AbortController(),
		emitter: new EventEmitter(),
		profile: writeStyleProfile(provisionalProfile),
		priorProfile
	};
	jobs.set(runId, run);
	activeRunId = runId;
	void executeRun(run, input.force === true);
	return publicRun(run);
}

export function getStyleAnalysisRun(id: string): StyleAnalysisRun | null {
	const run = jobs.get(id);
	return run ? publicRun(run) : null;
}

export function subscribeToStyleAnalysisRun(id: string, listener: (event: StyleRunEvent) => void): (() => void) | null {
	const run = jobs.get(id);
	if (!run) return null;
	run.emitter.on('event', listener);
	queueMicrotask(() => listener({ type: 'snapshot', run: publicRun(run) }));
	return () => run.emitter.off('event', listener);
}

export function cancelStyleAnalysisRun(id: string): StyleAnalysisRun | null {
	const run = jobs.get(id);
	if (!run) return null;
	run.abortController.abort();
	return publicRun(run);
}
