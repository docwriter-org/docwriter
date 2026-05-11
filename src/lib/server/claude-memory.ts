/**
 * Sync the user's writing rules into `.claude/CLAUDE.md` so the SDK
 * picks them up as project memory. CLAUDE.md is auto-reloaded after
 * compaction (per the Agent SDK docs), so rules survive context
 * resets without depending on per-render injection alone.
 *
 * Format: a marker-bracketed managed block. Anything OUTSIDE the
 * markers is left intact, so a user (or another tool) can freely
 * add content to `.claude/CLAUDE.md` and only the docwriter section
 * is overwritten on each sync.
 *
 * Source of truth: the SQLite `rules` table, written by `setRules()`
 * in `runtime-state.ts`. This sync is called from inside `setRules`
 * so every rule mutation propagates to CLAUDE.md, and once at server
 * startup as a safety net for any prior crash that landed the DB
 * write but not the file write.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { DOCWRITER_DIR } from './document-files';
import { writeTextAtomic } from './file-utils';
import type { Rule } from './runtime-state';

const CLAUDE_MEMORY_PATH = join(dirname(DOCWRITER_DIR), '.claude', 'CLAUDE.md');
const BEGIN_MARKER = '<!-- BEGIN DOCWRITER RULES — managed by docwriter; edit via the rules panel -->';
const END_MARKER = '<!-- END DOCWRITER RULES -->';

/** Produce the managed-block content for the rules array. */
function renderManagedBlock(rules: Rule[]): string {
	const lines: string[] = [];
	lines.push(BEGIN_MARKER);
	lines.push('');
	lines.push('# Writing rules');
	lines.push('');
	lines.push(
		'These are the user\'s standing writing preferences for this workspace. They are auto-synced from the docwriter rules panel — do not edit by hand (edits will be overwritten on the next rule change).'
	);
	lines.push('');
	if (rules.length === 0) {
		lines.push('_(no rules defined yet)_');
	} else {
		for (const r of rules) {
			lines.push(`- ${r.text}`);
		}
	}
	lines.push('');
	lines.push(END_MARKER);
	return lines.join('\n');
}

/** Replace the managed block within `existing`, preserving any content
 * outside the markers. If no markers are found, appends the block to
 * the end (separated by a blank line if `existing` is non-empty). */
function spliceManagedBlock(existing: string, block: string): string {
	const begin = existing.indexOf(BEGIN_MARKER);
	const end = existing.indexOf(END_MARKER);
	if (begin >= 0 && end > begin) {
		const before = existing.slice(0, begin);
		const after = existing.slice(end + END_MARKER.length);
		return (before + block + after).trimEnd() + '\n';
	}
	// No existing block: append to the file. Leading newline so we don't
	// glue onto whatever the user already had.
	if (existing.trim().length === 0) {
		return block.trimEnd() + '\n';
	}
	return existing.trimEnd() + '\n\n' + block.trimEnd() + '\n';
}

export function syncRulesToClaudeMemory(rules: Rule[]): void {
	try {
		const block = renderManagedBlock(rules);
		let existing = '';
		if (existsSync(CLAUDE_MEMORY_PATH)) {
			existing = readFileSync(CLAUDE_MEMORY_PATH, 'utf-8');
		}
		const next = spliceManagedBlock(existing, block);
		if (next === existing) return; // No-op: managed block already matches.
		mkdirSync(dirname(CLAUDE_MEMORY_PATH), { recursive: true });
		writeTextAtomic(CLAUDE_MEMORY_PATH, next);
	} catch (err) {
		// Sync is best-effort: per-render injection still surfaces rules
		// to the agent even if this file write fails. Log and move on so
		// a permission or filesystem hiccup doesn't break rule editing.
		console.error('[docwriter] syncRulesToClaudeMemory failed:', err);
	}
}
