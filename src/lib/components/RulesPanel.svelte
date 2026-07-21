<script lang="ts" module>
	/** Draft survives the popover unmounting. Clicking outside the menu
	 * closes (and destroys) this panel on mousedown — before the input's
	 * blur handler can fire — so without this a half-typed rule was lost. */
	let savedDraft = '';
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { X, Play, Lock } from 'lucide-svelte';
	import { rules, pushHistory } from '$lib/stores';
	import type { Rule } from '$lib/types';
	import { isFreezeRule, freezeQuoteFromRule } from '$lib/freeze';

	interface Props {
		onSubmit?: (trigger: string) => void;
	}
	let { onSubmit }: Props = $props();

	let rulesList: Rule[] = $state([]);
	const unsubscribeRules = rules.subscribe((v) => (rulesList = v));

	let newRule = $state(savedDraft);

	onDestroy(() => {
		savedDraft = newRule;
		unsubscribeRules();
	});

	async function saveRules(nextRules: Rule[]) {
		rules.set(nextRules);
		await fetch('/api/document', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ meta: { rules: nextRules } })
		});
	}

	function addRule() {
		if (!newRule.trim()) return;
		const text = newRule.trim();
		const next = [...rulesList, { id: 'r' + Date.now(), text }];
		void saveRules(next);
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Added rule: "${text}"` });
		newRule = '';
		// Wake the agent so it can revise the open files against the new rule
		// without the user having to click "Apply rules" separately.
		onSubmit?.(`The user added a new writing rule: "${text}". Revise the open files to comply.`);
	}

	function applyRules() {
		if (rulesList.length === 0) return;
		const ruleList = rulesList.map((r) => `- ${r.text}`).join('\n');
		// Scope confirmation: the user clicked "Apply rules" from the rules
		// panel without specifying which files. Before editing, ask which
		// tabs to scope the pass to (active only / all open / a chosen
		// subset). Skipping the confirmation is fine ONLY when there's
		// just one tab open — then the answer is unambiguous.
		onSubmit?.(
			`Review files against the following rules and fix violations:\n${ruleList}\n\n` +
				`Scope: I clicked "Apply rules" without specifying which tabs. ` +
				`If more than one tab is open, call AskUserQuestion FIRST to confirm scope ` +
				`(e.g. "Just the active tab", "All open tabs", or let me pick a subset) ` +
				`before making any edits. If only one tab is open, skip the question and proceed.`
		);
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Applying ${rulesList.length} rule${rulesList.length === 1 ? '' : 's'}` });
	}

	function removeRule(id: string) {
		const rule = rulesList.find((r) => r.id === id);
		const next = rulesList.filter((x) => x.id !== id);
		void saveRules(next);
		if (rule) {
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Removed rule: "${rule.text}"` });
		}
	}
</script>

<div class="rules-popover">
	<div class="popover-header">
		<span class="popover-title">Writing rules</span>
	</div>

	<div class="rules-list">
		{#if rulesList.length === 0}
			<div class="rules-empty">No rules yet. Add writing constraints the agent should follow.</div>
		{/if}
		{#each rulesList as rule}
			<div class="rule-row" class:freeze-rule={isFreezeRule(rule)}>
				{#if isFreezeRule(rule)}
					<span class="rule-freeze-icon" title="Frozen passage — agent will not edit this text">
						<Lock size={11} />
					</span>
					<span class="rule-text" title={freezeQuoteFromRule(rule)}>
						Freeze: “{freezeQuoteFromRule(rule)}”
					</span>
				{:else}
					<span class="rule-text">{rule.text}</span>
				{/if}
				<button
					class="rule-remove"
					onclick={() => removeRule(rule.id)}
					title={isFreezeRule(rule) ? 'Unfreeze' : 'Remove rule'}
				>
					<X size={11} />
				</button>
			</div>
		{/each}
	</div>

	<div class="rule-input-row">
		<input
			class="rule-input"
			bind:value={newRule}
			onkeydown={(e) => e.key === 'Enter' && addRule()}
			onblur={addRule}
			placeholder="Add a rule, e.g. 'No passive voice'"
		/>
		<button
			class="rule-add"
			onclick={addRule}
			disabled={!newRule.trim()}
			title="Add rule"
			aria-label="Add rule"
		>+</button>
	</div>

	{#if rulesList.length > 0}
		<button class="apply-rules-btn" onclick={applyRules}>
			<Play size={11} /> Apply rules to document
		</button>
	{/if}
</div>

<style>
	.rules-popover {
		width: 380px;
		padding: 12px;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.popover-header {
		margin-bottom: 10px;
	}
	.popover-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.rules-empty {
		font-size: 12px;
		color: var(--text-faint);
		padding: 8px 0;
		line-height: 1.4;
	}
	.rules-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
		max-height: 420px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.rule-row.freeze-rule {
		background: var(--accent-bg);
	}
	.rule-freeze-icon {
		display: inline-flex;
		color: var(--accent);
		flex-shrink: 0;
	}
	.rule-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px 6px 10px;
		background: var(--bg-surface);
		border-radius: 5px;
	}
	.rule-text {
		flex: 1;
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.4;
	}
	.rule-remove {
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 3px;
		border-radius: 3px;
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}
	.rule-remove:hover {
		color: var(--diff-removed-color);
		background: var(--bg-hover);
	}
	.rule-input-row {
		display: flex;
		align-items: stretch;
		gap: 6px;
	}
	.rule-input {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		font-size: 12.5px;
		border: 1px solid var(--border-light);
		border-radius: 5px;
		padding: 7px 10px;
		outline: none;
		color: var(--text);
		background: var(--bg);
		font-family: inherit;
		transition: border-color 0.15s, box-shadow 0.15s;
	}
	.rule-add {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		font-size: 18px;
		font-weight: 500;
		color: var(--text-faint);
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 5px;
		cursor: pointer;
		font-family: inherit;
		transition: all 0.15s;
	}
	.rule-add:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent-light);
		background: var(--accent-bg);
	}
	.rule-add:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.rule-input::placeholder {
		color: var(--text-faint);
	}
	.rule-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.apply-rules-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		margin-top: 8px;
		padding: 7px 12px;
		border: 1px solid var(--accent-light);
		border-radius: 5px;
		background: var(--accent-bg);
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
		transition: all 0.15s;
	}
	.apply-rules-btn:hover {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
</style>
