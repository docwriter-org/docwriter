/**
 * Tiny stable string hash (djb2, hex) for deriving ids from content.
 *
 * Used for quick-action ids: `custom_<hash(label)>` stays the same across
 * list rewrites and reorders, so `action_usage_counts` rows keep pointing at
 * the action they were counted for. The old scheme derived ids from SQLite
 * rowids, which restart after a DELETE-all rewrite — reordering the list
 * silently re-keyed every usage count onto a different action.
 */
function stableIdHash(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function actionIdForLabel(label: string): string {
	return `custom_${stableIdHash(label)}`;
}
