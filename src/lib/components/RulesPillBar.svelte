<script lang="ts">
	import { X, Plus, Play, ChevronDown, BookOpen } from 'lucide-svelte';
	import { rules, pushHistory } from '$lib/stores';
	import type { Rule } from '$lib/types';

	interface Props {
		onSubmit?: (trigger: string) => void;
	}
	let { onSubmit }: Props = $props();

	let rulesList: Rule[] = $state([]);
	rules.subscribe((v) => (rulesList = v));

	let popoverOpen = $state(false);
	let newRule = $state('');
	let inputEl: HTMLInputElement | undefined = $state();
	let anchorEl: HTMLDivElement | undefined = $state();

	const MAX_VISIBLE_PILLS = 3;
	let visibleRules = $derived(rulesList.slice(0, MAX_VISIBLE_PILLS));
	let overflowCount = $derived(Math.max(0, rulesList.length - MAX_VISIBLE_PILLS));

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
		requestAnimationFrame(() => inputEl?.focus());
		onSubmit?.(`The user added a new writing rule: "${text}". Revise the open files to comply.`);
	}

	function removeRule(id: string) {
		const rule = rulesList.find((r) => r.id === id);
		const next = rulesList.filter((x) => x.id !== id);
		void saveRules(next);
		if (rule) {
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Removed rule: "${rule.text}"` });
		}
	}

	function togglePopover() {
		popoverOpen = !popoverOpen;
		if (popoverOpen) {
			requestAnimationFrame(() => inputEl?.focus());
		} else {
			newRule = '';
		}
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') addRule();
		if (e.key === 'Escape') { popoverOpen = false; newRule = ''; }
	}

	function handlePopoverPointerdown(e: PointerEvent) {
		e.stopPropagation();
	}

	function handleBackdropClick() {
		popoverOpen = false;
		newRule = '';
	}

	function applyRules() {
		if (rulesList.length === 0) return;
		const ruleList = rulesList.map((r) => `- ${r.text}`).join('\n');
		onSubmit?.(
			`Review files against the following rules and fix violations:\n${ruleList}\n\n` +
				`Scope: I clicked "Apply rules" without specifying which tabs. ` +
				`If more than one tab is open, call AskUserQuestion FIRST to confirm scope ` +
				`(e.g. "Just the active tab", "All open tabs", or let me pick a subset) ` +
				`before making any edits. If only one tab is open, skip the question and proceed.`
		);
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Applying ${rulesList.length} rule${rulesList.length === 1 ? '' : 's'}` });
	}
</script>

