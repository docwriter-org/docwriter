import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { finalizeStyleProfile } from '$lib/server/style-analysis/finalize';
import { styleProfileForClient } from '$lib/server/style-analysis/profile-store';

export const POST: RequestHandler = async () => {
	try {
		const profile = finalizeStyleProfile();
		return json({ profile: styleProfileForClient(profile) });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : 'Could not finalize the style');
	}
};
