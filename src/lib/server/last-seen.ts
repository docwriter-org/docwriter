import * as Y from 'yjs';
import { materializePendingReviewText } from '$lib/review-rounds';
import { serializeYDoc, readReviewRounds } from '$lib/shared/ydoc-codec';
import { getLastSeen, setLastSeen } from './documents-store';

/** Agent-facing markdown for a tab: committed Y.Doc text plus any pending
 * review rounds, with typography normalized to match `serializeYDoc`. */
export function readTabMarkdownForAgent(ydoc: Y.Doc): string {
	return materializePendingReviewText(serializeYDoc(ydoc), readReviewRounds(ydoc));
}

/** The agent's diff baseline for a tab — what its prompt last saw. Lives on
 * the `documents` row (was kv `last_seen:<tabId>` before schema v13). */
export function readLastSeen(tabId: string): string | null {
	return getLastSeen(tabId);
}

export function writeLastSeen(tabId: string, markdown: string): void {
	setLastSeen(tabId, markdown);
}

/** Refresh the agent's diff baseline after accept/reject changes what
 * `read_doc` would return (e.g. pending proposal removed). */
export function touchLastSeen(tabId: string, ydoc: Y.Doc): void {
	setLastSeen(tabId, readTabMarkdownForAgent(ydoc));
}
