import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSkillVersions } from '$lib/server/style-analysis/skill-versions';

/** Saved snapshots of the compiled skill, newest first. */
export const GET: RequestHandler = async () => {
	return json({
		versions: listSkillVersions().map(({ version, createdAt, propositionCount }) => ({
			version,
			createdAt,
			propositionCount
		}))
	});
};
