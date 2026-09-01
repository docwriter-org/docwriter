/**
 * Keep SQLite + in-memory tab identity aligned after a file rename.
 */
import { listYjsTabIds, renameTabUpdates } from './ydoc-persistence';
import { listLastSeenTabIds, migrateLastSeen } from './last-seen';
import { getTabsState, setTabsState } from './runtime-state';
import { unloadTabDocument } from './ws-server';
import { renameClosedTab } from './closed-tabs';

export async function migrateRenamedTab(fromId: string, toId: string): Promise<void> {
	if (fromId === toId) return;
	renameTabUpdates(fromId, toId);
	migrateLastSeen(fromId, toId);
	renameClosedTab(fromId, toId);
	await unloadTabDocument(fromId);
}

/** After a file-tree rename or folder move, remaps every tab id (open or
 * leftover) that lived at or under `fromPath`. */
export async function migrateTabsUnderPath(fromPath: string, toPath: string): Promise<void> {
	if (!fromPath || fromPath === toPath) return;
	const prefix = `${fromPath}/`;
	const known = new Set([...getTabsState().order, ...listYjsTabIds(), ...listLastSeenTabIds()]);
	const remaps: Array<[string, string]> = [];
	for (const id of known) {
		if (id === fromPath) remaps.push([id, toPath]);
		else if (id.startsWith(prefix)) remaps.push([id, `${toPath}${id.slice(fromPath.length)}`]);
	}
	for (const [fromId, toId] of remaps) {
		await migrateRenamedTab(fromId, toId);
	}
	if (remaps.length === 0) return;
	const mapped = new Map(remaps);
	const state = getTabsState();
	state.order = [...new Set(state.order.map((id) => mapped.get(id) ?? id))];
	if (state.active && mapped.has(state.active)) state.active = mapped.get(state.active) ?? state.active;
	setTabsState(state);
}
