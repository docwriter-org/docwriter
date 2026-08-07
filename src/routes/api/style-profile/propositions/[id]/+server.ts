import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { compileAuthorStyleSkill } from '$lib/server/style-analysis/skill-compiler';
import { readStyleProfile, readStyleReport, styleProfileForClient, writeStyleProfile } from '$lib/server/style-analysis/profile-store';
import { isActiveProposition } from '$lib/style-profile';

export const PATCH: RequestHandler = async ({ params, request }) => {
	let profile = readStyleProfile();
	const report = readStyleReport();
	if (!profile || !report) throw error(404, 'Style profile not found');
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
		...(Array.isArray(body.scope) ? { scope: body.scope.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim())).map((item: string) => item.trim()) } : {}),
		...(body.status ? { status: body.status } : {}),
		updatedAt: Date.now()
	};
	profile.propositions = profile.propositions.map((proposition) => proposition.id === params.id ? next : proposition);
	const unresolved = profile.propositions.some((proposition) => proposition.status === 'pending');
	const hasActive = profile.propositions.some(isActiveProposition);
	profile.status = unresolved ? 'needs-calibration' : hasActive ? 'active' : 'ready-to-analyze';
	const skill = compileAuthorStyleSkill(profile, report);
	profile.skillId = skill.skillId;
	profile.skillPath = skill.skillPath;
	profile = writeStyleProfile(profile);
	return json({ profile: styleProfileForClient(profile), proposition: next });
};
