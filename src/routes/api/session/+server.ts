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
	getEditorLineNumbers,
	setEditorLineNumbers,
	getTheme,
	setTheme
} from '$lib/server/runtime-state';
import { getEffectiveScratchDir } from '$lib/server/document-files';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { logInteraction } from '$lib/server/interaction-log';

export const GET: RequestHandler = async () => {
	return json({
		sessionId: getSessionId(),
		serverInstanceId: getServerInstanceId(),
		recentActions: getRecentActions(),
		actionUsageCounts: getActionUsageCounts(),
		editorSoftWrap: getEditorSoftWrap(),
		editorLineNumbers: getEditorLineNumbers(),
		theme: getTheme()
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	if (body.recentActions) setRecentActions(body.recentActions);
	if (body.actionUsageCounts) setActionUsageCounts(body.actionUsageCounts);
	// Interaction log: prefs are pushed wholesale on a debounced timer, so
	// diff against current values to log only genuine changes. The
	// recentActions/actionUsageCounts mirrors are deliberately not logged —
	// the feedback-chip interactions behind them are captured as thread.new.
	if (typeof body.editorSoftWrap === 'boolean') {
		if (body.editorSoftWrap !== getEditorSoftWrap()) {
			logInteraction('pref.change', { key: 'editorSoftWrap', value: body.editorSoftWrap });
		}
		setEditorSoftWrap(body.editorSoftWrap);
	}
	if (typeof body.editorLineNumbers === 'boolean') {
		if (body.editorLineNumbers !== getEditorLineNumbers()) {
			logInteraction('pref.change', { key: 'editorLineNumbers', value: body.editorLineNumbers });
		}
		setEditorLineNumbers(body.editorLineNumbers);
	}
	if (typeof body.theme === 'string') {
		if (body.theme !== getTheme()) {
			logInteraction('pref.change', { key: 'theme', value: body.theme });
		}
		setTheme(body.theme);
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async () => {
	// Log before clearing: interaction_events itself is never cleared —
	// session.new marks the boundary in the timeline instead.
	logInteraction('session.new');
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
