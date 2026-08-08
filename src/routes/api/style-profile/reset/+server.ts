import { json } from '@sveltejs/kit';
import { existsSync, rmSync } from 'fs';
import type { RequestHandler } from './$types';
import {
	STYLE_PROFILE_FILE,
	STYLE_REPORT_FILE,
	readStyleProfile,
	writeStyleProfile
} from '$lib/server/style-analysis/profile-store';
import { deleteRunLogs } from '$lib/server/style-analysis/run-log-store';
import {
	clearPersistedStyleProfile,
	replacePublishedStylePropositions
} from '$lib/server/style-analysis/proposition-store';
import { deriveStyleProfileStatus, publishedStylePropositions } from '$lib/style-profile';

/**
 * Throw away the working draft and its measurement report. A published skill
 * remains active until the writer finalizes a replacement. Sources and their
 * materialized cache are left alone.
 */
export const POST: RequestHandler = async () => {
	// The traces belong to the run being thrown away, so they go with it.
	const profile = readStyleProfile();
	const lastRunId = profile?.lastRun?.id;
	if (lastRunId) deleteRunLogs(lastRunId);
	clearPersistedStyleProfile();
	const published = publishedStylePropositions(profile);
	if (profile && published.length > 0) {
		const restored = writeStyleProfile({
			...profile,
			analyzerVersion: profile.publishedAnalyzerVersion ?? profile.analyzerVersion,
			status: deriveStyleProfileStatus(profile.publishedPropositions ?? published),
			sourceSnapshotHash: profile.publishedSourceSnapshotHash ?? profile.sourceSnapshotHash,
			propositions: structuredClone(profile.publishedPropositions ?? published),
			calibrations: [],
			lastRun: undefined
		});
		replacePublishedStylePropositions('profile', restored.publishedPropositions ?? published);
	} else if (existsSync(STYLE_PROFILE_FILE)) {
		rmSync(STYLE_PROFILE_FILE, { force: true });
	}
	if (existsSync(STYLE_REPORT_FILE)) rmSync(STYLE_REPORT_FILE, { force: true });
	return json({ ok: true });
};
