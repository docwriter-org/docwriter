	<script lang="ts">
	import { tick, onMount, onDestroy } from 'svelte';
	import type { Unsubscriber } from 'svelte/store';
	import * as Y from 'yjs';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		FileText,
		Sparkles,
		Check,
		X,
		BookOpen,
		Terminal,
		HelpCircle,
		RotateCcw
	} from 'lucide-svelte';
	import {
		activeTab,
		proposedRules,
		proposedHooks,
		pendingReviewRounds,
		pendingUserQuestions,
		type PendingUserQuestion
	} from '$lib/stores';
	import { getYDocForTab } from '$lib/yjs-doc';
	import type { ProposedRule, ProposedHook } from '$lib/types';
	import type { MaterializedPendingReviewRound } from '$lib/review-rounds';
	import {
		summarizeRound,
		buildReviewDiffPreview,
		type ReviewPreviewLine
	} from '$lib/review-diff';

	interface Props {
		showOutline?: boolean;
		showReview?: boolean;
		/** roundId is optional — callers that don't pass one accept/reject
		 * every pending round. */
		onAccept?: (roundId?: string) => void;
		onReject?: (roundId?: string) => void;
		onRetryWithFeedback?: (roundId: string, feedback: string) => void;
		onAcceptRule?: (id: string) => void;
		onRejectRule?: (id: string) => void;
		onAcceptHook?: (id: string) => void;
		onRejectHook?: (id: string) => void;
		onAnswer?: (id: string, answers: string[]) => void;
	}
	let {
		showOutline = true,
		showReview = true,
		onAccept,
		onReject,
		onRetryWithFeedback,
		onAcceptRule,
		onRejectRule,
		onAcceptHook,
		onRejectHook,
		onAnswer
	}: Props = $props();

	let md = $state('');

	import { plainTextFromFragment } from '$lib/yjs-text';

	let activeTabUnsubscribe: Unsubscriber | null = null;
	let observedFragment: Y.XmlFragment | null = null;
	let observedHandler: (() => void) | null = null;

	function detachOutlineObserver() {
		if (observedFragment && observedHandler) {
			observedFragment.unobserve(observedHandler);
		}
		observedFragment = null;
		observedHandler = null;
	}

	function attachOutlineObserver(tabId: string | null) {
		detachOutlineObserver();
		if (!tabId) {
			md = '';
			return;
		}
		const fragment = getYDocForTab(tabId).getXmlFragment('default');
		const sync = () => {
			md = plainTextFromFragment(fragment);
		};
		sync();
		fragment.observe(sync);
		observedFragment = fragment;
		observedHandler = sync;
	}

	let rounds = $state<MaterializedPendingReviewRound[]>([]);
	pendingReviewRounds.subscribe((v) => (rounds = v));

	let pendingRuleProposals = $state<ProposedRule[]>([]);
	proposedRules.subscribe((v) => (pendingRuleProposals = v));

	let pendingHookProposals = $state<ProposedHook[]>([]);
	proposedHooks.subscribe((v) => (pendingHookProposals = v));

	let pendingQuestions = $state<PendingUserQuestion[]>([]);
	pendingUserQuestions.subscribe((v) => (pendingQuestions = v));

	/** Selections for each multi-select question, keyed by `${cardId}:${qIdx}`.
	 * Single-select questions answer immediately on click and don't use this. */
	let multiSelections = $state<Record<string, Set<string>>>({});

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

	/** Submit a multi-select card: gather selections across all questions,
	 * flatten into a single answers array in question order, and send. */
	function submitMultiAnswer(card: PendingUserQuestion) {
		const answers: string[] = [];
		for (let i = 0; i < card.questions.length; i++) {
			const sel = multiSelections[`${card.id}:${i}`];
			if (sel && sel.size > 0) {
				for (const label of sel) answers.push(label);
			}
		}
		if (answers.length === 0) return;
		// Cleanup local selection state for this card.
		const next = { ...multiSelections };
		for (let i = 0; i < card.questions.length; i++) delete next[`${card.id}:${i}`];
		multiSelections = next;
		onAnswer?.(card.id, answers);
	}

	/** Single-select click — answer with the one label. */
	function pickSingle(card: PendingUserQuestion, label: string) {
		onAnswer?.(card.id, [label]);
	}

	// Auto-extracted TOC from markdown headings
	interface Heading { level: number; text: string; }
	let toc = $derived.by<Heading[]>(() => {
		const headings: Heading[] = [];
		const lines = md.split('\n');
		for (const line of lines) {
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) {
				headings.push({ level: match[1].length, text: match[2].trim() });
			}
		}
		return headings;
	});

	/** Tick every 15s so "Xs ago" / "Xm ago" labels on pending cards stay
	 * fresh. Reactive via the state dependency — `relativeTime()` reads
	 * `nowTick` so Svelte re-renders when it changes. */
	let nowTick = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		tickHandle = setInterval(() => (nowTick = Date.now()), 15_000);
		activeTabUnsubscribe = activeTab.subscribe((tabId) => attachOutlineObserver(tabId));
	});
	onDestroy(() => {
		if (tickHandle) clearInterval(tickHandle);
		activeTabUnsubscribe?.();
		detachOutlineObserver();
	});

	/** Short relative-time label for a round card. */
	function relativeTime(ts: number): string {
		const elapsed = nowTick - ts;
		if (elapsed < 5_000) return 'just now';
		if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
		if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function scrollToHeading(text: string) {
		// Best-effort scroll: find the heading element in the editor DOM by text
		const editor = document.querySelector('.tiptap-content');
		if (!editor) return;
		const hs = editor.querySelectorAll('h1, h2, h3, h4, h5, h6');
		for (const h of Array.from(hs)) {
			if (h.textContent?.trim() === text) {
				h.scrollIntoView({ behavior: 'smooth', block: 'start' });
				break;
			}
		}
	}

	function diffPreview(round: MaterializedPendingReviewRound): ReviewPreviewLine[] {
		return buildReviewDiffPreview(round.beforeMd, round.afterMd, 1);
	}

	let retryFeedbackRoundId = $state<string | null>(null);
	let retryFeedbackText = $state('');
	let retryTextareaEl: HTMLTextAreaElement | null = $state(null);

	async function openRetryFeedback(roundId: string) {
		retryFeedbackRoundId = roundId;
		retryFeedbackText = '';
		await tick();
		retryTextareaEl?.focus();
	}

	function closeRetryFeedback() {
		retryFeedbackRoundId = null;
		retryFeedbackText = '';
	}

	function submitRetryFeedback(roundId: string) {
		const feedback = retryFeedbackText.trim();
		if (!feedback) return;
		onRetryWithFeedback?.(roundId, feedback);
		closeRetryFeedback();
	}

	function onRetryKeydown(event: KeyboardEvent, roundId: string) {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeRetryFeedback();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			submitRetryFeedback(roundId);
		}
	}
