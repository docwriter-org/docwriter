import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ensureCalibrationTrial,
	resolveCalibration
} from '$lib/server/style/pipeline';
import type { CalibrationResponse } from '$lib/server/style/calibrate';

export const POST: RequestHandler = async ({ params }) => {
	try {
		// id is proposition id for generation
		const trial = await ensureCalibrationTrial(params.id);
		return json({ trial });
	} catch (err) {
		throw error(400, (err as Error).message);
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => ({}));
	const response = body.response as CalibrationResponse;
	if (!['a', 'b', 'same', 'edited', 'skip'].includes(response)) {
		throw error(400, 'Invalid response');
	}
	if (response === 'edited' && typeof body.editedText !== 'string') {
		throw error(400, 'editedText required when response is edited');
	}
	try {
		const state = resolveCalibration({
			trialId: params.id,
			response,
			editedText: typeof body.editedText === 'string' ? body.editedText : undefined
		});
		return json({
			ok: true,
			unresolved: state.propositions.filter((p) => p.status === 'calibration' && p.enabled)
				.length,
			proposition: state.propositions.find((p) =>
				state.calibrationTrials.some((t) => t.id === params.id && t.propositionId === p.id)
			)
		});
	} catch (err) {
		throw error(400, (err as Error).message);
	}
};
