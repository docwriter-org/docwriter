/**
 * Project-scoped shell hooks. Stored at `.docwriter/hooks.json` in the
 * workspace. Each hook binds a shell command to an Agent SDK event
 * (PostToolUse, PreToolUse, Stop) and optionally matches on the tool name
 * or file path.
 *
 * Why our own file rather than `.claude/settings.json`: if we store hooks
 * where the SDK auto-loads them, registering them again via query options
 * would double-execute. Keeping a separate file lets us own the execution
 * (for history events + streaming) without fighting the SDK.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DOCWRITER_DIR, ensureDocWriterDir } from './document-files';
import { writeJsonAtomic } from './file-utils';
import { dbReplaceHooks } from './db-writes';

/** Hook events we surface in the UI. Subset of the SDK's full list (see
 * https://code.claude.com/docs/en/agent-sdk/hooks) — we omit the niche ones
 * (PreCompact, PermissionRequest, TeammateIdle, WorktreeCreate/Remove,
 * ConfigChange, Setup, TaskCompleted) that aren't useful for shell-command
 * automation. Add more here as users ask. */
export type HookEvent =
	| 'PreToolUse'
	| 'PostToolUse'
	| 'PostToolUseFailure'
	| 'UserPromptSubmit'
	| 'Stop'
	| 'SubagentStop'
	| 'SessionStart'
	| 'SessionEnd'
	| 'Notification';

export const HOOK_EVENTS: readonly HookEvent[] = [
	'PreToolUse',
	'PostToolUse',
	'PostToolUseFailure',
	'UserPromptSubmit',
	'Stop',
	'SubagentStop',
	'SessionStart',
	'SessionEnd',
	'Notification'
] as const;

export interface Hook {
	id: string;
	event: HookEvent;
	/** Regex pattern matched against the tool name for Pre/PostToolUse (e.g.
	 * "Edit|Write" to run after any file mutation). Empty/absent = match all. */
	matcher?: string;
	/** Shell command to run. `{{file}}` is replaced with the edited file path
	 * (PreToolUse / PostToolUse only); `{{tool}}` with the tool name. */
	command: string;
	/** Disabled hooks are still listed in the UI but don't execute. */
	enabled?: boolean;
}

export interface HooksConfig {
	hooks: Hook[];
}

const HOOKS_FILE = join(DOCWRITER_DIR, 'hooks.json');

export function readHooks(): HooksConfig {
	ensureDocWriterDir();
	if (!existsSync(HOOKS_FILE)) return { hooks: [] };
	try {
		const raw = JSON.parse(readFileSync(HOOKS_FILE, 'utf-8'));
		if (!raw || !Array.isArray(raw.hooks)) return { hooks: [] };
		return { hooks: raw.hooks as Hook[] };
	} catch {
		return { hooks: [] };
	}
}

export function writeHooks(cfg: HooksConfig) {
	ensureDocWriterDir();
	writeJsonAtomic(HOOKS_FILE, cfg);
	dbReplaceHooks(cfg.hooks);
}

/** Substitute template placeholders in a hook command. */
export function resolveCommand(
	command: string,
	vars: { tool?: string; file?: string }
): string {
	return command
		.replaceAll('{{tool}}', vars.tool ?? '')
		.replaceAll('{{file}}', vars.file ?? '');
}
