import {
	dbClearSessionState,
	dbReplaceActionUsageCounts,
	dbReplaceRecentActions,
	dbReplaceRules,
	dbSetAgentSettings,
	dbSetSessionId,
	dbSetEditorSoftWrap,
	dbUpsertTabs,
	kvGet
} from './db-writes';
import { getDb } from './db';

/**
 * Server-side runtime state lives in SQLite (`.docwriter/docwriter.db`).
 * It covers:
 *
 *   - Session resume for the Claude Agent SDK (`sessionId`)
 *   - The selection-feedback action toolbar (`recentActions`, `actionUsageCounts`)
 *   - Writing rules (`rules`) — consumed by `/api/render` when building the agent prompt
 *   - Agent behavior settings (`agentSettings`) — autonomy level and review-mode toggle
 *   - Open tab order + active tab
 */
export interface Rule {
	id: string;
	text: string;
}

export interface AgentSettings {
	agency: 'conservative' | 'balanced' | 'aggressive';
	trackChanges: boolean;
}

// Default soft-wrap on so long lines (e.g. a paragraph with inline [[ agent ]]
// directives) don't silently clip off the right edge of the editor with no
// visible scroll affordance. Users can still flip it off via Settings.
const DEFAULT_EDITOR_SOFT_WRAP = true;

export interface TabsState {
	/** Tab IDs in display order. Tab ID = filename without the .md extension. */
	order: string[];
	/** ID of the tab the user last had focused. null = no tabs yet (fresh install). */
	active: string | null;
}

const DEFAULT_TABS: TabsState = { order: [], active: null };

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	agency: 'conservative',
	trackChanges: true
};

/** A process-unique UUID generated once in `hooks.server.ts`. Clients read
 * this over HTTP and compare to their last-known value; a mismatch means
 * they're talking to a different server process than last time and must
 * discard their in-memory Y.Docs before the WebSocket provider attaches,
 * or stale client state would sync up and clobber disk. */
export function getServerInstanceId(): string {
	const value = (globalThis as unknown as { __docwriterServerInstanceId?: string })
		.__docwriterServerInstanceId;
	// Fallback covers the (unreachable in normal flow) case where
	// `hooks.server.ts` never ran; a stable fallback here still lets the
	// client compare against itself.
	return value ?? 'unknown';
}

export function getSessionId(): string | null {
	return kvGet('sessionId');
}

export function setSessionId(sessionId: string) {
	dbSetSessionId(sessionId);
}

export function clearSessionState() {
	dbClearSessionState();
}

export function getRecentActions(): Array<{
	id: string;
	label: string;
	icon: string;
	pinned: boolean;
	color: string;
}> {
	const rows = getDb()
		.prepare('SELECT rowid, label FROM recent_actions ORDER BY rowid ASC')
		.all() as Array<{ rowid: number; label: string }>;
	return rows.map((row) => ({
		id: `custom_${row.rowid}`,
		label: row.label,
		icon: 'message-square',
		pinned: false,
		color: '#7c3aed'
	}));
}

export function setRecentActions(
	actions: Array<{ label: string }> | undefined
) {
	dbReplaceRecentActions(actions);
}

export function getActionUsageCounts(): Record<string, number> {
	const rows = getDb()
		.prepare('SELECT action, count FROM action_usage_counts')
		.all() as Array<{ action: string; count: number }>;
	return Object.fromEntries(rows.map((row) => [row.action, row.count]));
}

export function setActionUsageCounts(counts: Record<string, number>) {
	dbReplaceActionUsageCounts(counts);
}

export function getRules(): Rule[] {
	return getDb()
		.prepare('SELECT id, text FROM rules ORDER BY rowid ASC')
		.all() as Rule[];
}

export function setRules(rules: Rule[]) {
	dbReplaceRules(rules);
}

export function getAgentSettings(): AgentSettings {
	try {
		const raw = kvGet('agentSettings');
		if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
		return { ...DEFAULT_AGENT_SETTINGS, ...(JSON.parse(raw) as Partial<AgentSettings>) };
	} catch {
		return { ...DEFAULT_AGENT_SETTINGS };
	}
}

export function setAgentSettings(settings: AgentSettings) {
	dbSetAgentSettings(settings);
}

export function getEditorSoftWrap(): boolean {
	const raw = kvGet('editorSoftWrap');
	if (raw === null) return DEFAULT_EDITOR_SOFT_WRAP;
	return raw === 'true';
}

export function setEditorSoftWrap(enabled: boolean) {
	dbSetEditorSoftWrap(enabled);
}

export function getTabsState(): TabsState {
	const rows = getDb()
		.prepare(
			'SELECT tab_id, order_index, is_active FROM tabs ORDER BY order_index ASC'
		)
		.all() as Array<{
			tab_id: string;
			order_index: number;
			is_active: number;
		}>;
	if (rows.length === 0) return { ...DEFAULT_TABS };
	const order = rows.map((row) => row.tab_id);
	const active = rows.find((row) => row.is_active === 1)?.tab_id ?? null;
	return { order, active };
}

export function setTabsState(tabs: TabsState) {
	dbUpsertTabs(tabs);
}
