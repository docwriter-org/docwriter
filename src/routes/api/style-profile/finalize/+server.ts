import { error, json } from '@sveltejs/kit';
import { cpSync, mkdirSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { finalizeStyleProfile } from '$lib/server/style-analysis/finalize';
import { GLOBAL_STYLE_SKILL_DIR, styleProfileForClient } from '$lib/server/style-analysis/profile-store';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		const saveToGlobal = body?.saveToGlobal === true;

		const profile = finalizeStyleProfile();

		let savedGlobally = false;
		if (saveToGlobal && profile.skillPath) {
			mkdirSync(GLOBAL_STYLE_SKILL_DIR, { recursive: true });
			cpSync(profile.skillPath, GLOBAL_STYLE_SKILL_DIR, { recursive: true });
			savedGlobally = true;
		}

		return json({
			profile: styleProfileForClient(profile),
			savedGlobally
		});
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : 'Could not finalize the style');
	}
};
