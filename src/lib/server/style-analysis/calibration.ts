import type { CalibrationChoice, CalibrationTrial, StyleAnalysisReport, StyleProfile, StyleProposition } from '$lib/style-profile';
import type { ProviderId } from '$lib/server/providers/types';
import { CalibrationRevisionSchema } from './schemas';
import {
	persistProfileAfterPropositionChange,
	readStyleProfile,
	readStyleReport,
	writeStyleProfile
} from './profile-store';
import { runStructuredStyleAgent } from './run-manager';
import { appendStyleStudyEvent } from './study-log';
import { STYLE_FEATURE_REGISTRY } from './feature-registry';
import { replaceStyleAgentPropositions } from './proposition-store';

const VARIANT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['variant', 'targetExplanation'],
	properties: {
		variant: {
			type: 'string',
			description: 'The passage rewritten so it no longer follows the proposition.'
		},
		targetExplanation: {
			type: 'string',
			description: 'One sentence on what changed between the two.'
		}
	}
};

const REVISION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['statement', 'instruction'],
	properties: {
		statement: { type: 'string' },
		instruction: { type: 'string' }
	}
};

function findTrial(profile: StyleProfile, id: string): { trial: CalibrationTrial; proposition: StyleProposition } {
	const trial = profile.calibrations.find((candidate) => candidate.id === id);
	if (!trial) throw new Error('Calibration trial not found');
	const proposition = profile.propositions.find((candidate) => candidate.id === trial.propositionId);
	if (!proposition) throw new Error('Calibration proposition not found');
	return { trial, proposition };
}

// A bare URL is deliberately not a marker: the author's own prose cites links,
// and a navigation strip is already caught by running on without a full stop.
const CHROME_MARKERS =
	/\b\d+\s*min read\b|\bfollow\s+\S+\s+on\b|\bsubscribe\b|\bshare this\b|\bcookie\b|\ball rights reserved\b|<\/?[a-z][^>]*>/gi;

/**
 * Sources are pasted from web pages, so they drag in navigation strips,
 * bylines and "12 min read" labels. Chrome runs on for dozens of words without
 * a full stop, which is the tell: prose stops. A passage scoring high here is a
 * bad thing to ask the writer to judge, because they never wrote it.
 */
