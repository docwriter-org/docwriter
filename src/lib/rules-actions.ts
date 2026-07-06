import { rules, pushHistory } from '$lib/stores';
import { apiJson } from '$lib/auth-recovery';
import type { Rule } from '$lib/types';

/**
 * Shared writing-rules actions used by both RulesPanel and RulesPillBar.
 * The two components previously duplicated these bodies verbatim — including
 * the agent-wake trigger and the multi-sentence "Apply rules" scope prompt.
 * Keeping them here once guarantees the emitted strings stay byte-identical
 * across both entry points.
 */

/** Persist the full rules list: update the store immediately (optimistic),
 * then PUT the meta to the server via apiJson so a 401/403 triggers hosted
 * auth recovery. Payload shape is unchanged. */
export async function saveRules(nextRules: Rule[]): Promise<void> {
	rules.set(nextRules);
	await apiJson('/api/document', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ meta: { rules: nextRules } })
	});
}

/** Append a trimmed rule to `current`, persist it, and log the history
 * entry. Returns the new list plus the agent-wake trigger the caller should
 * emit via onSubmit, or null when the text is blank (caller should no-op
 * without clearing its input). */
export function addRule(current: Rule[], rawText: string): { next: Rule[]; trigger: string } | null {
	const text = rawText.trim();
	if (!text) return null;
	const next = [...current, { id: 'r' + Date.now(), text }];
	void saveRules(next);
	pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Added rule: "${text}"` });
	return {
		next,
		trigger: `The user added a new writing rule: "${text}". Revise the open files to comply.`
	};
}

/** Remove the rule with `id` from `current`, persist the filtered list, and
 * log the history entry when the rule existed. Returns the filtered list. */
export function removeRule(current: Rule[], id: string): Rule[] {
	const rule = current.find((r) => r.id === id);
	const next = current.filter((x) => x.id !== id);
	void saveRules(next);
	if (rule) {
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Removed rule: "${rule.text}"` });
	}
	return next;
}

/** Build the "Apply rules" agent prompt for `current`. The scope-confirmation
 * instruction lives here ONCE so both components emit an identical prompt. */
export function applyRulesPrompt(current: Rule[]): string {
	const ruleList = current.map((r) => `- ${r.text}`).join('\n');
	return (
		`Review files against the following rules and fix violations:\n${ruleList}\n\n` +
		`Scope: I clicked "Apply rules" without specifying which tabs. ` +
		`If more than one tab is open, call AskUserQuestion FIRST to confirm scope ` +
		`(e.g. "Just the active tab", "All open tabs", or let me pick a subset) ` +
		`before making any edits. If only one tab is open, skip the question and proceed.`
	);
}

/** Emit the "Apply rules" prompt via `onSubmit` and log the history entry.
 * No-op when there are no rules (matches the original components). */
export function applyRules(current: Rule[], onSubmit?: (trigger: string) => void): void {
	if (current.length === 0) return;
	onSubmit?.(applyRulesPrompt(current));
	pushHistory({
		type: 'user_action',
		timestamp: Date.now(),
		description: `Applying ${current.length} rule${current.length === 1 ? '' : 's'}`
	});
}
