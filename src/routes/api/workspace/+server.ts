/**
 * Workspace identity and review-UI recovery.
 *
 *   GET  — folder currently open, where `.docwriter` lives, leftover tab
 *          state, and a warning when the invoke cwd has a different
 *          `.docwriter`.
 *   POST — reset_ui / reopen_tab / purge_tab.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isValidTabId } from '$lib/server/document-files';
import { getWorkspaceInfo } from '$lib/server/workspace-identity';
import { resetWorkspaceUiState } from '$lib/server/reset-ui-state';
import { getTabsState } from '$lib/server/runtime-state';
import { listLeftoverTabs, purgeLeftoverTab, reopenLeftoverTab } from '$lib/server/leftover-tabs';

export const GET: RequestHandler = async () => {
	return json({
		...getWorkspaceInfo(),
		activeTabId: getTabsState().active,
		leftovers: listLeftoverTabs()
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const action = typeof body?.action === 'string' ? body.action : '';

	if (action === 'reopen_tab') {
		const tabId = String(body?.tabId || '').trim();
		if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
		try {
			const state = reopenLeftoverTab(tabId);
			return json({ ok: true, ...state, leftovers: listLeftoverTabs() });
		} catch (err) {
			throw error(400, err instanceof Error ? err.message : String(err));
		}
	}

	if (action === 'purge_tab') {
		const tabId = String(body?.tabId || '').trim();
		if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
		try {
			const state = await purgeLeftoverTab(tabId);
			return json({ ok: true, ...state, leftovers: listLeftoverTabs() });
		} catch (err) {
			throw error(400, err instanceof Error ? err.message : String(err));
		}
	}

	if (action !== 'reset_ui') {
		throw error(400, 'Unknown workspace action');
	}
	const reviews = body.reviews !== false;
	const comments = body.comments !== false;
	if (!reviews && !comments) {
		throw error(400, 'Choose reviews and/or comments to clear');
	}
	let tabId: string | undefined;
	if (body.scope === 'active') {
		const active = getTabsState().active;
		if (!active) throw error(400, 'No active tab');
		tabId = active;
	} else if (typeof body.tabId === 'string') {
		if (!isValidTabId(body.tabId)) throw error(400, 'Invalid tab id');
		tabId = body.tabId;
	}
	const result = await resetWorkspaceUiState({ reviews, comments, tabId });
	return json({ ok: true, leftovers: listLeftoverTabs(), ...result });
};
