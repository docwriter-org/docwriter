import * as Y from 'yjs';
import { kvDelete, kvGet, kvKeysWithPrefix, kvSet } from './db-writes';
import { materializePendingReviewText } from '$lib/review-rounds';
import { serializeYDoc, readReviewRounds } from '$lib/shared/ydoc-codec';

export const LAST_SEEN_PREFIX = 'last_seen:';

export function lastSeenKey(tabId: string): string {
	return LAST_SEEN_PREFIX + tabId;
}

export function listLastSeenTabIds(): string[] {
	return kvKeysWithPrefix(LAST_SEEN_PREFIX).map((key) => key.slice(LAST_SEEN_PREFIX.length));
}

export function deleteLastSeen(tabId: string): void {
	kvDelete(lastSeenKey(tabId));
}

export function migrateLastSeen(fromId: string, toId: string): void {
	if (fromId === toId) return;
	const value = kvGet(lastSeenKey(fromId));
	if (value !== null) {
		kvSet(lastSeenKey(toId), value);
		kvDelete(lastSeenKey(fromId));
		return;
	}
	kvDelete(lastSeenKey(fromId));
}

/** Agent-facing markdown for a tab: committed Y.Doc text plus any pending
 * review rounds, with typography normalized to match `serializeYDoc`. */
export function readTabMarkdownForAgent(ydoc: Y.Doc): string {
	return materializePendingReviewText(serializeYDoc(ydoc), readReviewRounds(ydoc));
}

/** Refresh the agent's diff baseline after accept/reject changes what
 * `read_doc` would return (e.g. pending proposal removed). */
export function touchLastSeen(tabId: string, ydoc: Y.Doc): void {
	kvSet(lastSeenKey(tabId), readTabMarkdownForAgent(ydoc));
}
