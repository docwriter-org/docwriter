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
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

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
	// Empty the scratch dir's contents on New session so the next run
	// starts with a clean slate (no stale drafts or notes from the prior
	// conversation), but keep the dir itself so it stays visible in the
	// filesystem sidebar instead of disappearing and reappearing on first
	// agent write.
	if (existsSync(AGENT_SCRATCH_DIR)) {
		for (const entry of readdirSync(AGENT_SCRATCH_DIR)) {
			rmSync(join(AGENT_SCRATCH_DIR, entry), { recursive: true, force: true });
		}
	}
	return json({ ok: true });
};
