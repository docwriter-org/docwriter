import type { CalibrationChoice, CalibrationTrial, StyleAnalysisReport, StyleProfile, StyleProposition } from '$lib/style-profile';
import type { ProviderId } from '$lib/server/providers/types';
import { compileAuthorStyleSkill } from './skill-compiler';
import { CalibrationRevisionSchema } from './schemas';
import { readStyleProfile, readStyleReport, writeStyleProfile } from './profile-store';
import { runStructuredStyleAgent } from './run-manager';
import { appendStyleStudyEvent } from './study-log';
import { STYLE_FEATURE_REGISTRY } from './feature-registry';

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
	required: ['statement', 'instruction', 'scope'],
	properties: {
		statement: { type: 'string' },
		instruction: { type: 'string' },
		scope: { type: 'array', items: { type: 'string' } }
	}
};

function findTrial(profile: StyleProfile, id: string): { trial: CalibrationTrial; proposition: StyleProposition } {
	const trial = profile.calibrations.find((candidate) => candidate.id === id);
	if (!trial) throw new Error('Calibration trial not found');
	const proposition = profile.propositions.find((candidate) => candidate.id === trial.propositionId);
	if (!proposition) throw new Error('Calibration proposition not found');
	return { trial, proposition };
}

/**
 * A passage the author actually wrote, for this proposition. Comparing two
 * invented passages about a generic topic tells the writer nothing — the
 * question is whether *their own* sentence reads better with or without the
 * proposition applied.
 */
function passageFor(proposition: StyleProposition, report: StyleAnalysisReport | null): string | null {
	const fromProposition = (proposition.examples ?? [])
		.map((example) => example.trim())
		.filter((example) => example.split(/\s+/).length >= 12);
	if (fromProposition.length) return fromProposition[0];

	const spans = (report?.examples ?? [])
		.filter((example) => example.kind === proposition.family || example.kind.startsWith(`${proposition.family}.`))
		.map((example) => example.text.trim())
		.filter((text) => text.split(/\s+/).length >= 12);
	if (spans.length) return spans[0];

	const anySpan = (report?.examples ?? [])
		.map((example) => example.text.trim())
		.filter((text) => text.split(/\s+/).length >= 12);
	return anySpan[0] ?? null;
}

export async function generateCalibrationTrial(input: {
	id: string;
	provider: ProviderId;
	model?: string;
	contentBrief?: string;
}): Promise<CalibrationTrial> {
	let profile = readStyleProfile();
	const report = readStyleReport();
	if (!profile || !report) throw new Error('Style profile not found');
	const { trial, proposition } = findTrial(profile, input.id);
	const brief = input.contentBrief?.trim() || 'Write a short, self-contained passage about planning a small research project. Keep all facts generic.';
	let feedback = '';
	// The comparison is the writer's own passage against the same passage with
	// this one proposition undone. Anything else asks them to judge prose they
	// never wrote about a topic they did not choose.
	const original = passageFor(proposition, report);
	if (!original) throw new Error('No passage from your sources was long enough to compare');

	const generated = await runStructuredStyleAgent<{ variant: string; targetExplanation: string }>({
		providerId: input.provider,
		model: input.model,
		systemPrompt: `You rewrite one passage of the author's own writing to test a single style proposition.

Return the passage rewritten so that it no longer follows the proposition, changing nothing else. Keep the meaning, facts, names, numbers, citations, and length as close to the original as you can. The rewrite must still be good, publishable prose — it is an alternative, not a worse version. Change only what the proposition governs.

Call submit_style_variant once.`,
		prompt: `Proposition to vary:\n${proposition.statement}\n\nWhat following it means:\n${proposition.instruction}\n\nThe author's passage:\n${original}${feedback ? `\n\nPrevious problem:\n${feedback}` : ''}`,
		toolName: 'submit_style_variant',
		toolDescription: 'Submit the passage rewritten without the proposition applied.',
		inputSchema: VARIANT_SCHEMA,
		parse: (value) => {
			const parsed = value as { variant?: unknown; targetExplanation?: unknown };
			const variant = typeof parsed.variant === 'string' ? parsed.variant.trim() : '';
			if (variant.length < 20) throw new Error('The variant is too short');
			if (variant === original.trim()) throw new Error('The variant is identical to the original');
			return {
				variant,
				targetExplanation: typeof parsed.targetExplanation === 'string' ? parsed.targetExplanation : ''
			};
		},
		abortSignal: new AbortController().signal
	});

	// The original follows the proposition, so whichever slot holds it is the
	// target. Randomize the slot so position does not bias the choice.
	const swap = Math.random() < 0.5;
	const candidateA = swap ? generated.variant : original;
	const candidateB = swap ? original : generated.variant;
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
}): Promise<{ statement: string; instruction: string; scope: string[] }> {
	return runStructuredStyleAgent({
		providerId: input.provider,
		model: input.model,
		systemPrompt: `Update one style proposition from direct user feedback. The chosen passage is a positive example. Derive a concise descriptive statement and an imperative writing instruction. Do not infer subject matter preferences. Call submit_calibration_revision once.`,
		prompt: `Previous proposition:\n${JSON.stringify(input.proposition)}\n\nFeedback reason:\n${input.reason}\n\nPositive example:\n${input.chosenText}`,
		toolName: 'submit_calibration_revision',
		toolDescription: 'Submit the revised user confirmed style proposition.',
		inputSchema: REVISION_SCHEMA,
		parse: (value) => CalibrationRevisionSchema.parse(value),
		abortSignal: new AbortController().signal
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
			nextProposition = { ...nextProposition, ...revision };
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
	const unresolved = profile.propositions.filter((candidate) => candidate.status === 'pending').length;
	const active = profile.propositions.filter((candidate) => ['active', 'confirmed'].includes(candidate.status));
	profile.status = unresolved ? 'needs-calibration' : active.length ? 'active' : 'ready-to-analyze';
	if (active.length) {
		const skill = compileAuthorStyleSkill(profile, report);
		profile.skillId = skill.skillId;
		profile.skillPath = skill.skillPath;
	}
	profile = writeStyleProfile(profile);
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
