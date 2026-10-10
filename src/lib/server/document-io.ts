import { existsSync, readFileSync } from 'fs';
import { tabFile, ensureDocWriterDir } from './document-files';
import {
	getRules,
	setRules,
	getAgentSettings,
	setAgentSettings,
	type Rule,
	type AgentSettings
} from './runtime-state';

/**
 * Server-side document layer. Handles the user-facing file on disk plus
 * the rules / agent-settings metadata backed by SQLite runtime state.
 * Agent edits go through `mcp-doc-tools.ts`, which mutates the live
 * Hocuspocus Y.Doc directly — they don't pass through this module.
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
