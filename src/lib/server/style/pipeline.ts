/**
 * End-to-end style analysis run orchestration.
 */
import type { ProviderId } from '../providers/types';
import { listStyleReferences, type StyleReference } from '../references';
import { materializeReference, type MaterializedSource } from './materialize';
import { normalizeText } from './normalize';
import { measureDocuments, type FeatureMeasurement } from './measure';
import { runSpecialists, synthesizePropositions } from './specialists';
import {
	generateCloseCall,
	selectCalibrationCandidates,
	applyCalibrationResponse,
	type CalibrationResponse
} from './calibrate';
import { compileAuthorStyleSkill } from './compile-skill';
import {
	AUTHOR_STYLE_SKILL_ID,
	type CalibrationTrial,
	type NormalizedDocument,
	type StyleProposition,
	type StyleSkillState
} from './schemas';
import {
	authorStyleSkillDir,
	clearStyleRun,
	countUnresolvedCalibration,
	ensureStyleRunDir,
	isSkillStale,
	readStyleSkillState,
	writeRunArtifact,
	writeStyleSkillState
} from './skill-store';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type StyleRunEvent =
	| { type: 'status'; phase: string; message: string }
	| { type: 'progress'; phase: string; current: number; total: number }
	| { type: 'error'; message: string }
	| { type: 'done'; skillId: string; activeCount: number; unresolved: number };

type RunRecord = {
	id: string;
	status: 'running' | 'done' | 'failed' | 'cancelled';
	startedAt: number;
	events: StyleRunEvent[];
	abort: AbortController;
	listeners: Set<(e: StyleRunEvent) => void>;
	measurements?: FeatureMeasurement[];
	docs?: NormalizedDocument[];
};

const runs = new Map<string, RunRecord>();

function emit(run: RunRecord, event: StyleRunEvent) {
	run.events.push(event);
	for (const l of run.listeners) l(event);
}

export function getStyleRun(runId: string): RunRecord | undefined {
	return runs.get(runId);
}

export function subscribeStyleRun(runId: string, fn: (e: StyleRunEvent) => void): () => void {
	const run = runs.get(runId);
	if (!run) return () => {};
	run.listeners.add(fn);
	for (const e of run.events) fn(e);
	return () => run.listeners.delete(fn);
}

export function cancelStyleRun(runId: string): boolean {
	const run = runs.get(runId);
	if (!run || run.status !== 'running') return false;
	run.abort.abort();
	run.status = 'cancelled';
	emit(run, { type: 'status', phase: 'cancelled', message: 'Run cancelled' });
	return true;
}

