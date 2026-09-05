<script lang="ts">
	import { X, Plus, Play, BookOpen } from 'lucide-svelte';
	import { rules, pushHistory } from '$lib/stores';
	import { isModEnter } from '$lib/keyboard';
	import type { Rule } from '$lib/types';

	interface Props {
		onSubmit?: (trigger: string) => void;
	}
	let { onSubmit }: Props = $props();

	let rulesList: Rule[] = $state([]);
	rules.subscribe((v) => (rulesList = v));

	let popoverOpen = $state(false);
	let popoverMode: 'manage' | 'edit' = $state('manage');
	let newRule = $state('');
	let editingRuleId: string | null = $state(null);
	let draftRule = $state('');
	let addingExampleFor: string | null = $state(null);
	let exampleDraft = $state('');
	let inputEl: HTMLInputElement | undefined = $state();
	let editInputEl: HTMLTextAreaElement | undefined = $state();
	let anchorEl: HTMLDivElement | undefined = $state();
	let popoverEl: HTMLDivElement | undefined = $state();

	// Non-modal close behavior. Outside mousedown closes the popover only
	// when nothing is in progress: a non-empty draft (or edit-in-place)
	// keeps it open so the user can scroll and click around the document
	// while composing a rule that references it. Escape and the toggle
	// button always close.
	$effect(() => {
		if (!popoverOpen) return;
		function onDown(e: MouseEvent) {
			const target = e.target as Node | null;
			if (!target) return;
			if (popoverEl?.contains(target) || anchorEl?.contains(target)) return;
			if (popoverMode === 'edit' || newRule.trim() || addingExampleFor !== null) return;
			closePopover();
		}
		function onKey(e: KeyboardEvent) {
			// Edit mode's textarea has its own Escape handling (cancel edit).
			if (e.key === 'Escape' && popoverMode === 'manage') closePopover();
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

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
		onSubmit?.(`I added a new writing rule: "${text}". Revise the open files to comply.`);
	}

	function removeRule(id: string) {
		const rule = rulesList.find((r) => r.id === id);
		const next = rulesList.filter((x) => x.id !== id);
		void saveRules(next);
		if (editingRuleId === id) closePopover();
		if (rule) {
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Removed rule: "${rule.text}"` });
		}
	}

	/** Attach a violation example to a rule. Examples ride along in the
	 * rule prompt as few-shot negatives, so the best ones are passages
	 * lifted verbatim from this document. */
	function saveExample(ruleId: string) {
		const text = exampleDraft.trim();
		if (!text) return;
		const rule = rulesList.find((r) => r.id === ruleId);
		const next = rulesList.map((r) =>
			r.id === ruleId ? { ...r, examples: [...(r.examples ?? []), { violation: text }] } : r
		);
		void saveRules(next);
		if (rule) {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Added violation example to rule "${rule.text}"`
			});
		}
		addingExampleFor = null;
		exampleDraft = '';
	}

	function removeExample(ruleId: string, index: number) {
		const next = rulesList.map((r) => {
			if (r.id !== ruleId) return r;
			const examples = (r.examples ?? []).filter((_, i) => i !== index);
			return { ...r, examples: examples.length > 0 ? examples : undefined };
		});
		void saveRules(next);
	}

	function startEditingRule(id: string) {
		const rule = rulesList.find((r) => r.id === id);
		if (!rule) return;
		popoverOpen = true;
		popoverMode = 'edit';
		editingRuleId = id;
		draftRule = rule.text;
		requestAnimationFrame(() => {
			editInputEl?.focus();
			editInputEl?.select();
		});
	}

	function cancelEdit() {
		editingRuleId = null;
		draftRule = '';
	}

	function saveEditedRule(id: string) {
		const text = draftRule.trim();
		const rule = rulesList.find((r) => r.id === id);
		if (!rule || !text) return;
		if (text === rule.text) {
			if (popoverMode === 'edit') closePopover();
			else cancelEdit();
			return;
		}
		const next = rulesList.map((r) => (r.id === id ? { ...r, text } : r));
		void saveRules(next);
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Edited rule: "${rule.text}" to "${text}"` });
		if (popoverMode === 'edit') closePopover();
		else cancelEdit();
	}

	function openManagePopover() {
		popoverOpen = true;
		popoverMode = 'manage';
		cancelEdit();
		requestAnimationFrame(() => inputEl?.focus());
	}

	function toggleManagePopover() {
		if (popoverOpen && popoverMode === 'manage') {
			closePopover();
			return;
		}
		openManagePopover();
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') addRule();
		if (e.key === 'Escape') closePopover();
	}

	function handleEditKeydown(e: KeyboardEvent, id: string) {
		if (isModEnter(e)) {
			e.preventDefault();
			saveEditedRule(id);
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			if (popoverMode === 'edit') closePopover();
			else cancelEdit();
		}
	}

	function closePopover() {
		popoverOpen = false;
		popoverMode = 'manage';
		// Deliberately keep `newRule`: clicking out (backdrop / Escape)
		// shouldn't discard a half-typed rule — it's restored on reopen.
		cancelEdit();
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
			<button
				type="button"
				class="pill-open"
				onclick={() => startEditingRule(rule.id)}
				title="Edit rule: {rule.text}"
				aria-label="Edit rule: {rule.text}"
			>
				<span class="pill-text">{rule.text}</span>
			</button>
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
		<button class="overflow-badge" onclick={openManagePopover} title="Show all rules">
			+{overflowCount} more
		</button>
	{/if}

	<!-- Add / manage button -->
	<button
		class="add-rule-btn"
		class:active={popoverOpen && popoverMode === 'manage'}
		onclick={toggleManagePopover}
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

<!-- Popover (portal-style, outside the flex row). Deliberately NON-modal:
     the old full-viewport backdrop swallowed wheel events, so the document
     couldn't be scrolled while composing a rule. Outside interaction is
     handled by a document-level mousedown listener instead (see $effect),
     which never blocks scrolling. -->
{#if popoverOpen}
	<div class="rules-popover" bind:this={popoverEl}>
		<div class="popover-header">
			<BookOpen size={13} strokeWidth={1.8} />
			<span>{popoverMode === 'edit' ? 'Edit rule' : 'Writing rules'}</span>
		</div>

			{#if popoverMode === 'edit'}
				{@const editingRule = rulesList.find((rule) => rule.id === editingRuleId)}
				{#if editingRule}
					<div class="popover-rule-editor">
						<textarea
							bind:this={editInputEl}
							class="popover-rule-edit-input"
							bind:value={draftRule}
							onkeydown={(e) => handleEditKeydown(e, editingRule.id)}
							rows="4"
							aria-label="Edit rule"
						></textarea>
						<div class="popover-rule-actions">
							<button
								type="button"
								class="popover-rule-cancel"
								onclick={closePopover}
							>Cancel</button>
							<button
								type="button"
								class="popover-rule-save"
								onclick={() => saveEditedRule(editingRule.id)}
								disabled={!draftRule.trim()}
							>Save</button>
						</div>
					</div>
				{/if}
			{:else if rulesList.length > 0}
				<div class="popover-rules-list">
					{#each rulesList as rule (rule.id)}
						<div class="popover-rule-item">
							<div class="popover-rule-row">
								<button
									type="button"
									class="popover-rule-edit-body"
									onclick={() => startEditingRule(rule.id)}
									title="Edit rule"
								>
									<span class="popover-rule-text">{rule.text}</span>
								</button>
								<button
									class="popover-rule-remove"
									onclick={() => removeRule(rule.id)}
									title="Remove"
								>
									<X size={11} strokeWidth={2} />
								</button>
							</div>
							{#if rule.examples && rule.examples.length > 0}
								<div class="rule-examples">
									{#each rule.examples as ex, i (i)}
										<div class="rule-example">
											<span class="rule-example-text" title={ex.violation}>“{ex.violation}”</span>
											<button
												class="rule-example-remove"
												onclick={() => removeExample(rule.id, i)}
												title="Remove example"
											>
												<X size={9} strokeWidth={2.5} />
											</button>
										</div>
									{/each}
								</div>
							{/if}
							{#if addingExampleFor === rule.id}
								<!-- svelte-ignore a11y_autofocus -->
								<textarea
									class="rule-example-input"
									bind:value={exampleDraft}
									rows="2"
									autofocus
									placeholder="Paste a passage that breaks this rule…"
									onkeydown={(e) => {
										if (e.key === 'Enter' && !e.shiftKey) {
											e.preventDefault();
											saveExample(rule.id);
										}
										if (e.key === 'Escape') {
											e.stopPropagation();
											addingExampleFor = null;
											exampleDraft = '';
										}
									}}
								></textarea>
							{:else}
								<button
									class="rule-example-add"
									onclick={() => {
										addingExampleFor = rule.id;
										exampleDraft = '';
									}}
									title="Attach a passage that violates this rule — shown to the agent as a concrete example"
								>+ example violation</button>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="popover-empty">No rules yet. Rules tell the AI what constraints to follow.</div>
			{/if}

			{#if popoverMode === 'manage'}
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
			{/if}
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
		padding: 0 4px 0 8px;
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
	.pill-open {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		padding: 2px 0;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		line-height: inherit;
		cursor: pointer;
	}
	.pill-text {
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
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
		align-items: flex-start;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 5px;
		background: var(--bg-surface);
	}
	.popover-rule-row:hover {
		background: var(--bg-hover);
	}
	.popover-rule-edit-body {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: transparent;
		text-align: left;
		font: inherit;
		cursor: text;
	}
	.popover-rule-text {
		flex: 1;
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.4;
		min-width: 0;
		overflow-wrap: break-word;
	}
	.popover-rule-item {
		display: flex;
		flex-direction: column;
	}
	/* ── Violation examples under a rule ── */
	.rule-examples {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 1px 0 2px;
		padding-left: 14px;
	}
	.rule-example {
		display: flex;
		align-items: flex-start;
		gap: 5px;
	}
	.rule-example-text {
		flex: 1;
		min-width: 0;
		font-size: 11.5px;
		font-style: italic;
		color: var(--text-faint);
		line-height: 1.35;
		border-left: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
		padding-left: 6px;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.rule-example-remove {
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
	}
	.rule-example:hover .rule-example-remove {
		opacity: 1;
	}
	.rule-example-remove:hover {
		color: #ef4444;
		background: var(--bg-hover);
	}
	.rule-example-add {
		align-self: flex-start;
		margin: 0 0 4px 14px;
		padding: 1px 4px;
		border: none;
		border-radius: 3px;
		background: none;
		font: inherit;
		font-size: 10.5px;
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0.65;
	}
	.rule-example-add:hover {
		opacity: 1;
		color: var(--accent);
		background: var(--bg-hover);
	}
	.rule-example-input {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		min-height: 46px;
		max-height: 120px;
		margin: 2px 0 6px;
		font: inherit;
		font-size: 11.5px;
		line-height: 1.4;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 6px 8px;
		outline: none;
		color: var(--text);
		background: var(--bg);
	}
	.rule-example-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-bg);
	}
	.popover-rule-editor {
		display: flex;
		flex-direction: column;
		gap: 7px;
		width: 100%;
		min-width: 0;
	}
	.popover-rule-edit-input {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		min-height: 86px;
		max-height: 180px;
		font: inherit;
		font-size: 12.5px;
		line-height: 1.4;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 7px 9px;
		outline: none;
		color: var(--text);
		background: var(--bg);
	}
	.popover-rule-edit-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-bg);
	}
	.popover-rule-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}
	.popover-rule-cancel,
	.popover-rule-save {
		padding: 5px 10px;
		border-radius: 5px;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.popover-rule-cancel {
		border: 1px solid var(--border-light);
		background: var(--bg);
		color: var(--text-secondary);
	}
	.popover-rule-cancel:hover {
		background: var(--bg-hover);
	}
	.popover-rule-save {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: white;
		font-weight: 500;
	}
	.popover-rule-save:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.popover-rule-save:hover:not(:disabled) {
		opacity: 0.85;
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
