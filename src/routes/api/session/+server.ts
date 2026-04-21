import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getSessionId,
	getServerInstanceId,
	getRecentActions,
	setRecentActions,
	getActionUsageCounts,
	setActionUsageCounts,
	clearSessionState,
	getEditorSoftWrap,
	setEditorSoftWrap
} from '$lib/server/runtime-state';
import { AGENT_SCRATCH_DIR } from '$lib/server/document-files';
import { existsSync, rmSync } from 'fs';

export const GET: RequestHandler = async () => {
	return json({
		sessionId: getSessionId(),
		serverInstanceId: getServerInstanceId(),
		recentActions: getRecentActions(),
		actionUsageCounts: getActionUsageCounts(),
		editorSoftWrap: getEditorSoftWrap()
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	if (body.recentActions) setRecentActions(body.recentActions);
	if (body.actionUsageCounts) setActionUsageCounts(body.actionUsageCounts);
	if (typeof body.editorSoftWrap === 'boolean') setEditorSoftWrap(body.editorSoftWrap);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async () => {
	clearSessionState();
	// Agent scratch workspace is session-scoped — wipe on New session so
	// the next run starts with a clean slate (no stale drafts or notes
	// from the previous conversation).
	if (existsSync(AGENT_SCRATCH_DIR)) {
		rmSync(AGENT_SCRATCH_DIR, { recursive: true, force: true });
	}
	return json({ ok: true });
};