export async function startStyleAnalysisRun(opts: {
	provider?: ProviderId;
	model?: string;
	useHeuristicsOnly?: boolean;
	referenceIds?: string[];
}): Promise<{ runId: string }> {
	const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const abort = new AbortController();
	const run: RunRecord = {
		id: runId,
		status: 'running',
		startedAt: Date.now(),
		events: [],
		abort,
		listeners: new Set()
	};
	runs.set(runId, run);
	ensureStyleRunDir(runId);

	void (async () => {
		try {
			emit(run, { type: 'status', phase: 'materialize', message: 'Materializing references' });
			const refs = listStyleReferences().filter((r) =>
				opts.referenceIds ? opts.referenceIds.includes(r.id) : true
			);
			if (!refs.length) throw new Error('No style references to analyze');

			const materialized: MaterializedSource[] = [];
			for (let i = 0; i < refs.length; i++) {
				if (abort.signal.aborted) throw new Error('cancelled');
				const m = await materializeReference(refs[i], (refs[i].role as any) || 'authored');
				materialized.push(m);
				emit(run, {
					type: 'progress',
					phase: 'materialize',
					current: i + 1,
					total: refs.length
				});
				if (m.error) {
					emit(run, {
						type: 'status',
						phase: 'materialize',
						message: `Warning: ${m.label}: ${m.error}`
					});
				}
			}

			const okSources = materialized.filter((m) => m.text.trim() && !m.error);
			if (!okSources.length) throw new Error('No extractable reference text');

			emit(run, { type: 'status', phase: 'normalize', message: 'Normalizing documents' });
			const docs = okSources.map((m) =>
				normalizeText(m.text, { sourceId: m.sourceId, role: m.role, label: m.label })
			);
			run.docs = docs;
			writeRunArtifact(runId, 'normalized.json', docs.map((d) => ({
				sourceId: d.sourceId,
				role: d.role,
				label: d.label,
				textLength: d.text.length,
				sentenceCount: d.sentences.length
			})));

			emit(run, { type: 'status', phase: 'measure', message: 'Computing deterministic metrics' });
			const measurements = measureDocuments(docs);
			run.measurements = measurements.metrics;
			writeRunArtifact(runId, 'metrics.json', measurements.metrics);

			if (!opts.useHeuristicsOnly && !opts.provider) {
				throw new Error('Provider required for specialist agent passes');
			}

			emit(run, {
				type: 'status',
				phase: 'specialists',
				message: opts.useHeuristicsOnly
					? 'Building propositions from measurements (dev heuristics only)'
					: 'Running organization, language, and discourse specialist agents'
			});

			const { results, propositions } = await runSpecialists({
				docs,
				measurements,
				provider: opts.provider,
				model: opts.model,
				runId,
				useHeuristicsOnly: opts.useHeuristicsOnly === true
			});
			writeRunArtifact(runId, 'specialists.json', results.map((r) => ({
				name: r.name,
				ok: r.ok,
				error: r.error,
				count: r.rawPropositions.length
			})));

			emit(run, { type: 'status', phase: 'synthesis', message: 'Synthesizing profile' });
			const synthesized = synthesizePropositions(propositions);

			const sourceManifest = okSources.map((m) => ({
				sourceId: m.sourceId,
				role: m.role,
				label: m.label,
				type: String(m.type),
				target: m.target,
				contentHash: m.contentHash,
				format: m.format
			}));

			let trials: CalibrationTrial[] = [];
			const calibProps = selectCalibrationCandidates(synthesized, 8);
			for (const prop of calibProps) {
				const trial = generateCloseCall({ proposition: prop, measurements });
				if ('error' in trial) continue;
				trials.push(trial);
			}

			const state: StyleSkillState = {
				schemaVersion: 1,
				skillId: AUTHOR_STYLE_SKILL_ID,
				updatedAt: Date.now(),
				lastRunId: runId,
				propositions: synthesized,
				calibrationTrials: trials,
				sourceManifest
			};
			writeStyleSkillState(state);
			writeRunArtifact(runId, 'propositions.json', synthesized);

			emit(run, { type: 'status', phase: 'compile', message: 'Compiling author-style skill' });
			const compiled = compileAuthorStyleSkill({
				state,
				metrics: measurements.metrics
			});

			run.status = 'done';
			emit(run, {
				type: 'done',
				skillId: compiled.skillId,
				activeCount: compiled.activeCount,
				unresolved: countUnresolvedCalibration(state)
			});
			// Keep checkpoints briefly; clear ephemeral dir later
			setTimeout(() => clearStyleRun(runId), 60 * 60 * 1000);
		} catch (err) {
			if (run.status === 'cancelled') return;
			run.status = 'failed';
			emit(run, { type: 'error', message: (err as Error).message });
		}
	})();

	return { runId };
}

