/**
 * Tab-list vs CRDT-log reconciliation. Pure helpers so we can test the
 * "file briefly missing" and "closed tab still has updates" cases without
 * opening SQLite.
 */

export interface TabsStateLike {
	order: string[];
	active: string | null;
}

/** Tabs whose files currently exist. Does not mutate the stored list —
 * a missing file must not delete the row, or a compile/rename race drops
 * the tab while thousands of yjs_updates remain. */
export function visibleTabsState(
	stored: TabsStateLike,
	fileExists: (tabId: string) => boolean
): TabsStateLike {
	const order = stored.order.filter((id) => fileExists(id));
	let active = stored.active && order.includes(stored.active) ? stored.active : null;
	if (!active && order.length > 0) active = order[0];
	return { order, active };
}

export type GhostTabKind = 'closed' | 'missing';

export interface GhostTab {
	tabId: string;
	kind: GhostTabKind;
	hasUpdates: boolean;
	hasLastSeen: boolean;
}

/** Tab ids that have CRDT or last_seen state but are not in the open-tab
 * list. `closed` = file still there (reopen). `missing` = leftover after
 * a delete/rename that did not migrate persistence. */
export function classifyGhostTabs(input: {
	openTabIds: readonly string[];
	yjsTabIds: readonly string[];
	lastSeenTabIds: readonly string[];
	fileExists: (tabId: string) => boolean;
}): GhostTab[] {
	const open = new Set(input.openTabIds);
	const yjs = new Set(input.yjsTabIds);
	const seen = new Set(input.lastSeenTabIds);
	const ids = [...new Set([...input.yjsTabIds, ...input.lastSeenTabIds])].sort();
	const out: GhostTab[] = [];
	for (const tabId of ids) {
		if (open.has(tabId)) continue;
		out.push({
			tabId,
			kind: input.fileExists(tabId) ? 'closed' : 'missing',
			hasUpdates: yjs.has(tabId),
			hasLastSeen: seen.has(tabId)
		});
	}
	return out;
}

/** Tabs that still have a file and were dropped from `tabs` without a
 * recorded close. Historical workspaces have no close list, so a vanished
 * research file is restored. After this ships, an intentional close is
 * recorded and is not put back. */
export function tabsToAutoRestore(input: {
	leftovers: ReadonlyArray<{ tabId: string; kind: GhostTabKind }>;
	intentionallyClosed: readonly string[];
	shouldSkip?: (tabId: string) => boolean;
}): string[] {
	const closed = new Set(input.intentionallyClosed);
	return input.leftovers
		.filter(
			(item) =>
				item.kind === 'closed' &&
				!closed.has(item.tabId) &&
				!input.shouldSkip?.(item.tabId)
		)
		.map((item) => item.tabId);
}

export type TabRenameResolution = 'rename' | 'already-moved' | 'source-missing' | 'target-exists';

/** File-tree rename moves the file first, then PATCH /api/tabs. Treat
 * "source gone, target present" as already moved so the CRDT log can
 * follow the new path instead of 404ing and orphaning the old tab id. */
export function resolveTabRename(
	fromExists: boolean,
	toExists: boolean
): TabRenameResolution {
	if (fromExists && toExists) return 'target-exists';
	if (fromExists) return 'rename';
	if (toExists) return 'already-moved';
	return 'source-missing';
}
