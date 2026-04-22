<script lang="ts">
	import { Check, HelpCircle, Sparkles, X } from 'lucide-svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		pendingUserQuestions,
		pendingPlanProposals,
		type PendingUserQuestion,
		type PendingPlanProposal
	} from '$lib/stores';

	interface Props {
		onAnswerQuestion: (id: string, answers: string[]) => void;
		onRunPlan: (id: string) => void;
		onDismissPlan: (id: string) => void;
		onRejectPlan: (id: string, feedback: string) => void;
	}
	let { onAnswerQuestion, onRunPlan, onDismissPlan, onRejectPlan }: Props = $props();

	let questions = $state<PendingUserQuestion[]>([]);
	pendingUserQuestions.subscribe((v) => (questions = v));

	let plans = $state<PendingPlanProposal[]>([]);
	pendingPlanProposals.subscribe((v) => (plans = v));

	// Only the first of each kind is shown. Questions take priority — the
	// agent is literally paused on that tool call, so resolve before
	// surfacing anything else.
	let activeQuestion = $derived(questions[0] ?? null);
	let activePlan = $derived(!activeQuestion ? (plans[0] ?? null) : null);
	let visible = $derived(activeQuestion !== null || activePlan !== null);

	let multiSelections = $state<Record<string, Set<string>>>({});

	// "Reject with feedback" flow for plan cards. Null = footer shows the
	// primary action buttons; non-null = textarea is open for this plan id.
	let rejectingPlanId = $state<string | null>(null);
	let rejectFeedback = $state('');
	let rejectTextareaEl: HTMLTextAreaElement | null = $state(null);

	async function openRejectFeedback(planId: string) {
		rejectingPlanId = planId;
		rejectFeedback = '';
		await Promise.resolve();
		requestAnimationFrame(() => rejectTextareaEl?.focus());
	}

	function closeRejectFeedback() {
		rejectingPlanId = null;
		rejectFeedback = '';
	}

	function submitRejectFeedback(planId: string) {
		const feedback = rejectFeedback.trim();
		if (!feedback) return;
		onRejectPlan(planId, feedback);
		closeRejectFeedback();
	}

	function onRejectKeydown(e: KeyboardEvent, planId: string) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeRejectFeedback();
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			submitRejectFeedback(planId);
		}
	}

	function toggleMultiSelection(cardId: string, qIdx: number, label: string) {
		const key = `${cardId}:${qIdx}`;
		const current = multiSelections[key] ?? new Set<string>();
		const next = new Set(current);
		if (next.has(label)) next.delete(label);
		else next.add(label);
		multiSelections = { ...multiSelections, [key]: next };
	}

	function isMultiSelected(cardId: string, qIdx: number, label: string): boolean {
		return multiSelections[`${cardId}:${qIdx}`]?.has(label) ?? false;
	}

	function submitMultiAnswer(card: PendingUserQuestion) {
		const answers: string[] = [];
		for (let i = 0; i < card.questions.length; i++) {
			const sel = multiSelections[`${card.id}:${i}`];
			if (sel && sel.size > 0) {
				for (const label of sel) answers.push(label);
			}
		}
		if (answers.length === 0) return;
		const next = { ...multiSelections };
		for (let i = 0; i < card.questions.length; i++) delete next[`${card.id}:${i}`];
		multiSelections = next;
		onAnswerQuestion(card.id, answers);
	}

	function pickSingle(card: PendingUserQuestion, label: string) {
		onAnswerQuestion(card.id, [label]);
	}

	// Render the plan as minimally-formatted markdown-ish HTML. Full
	// markdown rendering isn't wired here yet; the plan text tends to be
	// short-form prose + lists, so preserving paragraph breaks and bold
	// is enough to make it readable.
	function renderPlanHtml(text: string): string {
		const esc = (s: string) =>
			s
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
		const lines = text.split('\n');
		const out: string[] = [];
		let inList = false;
		for (const raw of lines) {
			const line = raw.trimEnd();
			const listMatch = line.match(/^\s*([-*])\s+(.*)$/);
			if (listMatch) {
				if (!inList) {
					out.push('<ul>');
					inList = true;
				}
				out.push(`<li>${formatInline(esc(listMatch[2]))}</li>`);
				continue;
			}
			if (inList) {
				out.push('</ul>');
				inList = false;
			}
			const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
			if (headingMatch) {
				const level = Math.min(headingMatch[1].length + 2, 6);
				out.push(`<h${level}>${formatInline(esc(headingMatch[2]))}</h${level}>`);
				continue;
			}
			if (!line.trim()) {
				out.push('');
				continue;
			}
			out.push(`<p>${formatInline(esc(line))}</p>`);
		}
		if (inList) out.push('</ul>');
		return out.join('\n');
	}

	function formatInline(s: string): string {
		return s
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/`([^`]+)`/g, '<code>$1</code>');
	}
</script>

{#if visible}
	<div class="agent-modal-backdrop" transition:fade={{ duration: 140 }}>
		<div
			class="agent-modal"
			role="dialog"
			aria-modal="true"
			transition:fly={{ y: 16, duration: 220, easing: cubicOut }}
		>
			{#if activeQuestion}
				{@const card = activeQuestion}
				<div class="modal-header">
					<HelpCircle size={14} />
					<span>Question from agent</span>
				</div>
				<div class="modal-body">
					{#each card.questions as q, qIdx}
						{#if card.questions.length > 1 && q.header}
							<div class="question-header">{q.header}</div>
						{/if}
						<div class="question-text">{q.question}</div>
						<div class="question-options">
							{#each q.options as opt}
								{#if q.multiSelect}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="question-option multi"
										class:selected={isMultiSelected(card.id, qIdx, opt.label)}
										onclick={() => toggleMultiSelection(card.id, qIdx, opt.label)}
									>
										<div class="question-option-label">
											<span class="question-checkbox">
												{#if isMultiSelected(card.id, qIdx, opt.label)}
													<Check size={10} />
												{/if}
											</span>
											{opt.label}
										</div>
										{#if opt.description}
											<div class="question-option-desc">{opt.description}</div>
										{/if}
									</div>
								{:else}
									<button class="question-option single" onclick={() => pickSingle(card, opt.label)}>
										<div class="question-option-label">{opt.label}</div>
										{#if opt.description}
											<div class="question-option-desc">{opt.description}</div>
										{/if}
									</button>
								{/if}
							{/each}
						</div>
					{/each}
				</div>
				{#if card.questions.some((q) => q.multiSelect)}
					<div class="modal-footer">
						<button class="btn-primary" onclick={() => submitMultiAnswer(card)}>
							<Check size={12} /> Submit
						</button>
					</div>
				{/if}
			{:else if activePlan}
				{@const plan = activePlan}
				<div class="modal-header">
					<Sparkles size={14} />
					<span>Plan from agent</span>
					<button
						class="close-btn"
						title="Dismiss"
						aria-label="Dismiss plan"
						onclick={() => onDismissPlan(plan.id)}
					>
						<X size={14} />
					</button>
				</div>
				<div class="modal-body plan-body">
					{@html renderPlanHtml(plan.plan)}
				</div>
				{#if rejectingPlanId === plan.id}
					<div class="modal-footer reject-footer">
						<textarea
							bind:this={rejectTextareaEl}
							bind:value={rejectFeedback}
							onkeydown={(e) => onRejectKeydown(e, plan.id)}
							placeholder="What's wrong with this plan? (e.g. 'skip step 2', 'focus on file X', 'too aggressive')"
							rows="3"
						></textarea>
						<div class="reject-actions">
							<span class="hint">⌘↵ to send · Esc to cancel</span>
							<button class="btn-secondary" onclick={closeRejectFeedback}>Cancel</button>
							<button
								class="btn-primary"
								onclick={() => submitRejectFeedback(plan.id)}
								disabled={!rejectFeedback.trim()}
							>
								Send feedback
							</button>
						</div>
					</div>
				{:else}
					<div class="modal-footer">
						<button class="btn-secondary" onclick={() => onDismissPlan(plan.id)}>Dismiss</button>
						<button class="btn-secondary" onclick={() => openRejectFeedback(plan.id)}>
							Reject with feedback
						</button>
						<button class="btn-primary" onclick={() => onRunPlan(plan.id)}>
							<Check size={12} /> Run it
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.agent-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 24px;
	}
	.agent-modal {
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		width: min(680px, 100%);
		max-height: min(80vh, 720px);
		display: flex;
		flex-direction: column;
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
	}
	.modal-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-light);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.close-btn {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 2px;
		border-radius: 4px;
		display: inline-flex;
	}
	.close-btn:hover {
		background: var(--bg-surface);
		color: var(--text);
	}
	.modal-body {
		padding: 14px 16px;
		overflow-y: auto;
		font-size: 13px;
		line-height: 1.55;
	}
	.modal-body.plan-body :global(h3),
	.modal-body.plan-body :global(h4),
	.modal-body.plan-body :global(h5),
	.modal-body.plan-body :global(h6) {
		font-size: 13.5px;
		font-weight: 600;
		margin: 14px 0 6px;
	}
	.modal-body.plan-body :global(p) {
		margin: 8px 0;
	}
	.modal-body.plan-body :global(ul) {
		margin: 8px 0;
		padding-left: 20px;
	}
	.modal-body.plan-body :global(li) {
		margin: 4px 0;
	}
	.modal-body.plan-body :global(code) {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 12px;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--bg-surface);
	}
	.modal-body.plan-body :global(strong) {
		font-weight: 600;
	}
	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--border-light);
	}
	.reject-footer {
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}
	.reject-footer textarea {
		width: 100%;
		resize: vertical;
		font-family: inherit;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px 10px;
		outline: none;
		box-sizing: border-box;
	}
	.reject-footer textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.reject-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	.reject-actions .hint {
		margin-right: auto;
		font-size: 11px;
		color: var(--text-faint);
	}
	.btn-primary,
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 14px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
	}
	.btn-primary {
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
	}
	.btn-primary:hover {
		filter: brightness(0.94);
	}
	.btn-primary:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.btn-secondary {
		background: var(--bg-surface);
		color: var(--text);
		border: 1px solid var(--border-light);
	}
	.btn-secondary:hover {
		background: var(--bg);
	}

	.question-header {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-top: 10px;
	}
	.question-header:first-child {
		margin-top: 0;
	}
	.question-text {
		font-size: 13.5px;
		margin: 4px 0 10px;
		color: var(--text);
	}
	.question-options {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 8px;
	}
	.question-option {
		text-align: left;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px 10px;
		cursor: pointer;
		font-family: inherit;
		color: var(--text);
		transition: border-color 0.12s, background 0.12s;
	}
	.question-option:hover {
		border-color: var(--accent-light);
		background: var(--bg);
	}
	.question-option.multi.selected {
		border-color: var(--accent);
		background: var(--accent-bg);
	}
	.question-option-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
	}
	.question-option-desc {
		font-size: 12px;
		color: var(--text-faint);
		margin-top: 3px;
		line-height: 1.4;
	}
	.question-checkbox {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: 1px solid var(--border-light);
		background: var(--bg);
		color: var(--accent);
	}
	.question-option.multi.selected .question-checkbox {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
</style>