export function getStyleProfileSummary() {
	const state = readStyleSkillState();
	const refs = listStyleReferences();
	// Staleness needs content hashes — use stored hashes vs presence of refs by id
	const currentHashes = (state?.sourceManifest ?? []).map((s) => ({
		sourceId: s.sourceId,
		contentHash: s.contentHash
	}));
	// If reference ids changed, mark stale
	const refIds = new Set(refs.map((r) => r.id));
	const manifestIds = new Set((state?.sourceManifest ?? []).map((s) => s.sourceId));
	const idDrift =
		[...refIds].some((id) => !manifestIds.has(id)) ||
		[...manifestIds].some((id) => !refIds.has(id));

	return {
		hasReferences: refs.length > 0,
		referenceCount: refs.length,
		skillId: state?.skillId ?? null,
		hasSkill: !!state && state.propositions.some((p) => p.status === 'active' && p.enabled),
		activeCount: state?.propositions.filter((p) => p.status === 'active' && p.enabled).length ?? 0,
		unresolvedCalibration: countUnresolvedCalibration(state),
		stale: idDrift || isSkillStale(state, currentHashes),
		lastRunId: state?.lastRunId ?? null,
		updatedAt: state?.updatedAt ?? null,
		propositions: state?.propositions ?? [],
		calibrationTrials: (state?.calibrationTrials ?? []).filter((t) => t.status === 'pending'),
		sourceManifest: state?.sourceManifest ?? []
	};
}

export function resolveCalibration(opts: {
	trialId: string;
	response: CalibrationResponse;
	editedText?: string;
}): StyleSkillState {
	const state = readStyleSkillState();
	if (!state) throw new Error('No style skill state');
	const trial = state.calibrationTrials.find((t) => t.id === opts.trialId);
	if (!trial) throw new Error('Unknown calibration trial');
	const prop = state.propositions.find((p) => p.id === trial.propositionId);
	if (!prop) throw new Error('Unknown proposition');

	const updated = applyCalibrationResponse({
		proposition: prop,
		trial,
		response: opts.response,
		editedText: opts.editedText
	});

	const propositions = state.propositions.map((p) =>
		p.id === updated.id ? updated : p
	) as StyleProposition[];
	const calibrationTrials = state.calibrationTrials.map((t) =>
		t.id === trial.id ? { ...t, status: 'resolved' as const, updatedAt: Date.now() } : t
	);

	const next: StyleSkillState = {
		...state,
		propositions,
		calibrationTrials,
		updatedAt: Date.now()
	};
	writeStyleSkillState(next);
	compileAuthorStyleSkill({ state: next, metrics: loadSkillMetrics(next.skillId) });
	return next;
}

function loadSkillMetrics(skillId: string): FeatureMeasurement[] {
	try {
		const path = join(authorStyleSkillDir(skillId), 'references', 'metrics.json');
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, 'utf-8'));
			if (Array.isArray(parsed.metrics)) return parsed.metrics;
		}
	} catch {
		/* ignore */
	}
	return [];
}

export async function ensureCalibrationTrial(propositionId: string): Promise<CalibrationTrial> {
	const state = readStyleSkillState();
	if (!state) throw new Error('No style skill state');
	const existing = state.calibrationTrials.find(
		(t) => t.propositionId === propositionId && t.status === 'pending'
	);
	if (existing) return existing;
	const prop = state.propositions.find((p) => p.id === propositionId);
	if (!prop) throw new Error('Unknown proposition');

	// Rebuild minimal measurements from skill metrics file
	const { readFileSync, existsSync } = await import('fs');
	const { join } = await import('path');
	const { authorStyleSkillDir } = await import('./skill-store');
	let metrics: FeatureMeasurement[] = [];
	const path = join(authorStyleSkillDir(state.skillId), 'references', 'metrics.json');
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		metrics = parsed.metrics ?? [];
	}
	const metricIndex = new Map(metrics.map((m) => [m.metricId, m]));
	const measurements = {
		metrics,
		lexicon: {
			signatureWords: [],
			signaturePhrases: [],
			aiIsmsAbsent: [],
			aiIsmsPresent: [],
			lexicalDiversity: 0,
			avgWordLength: 0,
			contractionRatePerThousand: 0
		},
		punctuationBySource: {},
		metricIndex
	};
	const trial = generateCloseCall({ proposition: prop, measurements });
	if ('error' in trial) throw new Error(trial.error);
	state.calibrationTrials = [...state.calibrationTrials, trial];
	writeStyleSkillState(state);
	return trial;
}

/** Expose refs for typing without circular imports in UI layer. */
export type { StyleReference };
