/**
 * Tabs that still have CRDT / last_seen state but are not currently
 * visible. Close is supposed to leave this data so reopen is cheap.
 * Accidental drops from the `tabs` table (or a rename that did not
 * migrate) leave the same leftovers — surface them for reopen / purge.
 */
import { existsSync } from 'fs';
import { classifyGhostTabs, tabsToAutoRestore, type GhostTab } from '$lib/shared/tab-reconcile';
import { isBinaryOrPreviewPath } from '$lib/shared/file-kinds';
import { isValidTabId, tabFile } from './document-files';
import { getTabsState, setTabsState } from './runtime-state';
import { getClosedTabIds, markTabOpened } from './closed-tabs';
import { listLastSeenTabIds } from './last-seen';
import { listYjsTabIds, yjsTabStats } from './ydoc-persistence';
import { destroyTabState } from './ws-server';

export interface LeftoverTab extends GhostTab {
	listed: boolean;
	intentionallyClosed: boolean;
	updateCount: number;
	lastActivity: number | null;
}

export function listLeftoverTabs(): LeftoverTab[] {
	const stored = getTabsState();
	const closed = new Set(getClosedTabIds());
	const ghosts = classifyGhostTabs({
		openTabIds: stored.order,
		yjsTabIds: listYjsTabIds(),
		lastSeenTabIds: listLastSeenTabIds(),
		fileExists: (id) => existsSync(tabFile(id))
	});
	return ghosts
		.map((ghost) => {
			const stats = yjsTabStats(ghost.tabId);
			return {
				...ghost,
				listed: false,
				intentionallyClosed: closed.has(ghost.tabId),
				updateCount: stats.updateCount,
				lastActivity: stats.lastActivity
			};
		})
		.sort((a, b) => a.tabId.localeCompare(b.tabId));
}

/** Put dropped text tabs back in `tabs` when the file is still on disk
 * and the user never recorded a close. Does not change the active tab. */
export function healOrphanedTabs(): string[] {
	const stored = getTabsState();
	const restore = tabsToAutoRestore({
		leftovers: listLeftoverTabs(),
		intentionallyClosed: getClosedTabIds(),
		shouldSkip: isBinaryOrPreviewPath
	});
	if (restore.length === 0) return [];
	const order = [...stored.order];
	for (const id of restore) {
		if (!order.includes(id)) order.push(id);
	}
	setTabsState({ order, active: stored.active });
	return restore;
}

export function reopenLeftoverTab(tabId: string): { order: string[]; active: string | null } {
	if (!isValidTabId(tabId)) {
		throw new Error('Invalid tab id');
	}
	if (!existsSync(tabFile(tabId))) {
		throw new Error(`File "${tabId}" is not on disk`);
	}
	const state = getTabsState();
	if (!state.order.includes(tabId)) state.order.push(tabId);
	state.active = tabId;
	setTabsState(state);
	markTabOpened(tabId);
	return state;
}

export async function purgeLeftoverTab(tabId: string): Promise<{ order: string[]; active: string | null }> {
	if (!isValidTabId(tabId)) {
		throw new Error('Invalid tab id');
	}
	await destroyTabState(tabId);
	markTabOpened(tabId);
	const stored = getTabsState();
	const order = stored.order.filter((id) => id !== tabId);
	let active = stored.active === tabId ? null : stored.active;
	if (!active && order.length > 0) active = order[0];
	const next = { order, active };
	setTabsState(next);
	return next;
}
