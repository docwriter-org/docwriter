import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkGlobalStyleSkill } from '$lib/server/style-analysis/profile-store';

/**
 * Check whether a generated style skill exists at ~/.claude/skills/my-writing-style/.
 * Called only when the user explicitly asks — DocWriter does not scan the home
 * directory without permission.
 */
export const GET: RequestHandler = async () => json(checkGlobalStyleSkill());
