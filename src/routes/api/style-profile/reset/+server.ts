import { json } from '@sveltejs/kit';
import { existsSync, rmSync } from 'fs';
import type { RequestHandler } from './$types';
import { STYLE_ANALYSIS_DIR, STYLE_PROFILE_FILE } from '$lib/server/style-analysis/profile-store';
import { readStyleProfile } from '$lib/server/style-analysis/profile-store';
import { deleteRunLogs } from '$lib/server/style-analysis/run-log-store';

/**
 * Throw away every learned proposition and the measurement report behind them,
 * so the next run starts from nothing. Sources are left alone — starting over
 * on the analysis should not mean re-collecting the writing.
 */
export const POST: RequestHandler = async () => {
	// The traces belong to the run being thrown away, so they go with it.
	const lastRunId = readStyleProfile()?.lastRun?.id;
	if (lastRunId) deleteRunLogs(lastRunId);
	if (existsSync(STYLE_PROFILE_FILE)) rmSync(STYLE_PROFILE_FILE, { force: true });
	if (existsSync(STYLE_ANALYSIS_DIR)) rmSync(STYLE_ANALYSIS_DIR, { recursive: true, force: true });
	return json({ ok: true });
};
