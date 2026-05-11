import { existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { writeTextAtomic } from './file-utils';
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

export function writeUserDoc(tabId: string, markdown: string, meta?: Partial<DocMeta>) {
	ensureDocWriterDir();
	const userPath = tabFile(tabId);
	// Ensure the user-facing parent exists (e.g. "drafts/" for
	// "drafts/chapter-1.md").
	mkdirSync(dirname(userPath), { recursive: true });
	writeTextAtomic(userPath, markdown);
	if (meta) writeMeta(meta);
}
