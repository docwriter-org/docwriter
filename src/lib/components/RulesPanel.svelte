<script lang="ts">
	import { X } from 'lucide-svelte';
	import { rules, pushHistory, pushDocumentOp } from '$lib/stores';

	let rulesList: typeof $rules = $state([]);
	rules.subscribe((v) => (rulesList = v));

	let newRule = $state('');

	function addRule() {
		if (!newRule.trim()) return;
		const text = newRule.trim();
		let nextRules = rulesList;
		rules.update((r) => {
			nextRules = [...r, { id: 'r' + Date.now(), text }];
			return nextRules;
		});
		pushDocumentOp({
			type: 'replace_rules',
			rules: nextRules
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Added rule: "${text}"` });
		newRule = '';
	}

	function removeRule(id: string) {
		const rule = rulesList.find((r) => r.id === id);
		let nextRules = rulesList;
		rules.update((r) => {
			nextRules = r.filter((x) => x.id !== id);
			return nextRules;
		});
		pushDocumentOp({
			type: 'replace_rules',
			rules: nextRules
		});
		if (rule) {
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Removed rule: "${rule.text}"` });
		}
	}
</script>

<div class="rules-popover">
	<div class="rules-header">Writing Rules</div>
	{#if rulesList.length === 0}
		<div class="rules-empty">No rules yet. Add constraints the agent must follow.</div>
	{/if}
	<div class="rules-list">
		{#each rulesList as rule}
			<div class="rule-row">
				<span class="rule-text">{rule.text}</span>
				<button class="rule-remove" onclick={() => removeRule(rule.id)}>
					<X size={12} />
				</button>
			</div>
		{/each}
	</div>
	<div class="rule-add">
		<input
			class="rule-input"
			bind:value={newRule}
			onkeydown={(e) => e.key === 'Enter' && addRule()}
			placeholder="Add a rule, e.g. 'No passive voice'"
		/>
	</div>
</div>

<style>
	.rules-popover {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		width: 320px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.12);
		padding: 12px;
		z-index: 100;
	}
	.rules-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 8px;
	}
	.rules-empty {
		font-size: 13px;
		color: var(--text-faint);
		padding: 8px 0;
		line-height: 1.4;
	}
	.rules-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
	}
	.rule-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: var(--bg-surface);
		border-radius: 6px;
		border: 1px solid var(--border-light);
	}
	.rule-text {
		flex: 1;
		font-size: 13px;
		color: var(--text);
	}
	.rule-remove {
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 2px;
		border-radius: 3px;
		display: flex;
		align-items: center;
	}
	.rule-remove:hover {
		color: var(--diff-removed-color);
		background: var(--bg-hover);
	}
	.rule-input {
		width: 100%;
		font-size: 13px;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
		outline: none;
		color: var(--text);
		background: var(--bg);
		font-family: inherit;
	}
	.rule-input:focus {
		border-color: var(--accent);
	}
	.rule-add {
		margin-top: 4px;
	}
</style>
