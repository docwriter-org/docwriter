import { existsSync, readFileSync } from 'fs';
import { STATE_FILE, ensureDocWriterDir } from './document-files';
import { writeJsonAtomic } from './file-utils';

/**
 * All server-side runtime state lives in `.docwriter/state.json`. This single
 * file covers:
 *
 *   - Session resume for the Claude Agent SDK (`sessionId`)
 *   - The selection-feedback action toolbar (`recentActions`, `actionUsageCounts`)
 *   - Writing rules (`rules`) — consumed by `/api/render` when building the agent prompt
 *   - User edit regions (`userEditRegions`) — surfaced in the diff overlay as orange highlights
 *   - Agent behavior settings (`agentSettings`) — autonomy level and review-mode toggle
 */
export interface Rule {
	id: string;
	text: string;
}

export interface UserEditRegion {
	from: number;
	to: number;
	timestamp: number;
}

export interface AgentSettings {
	agency: 'conservative' | 'balanced' | 'aggressive';
	trackChanges: boolean;
}

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

interface RuntimeState {
	sessionId?: string;
	recentActions?: Array<{
		id: string;
		label: string;
		icon: string;
		pinned: boolean;
		color: string;
	}>;
	actionUsageCounts?: Record<string, number>;
	rules?: Rule[];
	userEditRegions?: UserEditRegion[];
	agentSettings?: AgentSettings;
	tabs?: TabsState;
}

function writeRuntimeState(state: RuntimeState) {
	ensureDocWriterDir();
	writeJsonAtomic(STATE_FILE, state);
}

export function readRuntimeState(): RuntimeState {
	ensureDocWriterDir();
	if (!existsSync(STATE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as RuntimeState;
	} catch {
		return {};
	}
}

export function getSessionId(): string | null {
	return readRuntimeState().sessionId || null;
}

export function setSessionId(sessionId: string) {
	writeRuntimeState({ ...readRuntimeState(), sessionId });
}

export function getRecentActions(): RuntimeState['recentActions'] {
	return readRuntimeState().recentActions || [];
}

export function setRecentActions(actions: RuntimeState['recentActions']) {
	writeRuntimeState({ ...readRuntimeState(), recentActions: actions });
}

export function getActionUsageCounts(): Record<string, number> {
	return readRuntimeState().actionUsageCounts || {};
}

export function setActionUsageCounts(counts: Record<string, number>) {
	writeRuntimeState({ ...readRuntimeState(), actionUsageCounts: counts });
}

export function getRules(): Rule[] {
	return readRuntimeState().rules || [];
}

export function setRules(rules: Rule[]) {
	writeRuntimeState({ ...readRuntimeState(), rules });
}

export function getUserEditRegions(): UserEditRegion[] {
	return readRuntimeState().userEditRegions || [];
}

export function setUserEditRegions(regions: UserEditRegion[]) {
	writeRuntimeState({ ...readRuntimeState(), userEditRegions: regions });
}

export function getAgentSettings(): AgentSettings {
	return { ...DEFAULT_AGENT_SETTINGS, ...(readRuntimeState().agentSettings || {}) };
}

export function setAgentSettings(settings: AgentSettings) {
	writeRuntimeState({ ...readRuntimeState(), agentSettings: settings });
}

export function getTabsState(): TabsState {
	return { ...DEFAULT_TABS, ...(readRuntimeState().tabs || {}) };
}

export function setTabsState(tabs: TabsState) {
	writeRuntimeState({ ...readRuntimeState(), tabs });
}