<div class="rules-pill-bar" bind:this={anchorEl}>
	<!-- Inline pills for the first few rules -->
	{#each visibleRules as rule (rule.id)}
		<span class="rule-pill">
			<span class="pill-text">{rule.text}</span>
			<button
				class="pill-remove"
				onclick={() => removeRule(rule.id)}
				title="Remove rule"
				aria-label="Remove rule: {rule.text}"
			>
				<X size={9} strokeWidth={2.5} />
			</button>
		</span>
	{/each}

	<!-- Overflow badge -->
	{#if overflowCount > 0}
		<button class="overflow-badge" onclick={togglePopover} title="Show all rules">
			+{overflowCount} more
		</button>
	{/if}

	<!-- Add / manage button -->
	<button
		class="add-rule-btn"
		class:active={popoverOpen}
		onclick={togglePopover}
		title={rulesList.length > 0 ? 'Manage rules' : 'Add a writing rule'}
	>
		<Plus size={11} strokeWidth={2} />
		{#if rulesList.length === 0}
			<span>Add rule</span>
		{/if}
	</button>

	<!-- Apply button -->
	{#if rulesList.length > 0}
		<button class="apply-btn" onclick={applyRules} title="Apply rules to document">
			<Play size={9} strokeWidth={2.5} />
		</button>
	{/if}
</div>

<!-- Popover (portal-style, outside the flex row) -->
{#if popoverOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="popover-backdrop" onclick={handleBackdropClick}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="rules-popover" onpointerdown={handlePopoverPointerdown} onclick={(e) => e.stopPropagation()}>
			<div class="popover-header">
				<BookOpen size={13} strokeWidth={1.8} />
				<span>Writing rules</span>
			</div>

			{#if rulesList.length > 0}
				<div class="popover-rules-list">
					{#each rulesList as rule (rule.id)}
						<div class="popover-rule-row">
							<span class="popover-rule-text">{rule.text}</span>
							<button
								class="popover-rule-remove"
								onclick={() => removeRule(rule.id)}
								title="Remove"
							>
								<X size={11} strokeWidth={2} />
							</button>
						</div>
					{/each}
				</div>
			{:else}
				<div class="popover-empty">No rules yet. Rules tell the AI what constraints to follow.</div>
			{/if}

			<div class="popover-input-row">
				<input
					bind:this={inputEl}
					class="popover-input"
					bind:value={newRule}
					onkeydown={handleInputKeydown}
					placeholder="Add a rule, e.g. 'No passive voice'"
				/>
				<button
					class="popover-add-btn"
					onclick={addRule}
					disabled={!newRule.trim()}
				>Add</button>
			</div>

			{#if rulesList.length > 0}
				<button class="popover-apply-btn" onclick={applyRules}>
					<Play size={11} strokeWidth={2} />
					Apply rules to document
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.rules-pill-bar {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 5px;
		min-height: 0;
		overflow: hidden;
	}

	/* ── Inline pills ── */
	.rule-pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px 2px 8px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
		font-size: 11.5px;
		color: var(--text-secondary);
		line-height: 1.2;
		max-width: 200px;
		white-space: nowrap;
		flex-shrink: 0;
		transition: background 0.1s, border-color 0.1s;
	}
	.rule-pill:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.pill-text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		height: 13px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.1s, color 0.1s, background 0.1s;
	}
	.rule-pill:hover .pill-remove { opacity: 1; }
	.pill-remove:hover {
		color: white;
		background: color-mix(in srgb, var(--diff-removed-color, #ef4444) 80%, transparent);
	}

	/* ── Overflow badge ── */
	.overflow-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 7px;
		border-radius: 4px;
		border: none;
		background: color-mix(in srgb, var(--text-faint) 12%, transparent);
		color: var(--text-faint);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
		flex-shrink: 0;
		transition: background 0.1s, color 0.1s;
	}
	.overflow-badge:hover {
		background: color-mix(in srgb, var(--text-faint) 20%, transparent);
		color: var(--text-secondary);
	}

	/* ── Add button ── */
	.add-rule-btn {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px 5px;
		border-radius: 4px;
		border: 1px dashed color-mix(in srgb, var(--text-faint) 35%, transparent);
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		font-size: 11.5px;
		cursor: pointer;
		transition: all 0.12s;
		line-height: 1.2;
		flex-shrink: 0;
	}
	.add-rule-btn:hover, .add-rule-btn.active {
		color: var(--accent);
		border-color: var(--accent);
		border-style: solid;
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	/* ── Apply button (inline) ── */
	.apply-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border-radius: 4px;
		border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.12s;
	}
	.apply-btn:hover {
		color: var(--accent);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	/* ── Popover ── */
	.popover-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
	}
	.rules-popover {
		position: fixed;
		top: 80px;
		left: 16px;
		width: 340px;
		max-height: 400px;
		display: flex;
		flex-direction: column;
		padding: 12px;
		background: var(--bg-elevated, var(--bg));
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
		z-index: 201;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.popover-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 10px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.popover-empty {
		font-size: 12px;
		color: var(--text-faint);
		padding: 6px 0 10px;
		line-height: 1.4;
	}
	.popover-rules-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-bottom: 10px;
		max-height: 220px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.popover-rule-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 5px;
		background: var(--bg-surface);
	}
	.popover-rule-row:hover {
		background: var(--bg-hover);
	}
	.popover-rule-text {
		flex: 1;
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.4;
		min-width: 0;
		overflow-wrap: break-word;
	}
	.popover-rule-remove {
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 2px;
		border-radius: 3px;
		display: flex;
		align-items: center;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.popover-rule-row:hover .popover-rule-remove { opacity: 1; }
	.popover-rule-remove:hover {
		color: var(--diff-removed-color, #ef4444);
		background: var(--bg-hover);
	}
	.popover-input-row {
		display: flex;
		gap: 6px;
	}
	.popover-input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 12.5px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 6px 10px;
		outline: none;
		color: var(--text);
		background: var(--bg);
		transition: border-color 0.15s, box-shadow 0.15s;
	}
	.popover-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-bg);
	}
	.popover-input::placeholder { color: var(--text-faint); }
	.popover-add-btn {
		padding: 6px 14px;
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: white;
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.1s;
	}
	.popover-add-btn:disabled { opacity: 0.35; cursor: default; }
	.popover-add-btn:hover:not(:disabled) { opacity: 0.85; }
	.popover-apply-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		margin-top: 8px;
		padding: 7px 12px;
		border: 1px solid var(--accent-light);
		border-radius: 6px;
		background: var(--accent-bg);
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
		transition: all 0.15s;
	}
	.popover-apply-btn:hover {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
</style>
