import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { zipAuthorStyleSkill } from '$lib/server/style/compile-skill';
import { readStyleSkillState } from '$lib/server/style/skill-store';
import { AUTHOR_STYLE_SKILL_ID } from '$lib/server/style/schemas';

export const GET: RequestHandler = async () => {
	const state = readStyleSkillState();
	const skillId = state?.skillId ?? AUTHOR_STYLE_SKILL_ID;
	try {
		const buf = zipAuthorStyleSkill(skillId);
		return new Response(new Uint8Array(buf), {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${skillId}.zip"`
			}
		});
	} catch (err) {
		throw error(404, (err as Error).message);
	}
};
