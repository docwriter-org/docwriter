import { json } from '@sveltejs/kit';
import { existsSync, rmSync } from 'fs';
import type { RequestHandler } from './$types';
import {
	STYLE_PROFILE_FILE,
	STYLE_REPORT_FILE,
	readStyleProfile
} from '$lib/server/style-analysis/profile-store';
import { deleteRunLogs } from '$lib/server/style-analysis/run-log-store';

/**
 * Throw away every learned proposition and the measurement report behind them,
 * so the next run starts from nothing. Sources and their materialized cache are
 * left alone — starting over on the analysis should not mean re-collecting or
 * re-extracting the writing.
 */
export const POST: RequestHandler = async () => {
	// The traces belong to the run being thrown away, so they go with it.
	const lastRunId = readStyleProfile()?.lastRun?.id;
	if (lastRunId) deleteRunLogs(lastRunId);
	if (existsSync(STYLE_PROFILE_FILE)) rmSync(STYLE_PROFILE_FILE, { force: true });
	if (existsSync(STYLE_REPORT_FILE)) rmSync(STYLE_REPORT_FILE, { force: true });
	return json({ ok: true });
};
