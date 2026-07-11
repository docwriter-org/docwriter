/**
 * Hocuspocus document naming — the ONE place that knows how a (user, tab)
 * pair maps to a document name. In multi-tenant mode doc names are
 * `<userId>:<tabId>`; single-user mode uses the bare tabId. ws-server,
 * mcp-doc-tools, and the persistence flush loop must all agree on this
 * encoding — silent drift here misroutes document updates.
 */
import { isMultiTenant } from './deploy-mode';
import { getActiveUserId } from './request-context';

/** Doc name for a tab, scoped to the current (or an explicit) user. */
export function docNameForTab(tabId: string, userId: string | null = getActiveUserId()): string {
	return userId ? `${userId}:${tabId}` : tabId;
}

/** Inverse of docNameForTab. */
export function parseDocName(documentName: string): { userId: string | null; tabId: string } {
	if (isMultiTenant()) {
		const idx = documentName.indexOf(':');
		if (idx > 0) {
			return { userId: documentName.slice(0, idx), tabId: documentName.slice(idx + 1) };
		}
	}
	return { userId: null, tabId: documentName };
}
