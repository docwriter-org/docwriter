import {
	existsSync,
	readFileSync,
	copyFileSync,
	unlinkSync,
	mkdirSync
} from 'fs';
import { dirname } from 'path';
import { applyPatch, createPatch } from 'diff';
import { writeTextAtomic } from './file-utils';
import {
	tabFile,
	tabAgentFile,
	ensureDocWriterDir,
	ensureAgentDirFor
} from './document-files';
import { getTabsState } from './runtime-state';
import {
	getLastSyncedUserMd,
	setLastSyncedUserMd
} from './document-lock';
import {
	getRules,
	setRules,
	getAgentSettings,
	setAgentSettings,
	type Rule,
	type AgentSettings
} from './runtime-state';

/**
 * Server-side document layer.
 *
 * Any file in the workspace can be an open tab. For each tab, we maintain:
 *
 *   - `<tabId>`                — the user-facing file at its real location
 *                                under DOCWRITER_ROOT.
 *   - `.docwriter/agent/<tabId>` — the per-tab transient shadow the Claude
 *                                  Agent SDK's Edit/Write tool targets.
 *
 * The list of currently-open tabs lives in `.docwriter/state.json` under
 * `tabs.order`. Files on disk that aren't in that list aren't watched.
 *
 * Rules / agentSettings / sessionId also live in state.json. Review
 * baselines + pre-agent snapshots are per-tab Y.Doc state on the client
 * (y-indexeddb).
 */

export interface DocMeta {
	rules: Rule[];
	agentSettings: AgentSettings;
}

export function readUserDoc(tabId: string): string {
	ensureDocWriterDir();
	const path = tabFile(tabId);
	if (!existsSync(path)) return '';
	return readFileSync(path, 'utf-8');
}

export function readAgentDoc(tabId: string): string | null {
	const path = tabAgentFile(tabId);
	if (!existsSync(path)) return null;
	return readFileSync(path, 'utf-8');
}

export function readMeta(): DocMeta {
	return {
		rules: getRules(),
		agentSettings: getAgentSettings()
	};
}

export function writeMeta(meta: Partial<DocMeta>) {
	if (meta.rules !== undefined) setRules(meta.rules);
	if (meta.agentSettings !== undefined) setAgentSettings(meta.agentSettings);
}

export function writeUserDoc(tabId: string, markdown: string, meta?: Partial<DocMeta>) {
	ensureDocWriterDir();
	const userPath = tabFile(tabId);
	// Ensure the user-facing parent exists (e.g. "drafts/" for
	// "drafts/chapter-1.md").
	mkdirSync(dirname(userPath), { recursive: true });
	writeTextAtomic(userPath, markdown);
	if (meta) writeMeta(meta);
}

/**
 * Called by the render endpoint's PreToolUse hook before each agent Edit/Write
 * on the active tab's shadow. Patches any user edits made since the last sync
 * into the shadow. If the patch can't apply (conflict with agent edits in
 * this round), we skip — the agent's Edit tool will fail on old_string
 * mismatch and re-Read.
 */
export function syncUserEditsToAgent(tabId: string) {
	const userPath = tabFile(tabId);
	const agentPath = tabAgentFile(tabId);
	if (!existsSync(userPath) || !existsSync(agentPath)) return;
	const currentUserMd = readFileSync(userPath, 'utf-8');
	const lastSynced = getLastSyncedUserMd();
	if (currentUserMd === lastSynced) return;

	const userPatch = createPatch('doc', lastSynced, currentUserMd);
	const currentAgentMd = readFileSync(agentPath, 'utf-8');
	const result = applyPatch(currentAgentMd, userPatch);
	if (typeof result === 'string') {
		writeTextAtomic(agentPath, result);
	}
	setLastSyncedUserMd(currentUserMd);
}

/** Copy the tab's user doc into its agent shadow at render start. Creates
 * any missing shadow parent dirs. */
export function resetAgentDoc(tabId: string) {
	ensureDocWriterDir();
	ensureAgentDirFor(tabId);
	const userPath = tabFile(tabId);
	const agentPath = tabAgentFile(tabId);
	if (existsSync(userPath)) {
		copyFileSync(userPath, agentPath);
	} else {
		writeTextAtomic(agentPath, '');
	}
}

/** Reset shadows for every open tab (from state.json.tabs.order). Returns
 * the list of tab IDs that were reset — these are the only paths the
 * render endpoint's write-restriction hook allows the agent to Edit/Write. */
export function resetAllAgentDocs(): string[] {
	ensureDocWriterDir();
	const ids = getTabsState().order;
	for (const id of ids) resetAgentDoc(id);
	return ids;
}

/** Read every open tab's current user+shadow content. Used at render end to
 * compute which tabs the agent actually edited. */
export function readAllAgentDocs(): Array<{ tabId: string; userMd: string; agentMd: string }> {
	const ids = getTabsState().order;
	return ids.map((tabId) => {
		const userPath = tabFile(tabId);
		const agentPath = tabAgentFile(tabId);
		const userMd = existsSync(userPath) ? readFileSync(userPath, 'utf-8') : '';
		const agentMd = existsSync(agentPath) ? readFileSync(agentPath, 'utf-8') : userMd;
		return { tabId, userMd, agentMd };
	});
}

/** Remove a single tab's shadow. Used when the tab is closed, deleted, or
 * renamed away — not during normal review flow. */
export function clearShadowForTab(tabId: string) {
	const agentPath = tabAgentFile(tabId);
	if (existsSync(agentPath)) unlinkSync(agentPath);
}

/** Accept: keep the shadow as the next render's "last agent view". */
export function acceptAgentDoc(tabId: string) {
	// Shadow intentionally preserved as "what the agent last left behind".
}

/** Reject: keep the rejected proposal shadow so the next diff can show that
 * the user reverted it. */
export function rejectAgentDoc(tabId: string) {
	// Shadow intentionally preserved as "what the agent last proposed".
}

/** Session reset cleanup: discard every open tab's transient agent shadow. */
export function clearAllAgentDocs() {
	for (const tabId of getTabsState().order) {
		clearShadowForTab(tabId);
	}
}
