import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	persistProfileAfterPropositionChange,
	readStyleProfile,
	styleProfileForClient
} from '$lib/server/style-analysis/profile-store';

export const PATCH: RequestHandler = async ({ params, request }) => {
	let profile = readStyleProfile();
	if (!profile) throw error(404, 'Style profile not found');
	const body = await request.json();
	const existing = profile.propositions.find((proposition) => proposition.id === params.id);
	if (!existing) throw error(404, 'Style proposition not found');
	if (body.status !== undefined && !['active', 'confirmed', 'disabled'].includes(body.status)) {
		throw error(400, 'Invalid proposition status');
	}
	const next = {
		...existing,
		...(typeof body.instruction === 'string' && body.instruction.trim() ? { instruction: body.instruction.trim() } : {}),
		...(typeof body.statement === 'string' && body.statement.trim() ? { statement: body.statement.trim() } : {}),
		...(body.status ? { status: body.status } : {}),
		updatedAt: Date.now()
	};
	profile.propositions = profile.propositions.map((proposition) => proposition.id === params.id ? next : proposition);
	if (existing.status === 'pending' && body.status) {
		profile.calibrations = profile.calibrations.map((trial) =>
			trial.propositionId === existing.id && ['pending', 'generated', 'error'].includes(trial.status)
				? { ...trial, status: 'skipped' as const, answeredAt: Date.now() }
				: trial
		);
	}
	profile = persistProfileAfterPropositionChange(profile);
	return json({ profile: styleProfileForClient(profile), proposition: next });
};
