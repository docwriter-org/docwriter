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
import { deriveStyleProfileStatus, isActiveProposition } from '$lib/style-profile';
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
import { appendRunLog } from './run-log-store';
import { STYLE_FEATURE_REGISTRY } from './feature-registry';
import { isSelected, listStyleReferences } from '$lib/server/references';

/** One line of a specialist's working trace, streamed as it happens. */
export interface SpecialistLogEntry {
	specialistId: SpecialistRunState['id'];
	kind: 'text' | 'thinking' | 'tool';
	text?: string;
	toolName?: string;
}

export interface StyleRunEvent {
	type: 'snapshot' | 'progress' | 'specialist' | 'specialist_log' | 'completed' | 'error' | 'cancelled';
	/** Omitted on high-volume `specialist_log` lines — clients keep their last run snapshot. */
	run?: StyleAnalysisRun;
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

/** Serialize profile writes — specialists finish in parallel and would otherwise
 *  race the same style-profile.json. */
const profileWriteQueues = new Map<string, Promise<void>>();

function scheduleProfileWrite(run: ManagedRun) {
	if (!run.profile) return;
	run.profile.lastRun = publicRun(run);
	const previous = profileWriteQueues.get(run.state.id) ?? Promise.resolve();
	const next = previous
		.catch(() => {
			/* prior write failure must not block the next snapshot */
		})
		.then(() => {
			if (!run.profile) return;
			run.profile.lastRun = publicRun(run);
			run.profile = writeStyleProfile(run.profile);
		});
	profileWriteQueues.set(run.state.id, next);
}

function emit(run: ManagedRun, type: StyleRunEvent['type'], message?: string) {
	run.state.updatedAt = now();
	const snapshot = publicRun(run);
	if (run.profile) {
		run.profile.lastRun = snapshot;
		// Persist on specialist transitions + terminal events so the status pill
		// (which polls the on-disk profile) moves in real time. Progress ticks
		// stay memory-only — they fire often and don't need a disk round-trip.
		if (type === 'specialist' || type === 'completed' || type === 'error' || type === 'cancelled') {
			scheduleProfileWrite(run);
		}
	}
	run.emitter.emit('event', { type, run: snapshot, message } satisfies StyleRunEvent);
}

/** Trace lines are high-volume: no profile write, no run clone/payload. */
function emitLog(run: ManagedRun, log: SpecialistLogEntry) {
	run.emitter.emit('event', {
		type: 'specialist_log',
		log
	} satisfies StyleRunEvent);
}

/** Map finished specialists onto the 35→75 reflecting window so the bar moves
 *  while the three parallel agents are still in flight. */
function refreshReflectingProgress(run: ManagedRun) {
	if (run.state.phase !== 'reflecting') return;
	const specialists = run.state.specialists.filter((specialist) => specialist.id !== 'synthesis');
	if (!specialists.length) return;
	const finished = specialists.filter((specialist) =>
		specialist.status === 'completed' || specialist.status === 'error' || specialist.status === 'cancelled'
	).length;
	run.state.progress = 35 + Math.round((finished / specialists.length) * 40);
}

function updateSpecialist(
	run: ManagedRun,
	id: SpecialistRunState['id'],
	patch: Partial<SpecialistRunState>
) {
	run.state.specialists = run.state.specialists.map((specialist) => specialist.id === id ? { ...specialist, ...patch } : specialist);
	refreshReflectingProgress(run);
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
					required: ['family', 'statement', 'instruction', 'examples', 'contrast', 'confidence'],
					properties: {
						family: { type: 'string' },
						statement: {
							type: 'string',
							description: 'The habit in plain language, as you would tell a ghostwriter out loud. No writing-theory jargon.'
						},
						instruction: {
							type: 'string',
							description: 'What to do when writing, in plain imperative language.'
						},
						examples: {
							type: 'array',
							description:
								'Three or more passages quoted verbatim from the sources that show this proposition in action. Each is three to four consecutive sentences, not a lone sentence.',
							items: { type: 'string' }
						},
						focus: {
							type: 'array',
							description:
								'For each example, in the same order, the one sentence inside it that shows the habit, copied exactly as it appears in that example.',
							items: { type: 'string' }
						},
						contrast: {
							type: 'object',
							description:
								'The comparison the author will be asked to judge, side by side and at a glance. Much shorter than an example.',
							additionalProperties: false,
							required: ['passage', 'rewritten'],
							properties: {
								passage: {
									type: 'string',
									description:
										'One or two sentences quoted verbatim from the sources, 20 to 60 words, that plainly follow this proposition. Pick the shortest passage that still shows the habit.'
								},
								rewritten: {
									type: 'string',
									description:
										'That same passage rewritten so it no longer follows the proposition, changing nothing else. Same meaning, facts, names, numbers and length. It must still be good prose: an alternative, not a worse version.'
								}
							}
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
 * A metric that never fired says nothing about how someone writes: a personal
 * page with no tables should not produce a proposition about tables. Zero
 * measurements are dropped before a specialist ever sees them.
 *
 * The test is `sourceCount`, how many sources the metric was non-zero in. It
 * used to be `occurrenceCount`, which only punctuation ever populates, so all
 * 80-odd other metrics read as never-fired and the specialists were briefed on
 * punctuation alone. Do not reintroduce a per-family branch here: the analyzer
 * derives punctuation's value from its occurrences, so the two agree for that
 * family and `sourceCount` is right for every family.
 */
export function isMeasured(measurement: FeatureMeasurement): boolean {
	return measurement.sourceCount > 0 && measurement.value !== 0;
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
	return `You are briefing a ghostwriter who will imitate this author's prose. Work only on these families: ${families.join(', ')}.

You get measurements that fired, the author's common words, and the source texts. The measurements are a hint for where to look — read the writing itself before you decide anything.

The sources were pasted from web pages and documents, so some of what you see is not the author's writing at all. Navigation links, site menus, bylines, dates, "12 min read" labels, share buttons, cookie notices, footers, raw URLs, HTML tags and reference lists all come along with a copy and paste. Skip that text. Do not describe it, do not measure it, and never quote it as an example of how the author writes. Judge style only from the running prose.

Write style propositions the ghostwriter can follow while drafting. Each one needs at least three examples, copied word for word from the sources. Invented quotes are discarded with the proposition.

An example is a passage, not a sentence. Quote three or four consecutive sentences: the one that shows the habit, plus enough either side that the ghostwriter can see what it is doing in a paragraph. An opener means nothing without what it opens; a short closing line means nothing without the long sentence before it. Then set the matching focus entry to the one sentence inside that passage the proposition is actually about, copied exactly as it appears there.

Each proposition also needs a contrast, because the author will be shown it and asked which they would rather have written. Take the one passage of theirs that follows the habit most plainly and rewrite it so it no longer follows the habit.

Keep the contrast short: one or two sentences, 20 to 60 words. This is not the example. The examples are long because the ghostwriter studies them; the contrast is a snap judgement the author makes side by side with the other version, and a long one is too much to hold in the eye at once. Pick the shortest passage that still shows the habit. Change only what the proposition governs: same meaning, facts, names, numbers and roughly the same length. The rewrite has to be prose a competent writer would be happy with, because the question is which the author prefers, not which is better written. If you cannot write a contrast for a proposition, the proposition is too vague to be worth keeping — drop it.

A good proposition:
- Sounds like advice you'd say out loud: "Open with the hard problem, then name your system." Not like a paper about writing.
- Names a real choice (someone could write the opposite and still be competent).
- Changes how the next draft would read if followed.
- Uses plain words. Avoid jargon about writing itself — no "register," "rhetorical move," "discourse," "cadence," "funnel," "landing," "hedging," "modality," or similar. Say what to do in the sentence.

Leave out:
- Things the author never does (only non-zero measurements are shown; don't invent absences).
- Stats and ranges from the measurements. Never put a report number into a statement.
- Restatements of a metric ("heading density is low").
- Facts about the topic or the author's biography.
- Advice so vague that every decent writer already does it.

statement = the habit in one plain sentence. instruction = what to do when writing. Prefer fewer sharp ones.

Think out loud before you submit. Write what you notice as you read: the patterns you are chasing, the ones you tried and threw out because the evidence was thin, the passages that changed your mind. The writer can watch this while you work, and a silent run of several minutes looks broken. Keep it to short paragraphs as you go, not one essay at the end.

Then call submit_style_families once with everything.`;
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

/** Enough of each source to judge how it is written, without flooding context.
 *  Each is headed by the writer's own description of what it is. */
function sourceExcerpts(
	documents: NormalizedDocument[],
	descriptions: Record<string, string>,
	perDocument = 6000
): string {
	return documents
		.map((document, index) => {
			const text = document.text.trim();
			const excerpt = text.length > perDocument ? `${text.slice(0, perDocument)}\n[…]` : text;
			const what = descriptions[document.sourceId];
			return `--- SOURCE ${index + 1}${what ? `: ${what}` : ''} ---\n${excerpt}`;
		})
		.join('\n\n');
}

function specialistPrompt(
	report: StyleAnalysisReport,
	families: StyleFamily[],
	vocabulary: string[],
	excerpts: string
): string {
	return [
		'Measurements that fired for your families (zeros already removed — treat these as hints, not the answer):',
		JSON.stringify(reportSlice(report, families)),
		'',
		`Words this author reuses: ${vocabulary.join(', ')}`,
		'',
		'The writing. Each source is labeled with what the author says it is.',
		'Read it, then write ghostwriter instructions in plain language:',
		'',
		excerpts
	].join('\n');
}

function synthesisSystemPrompt(): string {
	return `Merge style propositions into the brief a ghostwriter will read.

Merge hard. If two propositions would make the ghostwriter change a sentence the same way, keep one — the plainer wording. Split them only when following each would produce a visibly different sentence.

Carry each kept proposition's examples and its contrast through unchanged. The contrast passage is quoted from the author's own writing and the rewrite was made against it, so editing either breaks the pair. When you merge two propositions, keep the contrast belonging to the one whose wording you kept.

Rewrite anything that sounds like writing theory into plain advice. Prefer "Put the claim first, then the example" over "Use a claim-warrant paragraph structure." Strip jargon about writing.

Drop propositions that:
- rest on text that is not the author's writing (navigation links, bylines, dates, "12 min read" labels, footers, raw URLs or HTML that came along with a copy and paste),
- restate a measurement,
- describe something the author does not do,
- are so general every competent writer already does them,
- lean on literary or linguistics jargon the ghostwriter does not need.

Keep authored habits as "this is how they write" and inspiration preferences as "aim for this" when those differ. Smallest useful set wins. Call submit_style_profile exactly once.`;
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
	/** Optional — calibration calls are uncancellable today. */
	abortSignal?: AbortSignal;
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
	if (input.abortSignal?.aborted) throw new Error('Style analysis was cancelled');
	if (!submission) throw new Error(providerError || `Agent did not call ${input.toolName}`);
	return submission;
}

/**
 * Turn a specialist's provider events into trace lines. Text and thinking arrive
 * as deltas, so they are accumulated per message and re-emitted whole — the
 * client replaces the open line rather than collecting half-words.
 *
 * The stream is live; the database copy is the record. Only whole lines are
 * written, when a tool call or the end of the specialist closes them, so a run
 * stores the paragraphs it produced rather than every prefix of them.
 */
function makeSpecialistForwarder(run: ManagedRun, specialistId: SpecialistRunState['id']) {
	let text = '';
	let thinking = '';
	const store = (kind: 'text' | 'thinking', value: string) => {
		if (value.trim()) appendRunLog(run.state.id, { specialistId, kind, text: value.trim() });
	};
	const closeOpenLines = () => {
		store('thinking', thinking);
		store('text', text);
		text = '';
		thinking = '';
	};
	return {
		handle(event: ProviderEvent) {
			if (event.type === 'assistant_text') {
				text += event.text;
				if (text.trim()) emitLog(run, { specialistId, kind: 'text', text: text.trim() });
			} else if (event.type === 'assistant_thinking') {
				thinking += event.text;
				if (thinking.trim()) emitLog(run, { specialistId, kind: 'thinking', text: thinking.trim() });
			} else if (event.type === 'tool_call') {
				closeOpenLines();
				const toolName = event.tool_name.split('__').pop() ?? event.tool_name;
				// ToolSearch is the harness finding the tool we already handed it,
				// not the specialist doing anything. Showing it as the only line in
				// an otherwise empty panel reads as a stuck run.
				if (toolName === 'ToolSearch') return;
				emitLog(run, { specialistId, kind: 'tool', toolName });
				appendRunLog(run.state.id, { specialistId, kind: 'tool', toolName });
			}
		},
		flush: closeOpenLines
	};
}

type SpecialistForwarder = ReturnType<typeof makeSpecialistForwarder>;

const specialistForwarders = new Map<string, SpecialistForwarder>();

function forwarderFor(run: ManagedRun, specialistId: SpecialistRunState['id']): SpecialistForwarder {
	const key = `${run.state.id}:${specialistId}`;
	let forwarder = specialistForwarders.get(key);
	if (!forwarder) {
		forwarder = makeSpecialistForwarder(run, specialistId);
		specialistForwarders.set(key, forwarder);
	}
	return forwarder;
}

function forwardSpecialistEvent(
	run: ManagedRun,
	specialistId: SpecialistRunState['id'],
	event: ProviderEvent
) {
	forwarderFor(run, specialistId).handle(event);
}

/** Write whatever the specialist was mid-sentence on when it stopped. */
function flushSpecialistTrace(run: ManagedRun, specialistId: SpecialistRunState['id']) {
	specialistForwarders.get(`${run.state.id}:${specialistId}`)?.flush();
}

async function runSpecialist(
	run: ManagedRun,
	report: StyleAnalysisReport,
	documents: NormalizedDocument[],
	corpus: string,
	vocabulary: string[],
	excerpts: string,
	specialist: (typeof SPECIALISTS)[number]
): Promise<PropositionDraft[]> {
	updateSpecialist(run, specialist.id, { status: 'running', startedAt: now(), error: undefined });
	const execute = async () => runStructuredStyleAgent<SpecialistSubmission>({
		providerId: run.state.provider as ProviderId,
		model: run.state.model,
		systemPrompt: specialistSystemPrompt(specialist.families),
		prompt: specialistPrompt(report, specialist.families, vocabulary, excerpts),
		toolName: 'submit_style_families',
		toolDescription: 'Submit all grounded style propositions for the assigned feature families.',
		inputSchema: draftJsonSchema(),
		onEvent: (event) => forwardSpecialistEvent(run, specialist.id, event),
		parse: (value) => {
			const parsed = SpecialistSubmissionSchema.parse(value);
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
		} catch (error) {
			// One retry for transient provider failures — never after cancel.
			if (run.abortController.signal.aborted) throw error;
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
	} finally {
		flushSpecialistTrace(run, specialist.id);
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
			// Synthesis is a specialist like the others; without this its trace
			// panel stayed empty even while it was working.
			onEvent: (event) => forwardSpecialistEvent(run, 'synthesis', event),
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
	} finally {
		flushSpecialistTrace(run, 'synthesis');
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
		if (!materialized.length) throw new Error('Add at least one writing reference before analysis');
		if (run.abortController.signal.aborted) throw new Error('Style analysis was cancelled');

		run.state.phase = 'measuring';
		run.state.progress = 20;
		emit(run, 'progress', 'Computing deterministic style measurements');
		const documents = materialized.map(normalizedDocumentFromMaterialized);
		// What the writer said each passage is, keyed by source.
		const descriptions = Object.fromEntries(
			materialized.map((item) => [item.reference.id, item.reference.description ?? item.reference.label])
		);
		const report = writeStyleReport(analyzeDocuments(documents) as StyleAnalysisReport);
		// Keep prior propositions on disk until synthesis finishes so a crash
		// mid-run does not wipe confirmed guidance.
		const base = run.profile ?? createStyleProfile(report.sourceSnapshotHash);
		run.profile = {
			...base,
			status: 'analyzing',
			sourceSnapshotHash: report.sourceSnapshotHash,
			lastRun: publicRun(run)
		};
		writeStyleProfile(run.profile);

		run.state.phase = 'reflecting';
		run.state.progress = 35;
		emit(run, 'progress', 'Running three style specialists');
		const corpus = corpusText(documents);
		const vocabulary = characteristicVocabulary(documents);
		const excerpts = sourceExcerpts(documents, descriptions);
		const specialistResults = await Promise.all(
			SPECIALISTS.map((specialist) =>
				runSpecialist(run, report, documents, corpus, vocabulary, excerpts, specialist)
			)
		);
		if (run.abortController.signal.aborted) throw new Error('Style analysis was cancelled');
		const drafts = specialistResults.flat();

		run.state.phase = 'synthesizing';
		run.state.progress = 75;
		emit(run, 'progress', 'Merging grounded propositions');
		const synthesized = drafts.length ? await runSynthesis(run, corpus, drafts) : [];
		const grounded: StyleProposition[] = [];
		let droppedUngrounded = 0;
		synthesized.forEach((draft, index) => {
			// A proposition whose examples are not in the sources is dropped, not
			// surfaced — the writer should never be shown invented evidence.
			try {
				grounded.push(propositionFromDraft(draft, corpus, index));
			} catch {
				droppedUngrounded += 1;
			}
		});
		const propositions = carryConfirmed(previous, grounded);
		if (!propositions.length) {
			throw new Error(
				droppedUngrounded
					? `Style analysis produced no grounded propositions (${droppedUngrounded} dropped: examples not in sources)`
					: 'Style analysis produced no grounded propositions'
			);
		}
		const pending = propositions.filter((proposition) => proposition.status === 'pending');
		const active = propositions.filter(isActiveProposition);
		run.profile.propositions = propositions;
		run.profile.calibrations = pending.map((proposition) => ({
			id: `cal_${proposition.id}`,
			propositionId: proposition.id,
			status: 'pending'
		}));
		run.profile.status = deriveStyleProfileStatus(propositions);

		run.state.phase = 'compiling';
		run.state.progress = 90;
		emit(run, 'progress', 'Compiling the author skill');
		if (active.length) {
			const skill = compileAuthorStyleSkill(run.profile, report, { startsNewVersion: true });
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
			droppedUngrounded,
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
		profileWriteQueues.delete(run.state.id);
	}
}

export function startStyleAnalysisRun(input: { provider: ProviderId; model?: string; force?: boolean }): StyleAnalysisRun {
	if (!listStyleReferences().some(isSelected)) {
		throw new Error('Add at least one writing reference before analysis');
	}
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
