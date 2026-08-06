import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { CalibrationChoice } from '$lib/style-profile';
import type { ProviderId } from '$lib/server/providers/types';
import { answerCalibrationTrial, generateCalibrationTrial } from '$lib/server/style-analysis/calibration';
import { styleProfileForClient } from '$lib/server/style-analysis/profile-store';

const PROVIDERS = new Set<ProviderId>(['claude', 'openai', 'codex', 'cursor', 'pi']);
const CHOICES = new Set<CalibrationChoice>(['a', 'b', 'same', 'neither', 'skip']);

function providerFrom(value: unknown): ProviderId {
	if (!PROVIDERS.has(value as ProviderId)) throw error(400, 'Invalid provider');
	return value as ProviderId;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	try {
		const trial = await generateCalibrationTrial({
			id: params.id,
			provider: providerFrom(body.provider),
			model: typeof body.model === 'string' && body.model ? body.model : undefined,
			contentBrief: typeof body.contentBrief === 'string' ? body.contentBrief : undefined
		});
		const { targetCandidate: _targetCandidate, ...publicTrial } = trial;
		return json({ trial: publicTrial });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : String(cause));
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	if (!CHOICES.has(body.choice as CalibrationChoice)) throw error(400, 'Invalid calibration choice');
	try {
		const result = await answerCalibrationTrial({
			id: params.id,
			choice: body.choice,
			editedText: typeof body.editedText === 'string' ? body.editedText : undefined,
			provider: providerFrom(body.provider),
			model: typeof body.model === 'string' && body.model ? body.model : undefined
		});
		const { targetCandidate: _targetCandidate, ...publicTrial } = result.trial;
		return json({ profile: styleProfileForClient(result.profile), trial: publicTrial });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : String(cause));
	}
};
