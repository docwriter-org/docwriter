import * as Y from 'yjs';
import { proposedText } from '$lib/shared/proposals';
import { getLastSeen, setLastSeen } from './documents-store';

/** Agent-facing text for a tab: the proposed view (every pending proposal
 * shown as if accepted), typography normalized like `serializeYDoc`. */
export function readTabMarkdownForAgent(ydoc: Y.Doc): string {
	return proposedText(ydoc);
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