function chromePenalty(text: string): number {
	const words = text.split(/\s+/).filter(Boolean);
	if (!words.length) return Number.POSITIVE_INFINITY;
	const stops = (text.match(/[.!?]["'’)\]]?(?:\s|$)/g) ?? []).length;
	const wordsPerSentence = stops ? words.length / stops : words.length;
	const markers = (text.match(CHROME_MARKERS) ?? []).length;
	return markers * 2 + Math.max(0, wordsPerSentence - 45) / 45;
}

/**
 * A passage the author actually wrote, for this proposition. Comparing two
 * invented passages about a generic topic tells the writer nothing — the
 * question is whether *their own* sentence reads better with or without the
 * proposition applied.
 */
function passageFor(proposition: StyleProposition, report: StyleAnalysisReport | null): string | null {
	const longEnough = (text: string) => text.split(/\s+/).length >= 12;
	const tiers = [
		(proposition.examples ?? []).map((example) => example.trim()).filter(longEnough),
		(report?.examples ?? [])
			.filter((example) => example.kind === proposition.family || example.kind.startsWith(`${proposition.family}.`))
			.map((example) => example.text.trim())
			.filter(longEnough),
		(report?.examples ?? []).map((example) => example.text.trim()).filter(longEnough)
	];
	for (const tier of tiers) {
		const prose = tier.filter((text) => chromePenalty(text) < 1);
		if (prose.length) return prose[0];
	}
	// Everything available looks like chrome. The least of it still beats
	// handing the writer a navigation bar to judge.
	const all = tiers.flat();
	if (!all.length) return null;
	return all.reduce((best, text) => (chromePenalty(text) < chromePenalty(best) ? text : best));
}

export async function generateCalibrationTrial(input: {
	id: string;
	provider: ProviderId;
	model?: string;
}): Promise<CalibrationTrial> {
	let profile = readStyleProfile();
	const report = readStyleReport();
	if (!profile || !report) throw new Error('Style profile not found');
	const { trial, proposition } = findTrial(profile, input.id);

	// The specialist that wrote this proposition also wrote the comparison,
	// while it had the sources in front of it. Use that. The agent below only
	// runs for propositions from before contrasts existed, or ones whose
	// contrast failed grounding.
	let original: string;
	let variant: string;
	if (proposition.contrast) {
		original = proposition.contrast.passage;
		variant = proposition.contrast.rewritten;
	} else {
		const fallbackPassage = passageFor(proposition, report);
		if (!fallbackPassage) throw new Error('No passage from your sources was long enough to compare');
		const generated = await runStructuredStyleAgent<{ variant: string; targetExplanation: string }>({
			providerId: input.provider,
			model: input.model,
			effort: 'medium',
			systemPrompt: `You rewrite one passage of the author's own writing to test a single style proposition.

Return the passage rewritten so that it no longer follows the proposition, changing nothing else. Keep the meaning, facts, names, numbers, citations, and length as close to the original as you can. The rewrite must still be good, publishable prose — it is an alternative, not a worse version. Change only what the proposition governs.

Call submit_style_variant once.`,
			prompt: `Proposition to vary:\n${proposition.statement}\n\nWhat following it means:\n${proposition.instruction}\n\nThe author's passage:\n${fallbackPassage}`,
			toolName: 'submit_style_variant',
			toolDescription: 'Submit the passage rewritten without the proposition applied.',
			inputSchema: VARIANT_SCHEMA,
			parse: (value) => {
				const parsed = value as { variant?: unknown; targetExplanation?: unknown };
				const rewritten = typeof parsed.variant === 'string' ? parsed.variant.trim() : '';
				if (rewritten.length < 20) throw new Error('The variant is too short');
				if (rewritten === fallbackPassage.trim()) throw new Error('The variant is identical to the original');
				return {
					variant: rewritten,
					targetExplanation: typeof parsed.targetExplanation === 'string' ? parsed.targetExplanation : ''
				};
			}
		});
		original = fallbackPassage;
		variant = generated.variant;
	}

	// The original follows the proposition, so whichever slot holds it is the
	// target. Randomize the slot so position does not bias the choice.
	const swap = Math.random() < 0.5;
	const candidateA = swap ? variant : original;
	const candidateB = swap ? original : variant;
	const targetCandidate: 'a' | 'b' = swap ? 'b' : 'a';
	const nextTrial: CalibrationTrial = {
		...trial,
		status: 'generated',
		candidateA,
		candidateB,
		targetCandidate,
		generatedAt: Date.now(),
		error: undefined
	};
	profile.calibrations = profile.calibrations.map((candidate) => candidate.id === trial.id ? nextTrial : candidate);
	profile = writeStyleProfile(profile);
	appendStyleStudyEvent('calibration_generated', {
		calibrationId: trial.id,
		propositionId: proposition.id,
		family: proposition.family,
		provider: input.provider,
		model: input.model
	});
	return profile.calibrations.find((candidate) => candidate.id === trial.id)!;
}

async function reviseFromChoice(input: {
	provider: ProviderId;
	model?: string;
	proposition: StyleProposition;
	chosenText: string;
	reason: string;
}): Promise<{ statement: string; instruction: string }> {
	return runStructuredStyleAgent({
		providerId: input.provider,
		model: input.model,
		effort: 'medium',
		systemPrompt: `Update one style proposition from direct user feedback. The chosen passage is a positive example. Derive a concise descriptive statement and an imperative writing instruction. Do not infer subject matter preferences. Call submit_calibration_revision once.`,
		prompt: `Previous proposition:\n${JSON.stringify(input.proposition)}\n\nFeedback reason:\n${input.reason}\n\nPositive example:\n${input.chosenText}`,
		toolName: 'submit_calibration_revision',
		toolDescription: 'Submit the revised user confirmed style proposition.',
		inputSchema: REVISION_SCHEMA,
		parse: (value) => CalibrationRevisionSchema.parse(value)
	});
}

export async function answerCalibrationTrial(input: {
	id: string;
	choice: CalibrationChoice;
	editedText?: string;
	provider: ProviderId;
	model?: string;
}): Promise<{ profile: StyleProfile; trial: CalibrationTrial }> {
	let profile = readStyleProfile();
	const report = readStyleReport();
	if (!profile || !report) throw new Error('Style profile has not been analyzed');
	const { trial, proposition } = findTrial(profile, input.id);
	if (input.choice === 'neither' && !input.editedText?.trim()) {
		throw new Error('Edit one candidate into acceptable text, or skip this proposition');
	}
	if (!trial.candidateA || !trial.candidateB) throw new Error('Generate the close comparison before answering it');
	if (input.choice === 'neither' && [trial.candidateA.trim(), trial.candidateB.trim()].includes(input.editedText!.trim())) {
		throw new Error('Change one candidate into acceptable text, or skip this proposition');
	}

	let nextProposition: StyleProposition = { ...proposition, updatedAt: Date.now() };
	if (input.choice === 'same') {
		nextProposition.status = 'not-actionable';
	} else if (input.choice === 'skip') {
		nextProposition.status = 'skipped';
	} else {
		const chosenText = input.choice === 'a' ? trial.candidateA
			: input.choice === 'b' ? trial.candidateB
			: input.editedText!.trim();
		const supportsCurrent = input.choice === trial.targetCandidate;
		if (!supportsCurrent || input.choice === 'neither') {
			const revision = await reviseFromChoice({
				provider: input.provider,
				model: input.model,
				proposition,
				chosenText,
				reason: input.choice === 'neither' ? 'The user rejected both generated passages and wrote an acceptable version.' : 'The user preferred the close variant that did not support the previous proposition.'
			});
			replaceStyleAgentPropositions(
				profile.lastRun?.id ?? 'profile',
				'revision',
				`calibration:${trial.id}`,
				[{ ...proposition, ...revision, updatedAt: Date.now() }]
			);
			nextProposition = {
				...nextProposition,
				statement: revision.statement,
				instruction: revision.instruction
			};
		}
		nextProposition.status = 'confirmed';
		nextProposition.confidence = 1;
		// The passage the writer picked is the best example there is.
		nextProposition.examples = [chosenText, ...nextProposition.examples.filter((e) => e !== chosenText)].slice(0, 8);
	}
	const nextTrial: CalibrationTrial = {
		...trial,
		status: input.choice === 'skip' ? 'skipped' : 'answered',
		choice: input.choice,
		...(input.choice === 'neither' ? { editedText: input.editedText!.trim() } : {}),
		answeredAt: Date.now()
	};
	profile.propositions = profile.propositions.map((candidate) => candidate.id === proposition.id ? nextProposition : candidate);
	profile.calibrations = profile.calibrations.map((candidate) => candidate.id === trial.id ? nextTrial : candidate);
	profile = persistProfileAfterPropositionChange(profile);
	appendStyleStudyEvent('calibration_answered', {
		calibrationId: trial.id,
		propositionId: proposition.id,
		family: proposition.family,
		choice: input.choice,
		hadEdit: Boolean(input.editedText?.trim()),
		durationMs: trial.generatedAt ? Date.now() - trial.generatedAt : undefined,
		propositionConfidence: proposition.confidence,
		confirmedCurrentDirection: input.choice === 'a' || input.choice === 'b'
			? input.choice === trial.targetCandidate
			: undefined,
		provider: input.provider,
		model: input.model
	});
	return { profile, trial: profile.calibrations.find((candidate) => candidate.id === trial.id)! };
}
