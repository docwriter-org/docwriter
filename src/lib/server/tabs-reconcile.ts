/**
 * Reconcile the open tab bar against the filesystem — without letting a
 * transient gap destroy state.
 *
 * The old behavior dropped a tab from persistence the instant its file
 * failed one `existsSync` probe. Files are routinely absent for a moment in
 * real workspaces — `git pull`/`checkout` rewrites, atomic saves from other
 * editors, LaTeX build tooling — and a single request landing inside that
 * window permanently deleted the registration while its update log and
 * baseline stayed behind: the "most-edited tab missing from the tabs table
 * with thousands of orphaned updates" corruption seen in the field.
 *
 * Rules now:
 *   1. A missing file stamps `missing_since` on the documents row and the
 *      tab STAYS, reported in `missing` so the UI can badge it.
 *   2. A document with CRDT history is NEVER auto-removed: its file is
 *      restorable from the log (the flush loop rewrites it on next load),
 *      so the file coming back — or being regenerated — is a non-event.
 *   3. Only a document with NO history, continuously missing longer than
 *      the grace window, is removed — and since it has no history, removing
 *      the row leaves nothing behind (it was empty identity).
 */
import { existsSync } from 'fs';
import { tabFile } from './document-files';
import {
	listDocuments,
	listOpenTabs,
	deleteDocument,
	setActiveDocument,
	stampMissing,
	clearMissing
} from './documents-store';
import { tabHasPersistedUpdates } from './ydoc-persistence';

export const MISSING_TAB_GRACE_MS = 60_000;

export interface ReconciledTabs {
	order: string[];
	active: string | null;
	/** Open tabs whose file is currently absent (badged in the UI; content
	 * still loads from the CRDT log). */
	missing: string[];
}

export function reconcileOpenTabs(now = Date.now()): ReconciledTabs {
	const open = listDocuments().filter((d) => d.status === 'open');
	const missing: string[] = [];
	for (const doc of open) {
		if (existsSync(tabFile(doc.tabId))) {
			if (doc.missingSince !== null) clearMissing(doc.tabId);
			continue;
		}
		if (tabHasPersistedUpdates(doc.tabId)) {
			// Restorable from the log — keep indefinitely, just badge it.
			stampMissing(doc.tabId, now);
			missing.push(doc.tabId);
			continue;
		}
		const since = stampMissing(doc.tabId, now);
		if (now - since > MISSING_TAB_GRACE_MS) {
			deleteDocument(doc.tabId);
			continue;
		}
		missing.push(doc.tabId);
	}
	const { order, active } = listOpenTabs();
	if (!active && order.length > 0) {
		setActiveDocument(order[0]);
		return { order, active: order[0], missing };
	}
	return { order, active, missing };
}
