/**
 * Intentional tab closes, persisted so leftover CRDT history is not
 * treated as an accidental drop from the `tabs` table.
 */
import { kvGet, kvSet } from './db-writes';
import { isValidTabId } from './document-files';

const KEY = 'closedTabs';

export function getClosedTabIds(): string[] {
	const raw = kvGet(KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === 'string' && isValidTabId(id));
	} catch {
		return [];
	}
}

function writeClosedTabIds(ids: Iterable<string>): void {
	kvSet(KEY, JSON.stringify([...new Set(ids)].sort()));
}

export function markTabClosed(tabId: string): void {
	if (!isValidTabId(tabId)) return;
	writeClosedTabIds([...getClosedTabIds(), tabId]);
}

export function markTabOpened(tabId: string): void {
	writeClosedTabIds(getClosedTabIds().filter((id) => id !== tabId));
}

export function renameClosedTab(fromId: string, toId: string): void {
	if (fromId === toId) return;
	writeClosedTabIds(getClosedTabIds().map((id) => (id === fromId ? toId : id)));
}