</script>

<div class="outline-pane">
	{#if showOutline}
		<div class="section">
			<div class="section-header">Outline</div>
			{#if toc.length === 0}
				<div class="empty">No headings yet.</div>
			{:else}
				<div class="toc">
					{#each toc as h}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="toc-item"
							style:padding-left={`${(h.level - 1) * 12}px`}
							onclick={() => scrollToHeading(h.text)}
						>
							<FileText size={11} />
							<span>{h.text}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if showReview && rounds.length > 0}
		<div class="section">
			<div class="section-header">
				<Sparkles size={12} />
				Pending agent edit{rounds.length === 1 ? '' : `s (${rounds.length})`}
			</div>
			{#each rounds.slice().reverse() as round, revIdx (round.id)}
				{@const isEarliest = revIdx === rounds.length - 1}
				{@const preview = diffPreview(round)}
				<div
					class="pending-card round-card"
					class:later-round={!isEarliest}
					class:tiny-card={round.kind === 'tiny'}
					in:fly={{ y: -10, duration: 260, easing: cubicOut }}
				>
					<div class="pending-summary">
						<span>{summarizeRound(round)}</span>
						<span class="round-time">{relativeTime(round.timestamp)}</span>
					</div>
					{#if round.trigger}
						<div class="round-trigger" title={round.trigger}>{round.trigger}</div>
					{/if}
					{#if preview.length > 0}
						<div class="round-diff-preview">
							{#each preview as line}
								<div
									class="round-diff-line"
									class:added={line.kind === 'added'}
									class:removed={line.kind === 'removed'}
									class:gap={line.kind === 'gap'}
								>
									<span class="round-diff-num">{line.oldLine ?? ''}</span>
									<span class="round-diff-num">{line.newLine ?? ''}</span>
									<span class="round-diff-prefix">
										{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
									</span>
									<span class="round-diff-text">
										{#if line.kind === 'gap'}
											...
										{:else}
											{#each line.parts as part}
												<span
													class="round-diff-token"
													class:token-added={part.type === 'added'}
													class:token-removed={part.type === 'removed'}
												>{part.text || ' '}</span>
											{/each}
										{/if}
									</span>
								</div>
							{/each}
						</div>
					{/if}
					<div class="pending-actions">
						{#if isEarliest}
							<button class="btn-accept" onclick={() => onAccept?.(round.id)}>
								<Check size={12} />
								Accept
							</button>
						{:else}
							<span class="action-note" title="Accept earlier edits first">
								Accept earlier first
							</span>
						{/if}
						<button class="btn-reject" onclick={() => onReject?.(round.id)}>
							<X size={12} />
							Reject
						</button>
						<button class="btn-retry" onclick={() => openRetryFeedback(round.id)}>
							<RotateCcw size={12} />
							Retry with feedback
						</button>
					</div>
					{#if retryFeedbackRoundId === round.id}
						<div class="retry-feedback-popover">
							<div class="retry-feedback-label">Why should the agent try again?</div>
							<textarea
								bind:this={retryTextareaEl}
								bind:value={retryFeedbackText}
								rows="3"
								placeholder="Explain what was wrong and what to do instead."
								onkeydown={(event) => onRetryKeydown(event, round.id)}
							></textarea>
							<div class="retry-feedback-actions">
								<button class="btn-secondary" onclick={closeRetryFeedback}>Cancel</button>
								<button
									class="btn-retry submit"
									disabled={!retryFeedbackText.trim()}
									onclick={() => submitRetryFeedback(round.id)}
								>
									<RotateCcw size={12} />
									Retry
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if showReview && pendingQuestions.length > 0}
		<div class="section">
			<div class="section-header">
				<HelpCircle size={12} />
				Question{pendingQuestions.length === 1 ? '' : 's'} from agent
			</div>
			{#each pendingQuestions as card (card.id)}
				<div class="pending-card question-card" in:fly={{ y: -10, duration: 260, easing: cubicOut }}>
					{#each card.questions as q, qIdx}
						{#if card.questions.length > 1}
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
									<button
										class="question-option single"
										onclick={() => pickSingle(card, opt.label)}
									>
										<div class="question-option-label">{opt.label}</div>
										{#if opt.description}
											<div class="question-option-desc">{opt.description}</div>
										{/if}
									</button>
								{/if}
							{/each}
						</div>
					{/each}
					{#if card.questions.some((q) => q.multiSelect)}
						<div class="pending-actions">
							<button class="btn-accept" onclick={() => submitMultiAnswer(card)}>
								<Check size={12} />
								Submit
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if showReview && pendingRuleProposals.length > 0}
		<div class="section">
			<div class="section-header">
				<BookOpen size={12} />
				Proposed rules
			</div>
			{#each pendingRuleProposals as proposal (proposal.id)}
				<div class="pending-card rule-card">
					<div class="rule-proposal-text">{proposal.text}</div>
					{#if proposal.reason}
						<div class="rule-proposal-reason">{proposal.reason}</div>
					{/if}
					<div class="pending-actions">
						<button class="btn-accept" onclick={() => onAcceptRule?.(proposal.id)}>
							<Check size={12} />
							Add rule
						</button>
						<button class="btn-reject" onclick={() => onRejectRule?.(proposal.id)}>
							<X size={12} />
							Dismiss
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if showReview && pendingHookProposals.length > 0}
		<div class="section">
			<div class="section-header">
				<Terminal size={12} />
				Proposed hooks
			</div>
			{#each pendingHookProposals as proposal (proposal.id)}
				<div class="pending-card rule-card">
					<div class="hook-meta">
						<span class="hook-event-tag">{proposal.event}</span>
						{#if proposal.matcher}<span class="hook-matcher-tag">/{proposal.matcher}/</span>{/if}
					</div>
					<div class="hook-command">{proposal.command}</div>
					{#if proposal.reason}
						<div class="rule-proposal-reason">{proposal.reason}</div>
					{/if}
					<div class="pending-actions">
						<button class="btn-accept" onclick={() => onAcceptHook?.(proposal.id)}>
							<Check size={12} />
							Add hook
						</button>
						<button class="btn-reject" onclick={() => onRejectHook?.(proposal.id)}>
							<X size={12} />
							Dismiss
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.outline-pane {
		padding: 20px 16px;
		overflow-y: auto;
		height: 100%;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.section {
		margin-bottom: 28px;
	}
	.section-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 10px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.empty {
		color: var(--text-faint);
		font-size: 13px;
		padding: 4px 0;
	}
	.toc-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.4;
	}
	.toc-item:hover {
		background: var(--bg-hover);
	}
	.pending-card {
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		border-radius: 6px;
		padding: 10px;
	}
	.pending-summary {
		font-size: 12px;
		color: var(--text-muted);
		margin-bottom: 10px;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.round-card {
		margin-bottom: 8px;
	}
	.round-card:last-child {
		margin-bottom: 0;
	}
	/* Later (non-earliest) rounds are dimmer — the user is meant to deal
	 * with them after the current round resolves. Still interactive
	 * (Reject is allowed) but visually secondary. */
	.round-card.later-round {
		opacity: 0.72;
	}
	.round-card.later-round:hover {
		opacity: 1;
	}
	/* Tiny-kind rounds render in a compact single-line style — no border,
	 * no background, buttons flush to the right. Reads as a suggestion
	 * rather than a reviewable diff. */
	.round-card.tiny-card {
		border: none;
		background: transparent;
		padding: 4px 6px;
	}
	.tiny-card .pending-summary {
		margin-bottom: 0;
		font-size: 11.5px;
	}
	.tiny-card .pending-actions {
		margin-top: 4px;
	}
	.tiny-card .btn-accept,
	.tiny-card .btn-reject {
		padding: 3px 7px;
		font-size: 11px;
	}
	.action-note {
		flex: 1;
		font-size: 11px;
		color: var(--text-faint);
		font-style: italic;
		line-height: 1.3;
		padding: 5px 8px;
	}
	.round-time {
		font-size: 10.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.round-trigger {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.4;
		margin-bottom: 10px;
		font-style: italic;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.round-diff-preview {
		margin-bottom: 10px;
		border: 1px solid var(--border-light);
		border-radius: 5px;
		background: var(--bg-elevated);
		overflow: hidden;
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		line-height: 1.45;
	}
	.round-diff-line {
		display: grid;
		grid-template-columns: 28px 28px 12px minmax(0, 1fr);
		align-items: start;
		column-gap: 6px;
		padding: 3px 8px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.round-diff-line.added {
		background: color-mix(in srgb, var(--diff-added-color) 9%, transparent);
	}
	.round-diff-line.removed {
		background: color-mix(in srgb, var(--diff-removed-color) 9%, transparent);
	}
	.round-diff-line.gap {
		color: var(--text-faint);
		font-style: italic;
	}
	.round-diff-num,
	.round-diff-prefix {
		color: var(--text-faint);
		user-select: none;
	}
	.round-diff-prefix {
		text-align: center;
	}
	.round-diff-text {
		min-width: 0;
		color: var(--text);
	}
	.round-diff-token.token-added {
		background: color-mix(in srgb, var(--diff-added-color) 22%, transparent);
		border-radius: 2px;
	}
	.round-diff-token.token-removed {
		background: color-mix(in srgb, var(--diff-removed-color) 18%, transparent);
		border-radius: 2px;
	}
	.rule-card {
		margin-bottom: 8px;
	}
	.rule-card:last-child {
		margin-bottom: 0;
	}
	.rule-proposal-text {
		font-size: 13px;
		color: var(--text);
		font-weight: 500;
		margin-bottom: 4px;
		line-height: 1.35;
	}
	.rule-proposal-reason {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.4;
		margin-bottom: 10px;
		font-style: italic;
	}
	.hook-meta {
		display: flex;
		gap: 6px;
		margin-bottom: 4px;
	}
	.hook-event-tag {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #0891b2;
		background: color-mix(in srgb, #0891b2 12%, transparent);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.hook-matcher-tag {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 10px;
		color: var(--text-faint);
		padding: 1px 0;
	}
	.hook-command {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 11.5px;
		color: var(--text);
		line-height: 1.4;
		margin-bottom: 6px;
		word-break: break-word;
	}
	.pending-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.btn-accept, .btn-reject, .btn-retry, .btn-secondary {
		flex: 1 1 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 5px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		font-family: inherit;
	}
	.btn-accept:disabled, .btn-reject:disabled, .btn-retry:disabled, .btn-secondary:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.btn-accept {
		color: var(--diff-added-color);
	}
	.btn-accept:hover {
		background: color-mix(in srgb, var(--diff-added-color) 12%, transparent);
		border-color: var(--diff-added-color);
	}
	.btn-reject {
		color: var(--diff-removed-color);
	}
	.btn-reject:hover {
		background: color-mix(in srgb, var(--diff-removed-color) 10%, transparent);
		border-color: var(--diff-removed-color);
	}
	.btn-retry {
		color: var(--accent);
	}
	.btn-retry:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent) 65%, var(--border-light));
	}
	.btn-secondary {
		color: var(--text-muted);
	}
	.btn-secondary:hover:not(:disabled) {
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.retry-feedback-popover {
		margin-top: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-light));
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
		border-radius: 6px;
		padding: 10px;
	}
	.retry-feedback-label {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 6px;
	}
	.retry-feedback-popover textarea {
		width: 100%;
		max-width: 100%;
		min-height: 72px;
		resize: vertical;
		box-sizing: border-box;
		border: 1px solid var(--border-light);
		border-radius: 5px;
		background: var(--bg-elevated);
		color: var(--text);
		font: inherit;
		line-height: 1.45;
		padding: 8px 9px;
	}
	.retry-feedback-popover textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 70%, var(--border-light));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
	}
	.retry-feedback-popover textarea::placeholder {
		color: var(--text-faint);
	}
	.retry-feedback-actions {
		display: flex;
		gap: 6px;
		margin-top: 8px;
	}
	.retry-feedback-actions .btn-secondary,
	.retry-feedback-actions .btn-retry {
		flex: 0 0 auto;
		padding-inline: 10px;
	}
	.question-card {
		margin-bottom: 8px;
		border-color: color-mix(in srgb, var(--accent) 35%, var(--border-light));
	}
	.question-card:last-child {
		margin-bottom: 0;
	}
	.question-header {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
		margin-bottom: 4px;
	}
	.question-text {
		font-size: 13px;
		color: var(--text);
		line-height: 1.4;
		margin-bottom: 8px;
	}
	.question-options {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
	}
	.question-option {
		display: block;
		width: 100%;
		text-align: left;
		padding: 6px 8px;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
		color: var(--text);
	}
	.question-option:hover {
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-light));
	}
	.question-option.selected {
		background: color-mix(in srgb, var(--accent) 14%, var(--bg-elevated));
		border-color: var(--accent);
	}
	.question-option-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 500;
		line-height: 1.3;
	}
	.question-option-desc {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.35;
		margin-top: 2px;
		margin-left: 0;
	}
	.question-checkbox {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		height: 13px;
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--accent);
		flex-shrink: 0;
	}
	.question-option.selected .question-checkbox {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}
</style>
