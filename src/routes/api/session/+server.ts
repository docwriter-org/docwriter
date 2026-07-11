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
	setEditorSoftWrap,
	getTheme,
	setTheme
} from '$lib/server/runtime-state';
import { getEffectiveScratchDir } from '$lib/server/document-files';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

export const GET: RequestHandler = async ({ locals }) => {
	return json({
		userId: locals.auth?.userId ?? null,
		sessionId: getSessionId(),
		serverInstanceId: getServerInstanceId(),
		recentActions: getRecentActions(),
		actionUsageCounts: getActionUsageCounts(),
		editorSoftWrap: getEditorSoftWrap(),
		theme: getTheme()
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	if (body.recentActions) setRecentActions(body.recentActions);
	if (body.actionUsageCounts) setActionUsageCounts(body.actionUsageCounts);
	if (typeof body.editorSoftWrap === 'boolean') setEditorSoftWrap(body.editorSoftWrap);
	if (typeof body.theme === 'string') setTheme(body.theme);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async () => {
	clearSessionState();
	const scratchDir = getEffectiveScratchDir();
	// Empty the scratch dir's contents on New session so the next run
	// starts with a clean slate (no stale drafts or notes from the prior
	// conversation), but keep the dir itself so it stays visible in the
	// filesystem sidebar instead of disappearing and reappearing on first
	// agent write.
	if (existsSync(scratchDir)) {
		for (const entry of readdirSync(scratchDir)) {
			rmSync(join(scratchDir, entry), { recursive: true, force: true });
		}
	}
	return json({ ok: true });
};
