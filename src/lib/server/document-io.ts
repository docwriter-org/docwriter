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
	isRenderActive,
	getLastSyncedUserMd,
	setLastSyncedUserMd
} from './document-lock';
import {
	getRules,
	setRules,
	getUserEditRegions,
	setUserEditRegions,
	getAgentSettings,
	setAgentSettings,
	type Rule,
	type UserEditRegion,
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
 * Rules / userEditRegions / agentSettings / sessionId also live in
 * state.json. Review baselines + pre-agent snapshots are per-tab Y.Doc
 * state on the client (y-indexeddb).
 */

export interface DocMeta {
	rules: Rule[];
	userEditRegions: UserEditRegion[];
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
		userEditRegions: getUserEditRegions(),
		agentSettings: getAgentSettings()
	};
}

export function writeMeta(meta: Partial<DocMeta>) {
	if (meta.rules !== undefined) setRules(meta.rules);
	if (meta.userEditRegions !== undefined) setUserEditRegions(meta.userEditRegions);
	if (meta.agentSettings !== undefined) setAgentSettings(meta.agentSettings);
}

export function writeUserDoc(tabId: string, markdown: string, meta?: Partial<DocMeta>) {
	ensureDocWriterDir();
	const userPath = tabFile(tabId);
	const agentPath = tabAgentFile(tabId);
	// Ensure the user-facing parent exists (e.g. "drafts/" for
	// "drafts/chapter-1.md").
	mkdirSync(dirname(userPath), { recursive: true });
	const previousUserMd = existsSync(userPath) ? readFileSync(userPath, 'utf-8') : '';
	writeTextAtomic(userPath, markdown);

	// Sync to the per-tab agent shadow ONLY when:
	//   1. No render is currently active (the render endpoint handles sync
	//      lazily via the PreToolUse hook → syncUserEditsToAgent).
	//   2. AND there is no pending agent edit (agent shadow matches the
	//      previous user content). If it differs, there's an unresolved
	//      proposal we must NOT overwrite.
	if (!isRenderActive()) {
		ensureAgentDirFor(tabId);
		const agentExists = existsSync(agentPath);
		if (!agentExists) {
			writeTextAtomic(agentPath, markdown);
		} else {
			const currentAgentMd = readFileSync(agentPath, 'utf-8');
			if (currentAgentMd === previousUserMd) {
				writeTextAtomic(agentPath, markdown);
			}
			// Else: pending agent edit. Leave the shadow alone.
		}
	}
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

/** Accept: clean up this tab's shadow. Client's Y.Doc already carries the
 * merged content. */
export function acceptAgentDoc(tabId: string) {
	setUserEditRegions([]);
	const agentPath = tabAgentFile(tabId);
	if (existsSync(agentPath)) unlinkSync(agentPath);
}

/** Reject: discard this tab's shadow. */
export function rejectAgentDoc(tabId: string) {
	const agentPath = tabAgentFile(tabId);
	if (existsSync(agentPath)) unlinkSync(agentPath);
}

/** Session reset cleanup: discard every open tab's transient agent shadow. */
export function clearAllAgentDocs() {
	for (const tabId of getTabsState().order) {
		rejectAgentDoc(tabId);
	}
}
