<script lang="ts">
	import { tick, onMount, onDestroy } from 'svelte';
	import type { Unsubscriber } from 'svelte/store';
	import * as Y from 'yjs';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut, cubicInOut } from 'svelte/easing';
	import {
		FileText,
		Sparkles,
		Check,
		X,
		BookOpen,
		Terminal,
		RotateCcw,
		MessageSquare
	} from 'lucide-svelte';
	import {
		activeTab,
		proposedRules,
		proposedHooks,
		pendingReviewRounds,
		allTabPendingRounds,
		allTabCommentThreads,
		seenCommentIds,
		markCommentSeen
	} from '$lib/stores';
	import { getYDocForTab } from '$lib/yjs-doc';
	import type { ProposedRule, ProposedHook, CommentThread } from '$lib/types';
	import type { MaterializedPendingReviewRound } from '$lib/review-rounds';
	import {
		summarizeRound,
		buildReviewDiffPreview,
		type ReviewPreviewLine
	} from '$lib/review-diff';
	import { serializeFragment as plainTextFromFragment } from '$lib/shared/ydoc-codec';

	interface Props {
		showOutline?: boolean;
		showReview?: boolean;
		onAccept?: (roundId?: string) => void;
		onReject?: (roundId?: string) => void;
		onRetryWithFeedback?: (roundId: string, feedback: string) => void;
		onAcceptRule?: (id: string) => void;
		onRejectRule?: (id: string) => void;
		onAcceptHook?: (id: string) => void;
		onRejectHook?: (id: string) => void;
		onNavigateToRound?: (tabId: string, round: MaterializedPendingReviewRound) => Promise<void>;
		onNavigateToComment?: (tabId: string, thread: CommentThread) => Promise<void>;
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
		onNavigateToRound,
		onNavigateToComment
	}: Props = $props();

	let md = $state('');
	let observedFragment: Y.XmlFragment | null = null;
	let observedHandler: (() => void) | null = null;

	function detachOutlineObserver() {
		if (observedFragment && observedHandler) observedFragment.unobserve(observedHandler);
		observedFragment = null;
		observedHandler = null;
	}

	function attachOutlineObserver(tabId: string | null) {
		detachOutlineObserver();
		if (!tabId) { md = ''; return; }
		const fragment = getYDocForTab(tabId).getXmlFragment('default');
		const sync = () => { md = plainTextFromFragment(fragment); };
		sync();
		fragment.observe(sync);
		observedFragment = fragment;
		observedHandler = sync;
	}

	// unused but kept to avoid breaking the diff overlay store subscription
	pendingReviewRounds.subscribe(() => {});

	let allRounds = $state<Array<{ tabId: string; rounds: MaterializedPendingReviewRound[] }>>([]);
	allTabPendingRounds.subscribe((v) => (allRounds = v));

	let allComments = $state<Array<{ tabId: string; threads: CommentThread[] }>>([]);
	allTabCommentThreads.subscribe((v) => (allComments = v));

	let seenIds = $state<Set<string>>(new Set());
	seenCommentIds.subscribe((v) => (seenIds = v));

	let activeTabId = $state<string | null>(null);
	let activeTabUnsub: Unsubscriber | null = null;

	let pendingRuleProposals = $state<ProposedRule[]>([]);
	proposedRules.subscribe((v) => (pendingRuleProposals = v));

	let pendingHookProposals = $state<ProposedHook[]>([]);
	proposedHooks.subscribe((v) => (pendingHookProposals = v));

	interface Heading { level: number; text: string; }
	let toc = $derived.by<Heading[]>(() => {
		const headings: Heading[] = [];
		for (const line of md.split('\n')) {
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) headings.push({ level: match[1].length, text: match[2].trim() });
		}
		return headings;
	});

	let totalRounds = $derived(allRounds.reduce((n, g) => n + g.rounds.length, 0));

	function basename(path: string): string {
		return path.split('/').pop() ?? path;
	}

	let nowTick = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		tickHandle = setInterval(() => (nowTick = Date.now()), 15_000);
		activeTabUnsub = activeTab.subscribe((tabId) => {
			activeTabId = tabId;
			attachOutlineObserver(tabId);
		});
	});
	onDestroy(() => {
		if (tickHandle) clearInterval(tickHandle);
		activeTabUnsub?.();
		detachOutlineObserver();
	});

	function relativeTime(ts: number): string {
		const elapsed = nowTick - ts;
		if (elapsed < 5_000) return 'just now';
		if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
		if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function scrollToHeading(text: string) {
		const editor = document.querySelector('.tiptap-content');
		if (!editor) return;
		for (const h of Array.from(editor.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
			if (h.textContent?.trim() === text) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
		}
	}

	function scrollToRound(round: MaterializedPendingReviewRound) {
		const editor = document.querySelector('.tiptap-content') as HTMLElement | null;
		if (!editor) return;
		const op = round.operation;
		const fullNeedle = op?.type === 'edit' ? op.oldString : null;
		let paragraphs = Array.from(editor.querySelectorAll(':scope > p')) as HTMLElement[];
		if (paragraphs.length === 0) paragraphs = Array.from(editor.querySelectorAll('p')) as HTMLElement[];
		if (paragraphs.length === 0) { editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
		const scrollToParagraphAt = (charOffset: number) => {
			const lines = paragraphs.map((p) => p.textContent ?? '');
			let cursor = 0;
			for (let i = 0; i < lines.length; i++) {
				const lineEnd = cursor + lines[i].length;
				if (charOffset <= lineEnd) { paragraphs[i].scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
				cursor = lineEnd + 1;
			}
		};
		if (!fullNeedle) { editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
		const docText = paragraphs.map((p) => p.textContent ?? '').join('\n');
		let offset = docText.indexOf(fullNeedle);
		if (offset < 0 && fullNeedle.length > 80) offset = docText.indexOf(fullNeedle.slice(0, 80));
		if (offset < 0) { const fl = fullNeedle.split('\n').find((l) => l.trim().length > 4); if (fl) offset = docText.indexOf(fl.trim()); }
		if (offset < 0) { editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
		scrollToParagraphAt(offset);
	}

	async function handleRoundClick(tabId: string, round: MaterializedPendingReviewRound) {
		if (tabId !== activeTabId && onNavigateToRound) {
			await onNavigateToRound(tabId, round);
			await tick();
		}
		scrollToRound(round);
	}

	async function handleCommentClick(tabId: string, thread: CommentThread) {
		markCommentSeen(thread.id);
		if (tabId !== activeTabId && onNavigateToComment) {
			await onNavigateToComment(tabId, thread);
			await tick();
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
		if (event.key === 'Escape') { event.preventDefault(); closeRetryFeedback(); return; }
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submitRetryFeedback(roundId); }
	}

	function firstAgentMessage(thread: CommentThread): string {
		return thread.messages.find((m) => m.author === 'agent')?.text ?? '';
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
						<div class="toc-item" style:padding-left={`${(h.level - 1) * 12}px`} onclick={() => scrollToHeading(h.text)}>
							<FileText size={11} />
							<span>{h.text}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if showReview && totalRounds > 0}
		<div class="section">
			<div class="section-header">
				<Sparkles size={12} />
				Pending agent edit{totalRounds === 1 ? '' : `s (${totalRounds})`}
			</div>
			{#each allRounds as group (group.tabId)}
				{@const isActiveTab = group.tabId === activeTabId}
				{#if !isActiveTab}
					<div class="tab-group-label">
						<FileText size={10} />
						{basename(group.tabId)}
					</div>
				{/if}
				{#each group.rounds.slice().reverse() as round, revIdx (round.id)}
					{@const isEarliest = revIdx === group.rounds.length - 1}
					{@const preview = diffPreview(round)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="pending-card round-card"
						class:later-round={!isEarliest}
						class:tiny-card={round.kind === 'tiny'}
						class:cross-tab={!isActiveTab}
						in:fly={{ y: -10, duration: 260, easing: cubicOut }}
						out:fly={{ y: 40, duration: 280, easing: cubicInOut }}
						animate:flip={{ duration: 280, easing: cubicInOut }}
						onclick={() => void handleRoundClick(group.tabId, round)}
						role="button"
						tabindex="0"
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleRoundClick(group.tabId, round); } }}
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
									<div class="round-diff-line" class:added={line.kind === 'added'} class:removed={line.kind === 'removed'} class:gap={line.kind === 'gap'}>
										<span class="round-diff-num">{line.oldLine ?? ''}</span>
										<span class="round-diff-num">{line.newLine ?? ''}</span>
										<span class="round-diff-prefix">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
										<span class="round-diff-text">
											{#if line.kind === 'gap'}
												...
											{:else}
												{#each line.parts as part}
													<span class="round-diff-token" class:token-added={part.type === 'added'} class:token-removed={part.type === 'removed'}>{part.text || ' '}</span>
												{/each}
											{/if}
										</span>
									</div>
								{/each}
							</div>
						{/if}
						<div class="pending-actions" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
							{#if isEarliest && isActiveTab}
								<button class="btn-accept" onclick={() => onAccept?.(round.id)}>
									<Check size={12} />Accept
								</button>
							{:else if !isActiveTab}
								<span class="action-note" title="Switch to this file to accept/reject">Open file to review</span>
							{:else}
								<span class="action-note" title="Accept earlier edits first">Accept earlier first</span>
							{/if}
							{#if isActiveTab}
								<button class="btn-reject" onclick={() => onReject?.(round.id)}>
									<X size={12} />Reject
								</button>
								<button class="btn-retry" onclick={() => openRetryFeedback(round.id)}>
									<RotateCcw size={12} />Retry with feedback
								</button>
							{/if}
						</div>
						{#if retryFeedbackRoundId === round.id}
							<div class="retry-feedback-popover" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
								<div class="retry-feedback-label">Feedback for the agent</div>
								<textarea bind:this={retryTextareaEl} bind:value={retryFeedbackText} rows="3" placeholder="What you'd like the agent to know." onkeydown={(event) => onRetryKeydown(event, round.id)}></textarea>
								<div class="retry-feedback-actions">
									<button class="btn-secondary" onclick={closeRetryFeedback}>Cancel</button>
									<button class="btn-retry submit" disabled={!retryFeedbackText.trim()} onclick={() => submitRetryFeedback(round.id)}>
										<RotateCcw size={12} />Retry
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			{/each}
		</div>
	{/if}

	{#if showReview && allComments.length > 0}
		{@const unreadGroups = allComments.map(g => ({ ...g, threads: g.threads.filter(t => !seenIds.has(t.id)) })).filter(g => g.threads.length > 0)}
		{#if unreadGroups.length > 0}
		{@const totalComments = unreadGroups.reduce((n, g) => n + g.threads.length, 0)}
		<div class="section">
			<div class="section-header">
				<MessageSquare size={12} />
				Agent comment{totalComments === 1 ? '' : `s (${totalComments})`}
				<button
					class="dismiss-all-btn"
					onclick={() => unreadGroups.forEach(g => g.threads.forEach(t => markCommentSeen(t.id)))}
					title="Dismiss all"
				>dismiss all</button>
			</div>
			{#each unreadGroups as group (group.tabId)}
				{@const isActiveTab = group.tabId === activeTabId}
				{#if !isActiveTab}
					<div class="tab-group-label">
						<FileText size={10} />
						{basename(group.tabId)}
					</div>
				{/if}
				{#each group.threads as thread (thread.id)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="pending-card comment-card"
						onclick={() => void handleCommentClick(group.tabId, thread)}
						role="button"
						tabindex="0"
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleCommentClick(group.tabId, thread); } }}
					>
						<div class="comment-header">
							<span class="unread-dot" title="Unread"></span>
							<span class="comment-anchor" title={thread.anchor.quote}>{thread.anchor.quote.slice(0, 40)}{thread.anchor.quote.length > 40 ? '…' : ''}</span>
							<span class="round-time">{relativeTime(thread.createdAt)}</span>
						</div>
						<div class="comment-body">{firstAgentMessage(thread).slice(0, 80)}{firstAgentMessage(thread).length > 80 ? '…' : ''}</div>
					</div>
				{/each}
			{/each}
		</div>
		{/if}
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
					{#if proposal.reason}<div class="rule-proposal-reason">{proposal.reason}</div>{/if}
					<div class="pending-actions">
						<button class="btn-accept" onclick={() => onAcceptRule?.(proposal.id)}><Check size={12} />Add rule</button>
						<button class="btn-reject" onclick={() => onRejectRule?.(proposal.id)}><X size={12} />Dismiss</button>
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
					{#if proposal.reason}<div class="rule-proposal-reason">{proposal.reason}</div>{/if}
					<div class="pending-actions">
						<button class="btn-accept" onclick={() => onAcceptHook?.(proposal.id)}><Check size={12} />Add hook</button>
						<button class="btn-reject" onclick={() => onRejectHook?.(proposal.id)}><X size={12} />Dismiss</button>
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
	.section { margin-bottom: 28px; }
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
	.empty { color: var(--text-faint); font-size: 13px; padding: 4px 0; }
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
	.toc-item:hover { background: var(--bg-hover); }
	.tab-group-label {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 8px 2px 4px;
		margin-top: 2px;
	}
	.pending-card {
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		border-radius: 6px;
		padding: 10px;
		margin-bottom: 8px;
	}
	.pending-card:last-child { margin-bottom: 0; }
	.round-card {
		cursor: default;
		transition: border-color 120ms ease, background-color 120ms ease;
	}
	.round-card:hover {
		border-color: var(--border);
		background: color-mix(in srgb, var(--bg-surface) 88%, var(--accent) 12%);
	}
	/* Dashed border signals "belongs to a different file". */
	.round-card.cross-tab { border-style: dashed; cursor: pointer; }
	.pending-summary {
		font-size: 12px;
		color: var(--text-muted);
		margin-bottom: 10px;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.round-card.later-round { opacity: 0.72; }
	.round-card.later-round:hover { opacity: 1; }
	.round-card.tiny-card { padding: 6px 8px; }
	.tiny-card .pending-summary { margin-bottom: 4px; font-size: 11.5px; }
	.tiny-card .pending-actions { margin-top: 4px; }
	.tiny-card .btn-accept, .tiny-card .btn-reject { padding: 3px 7px; font-size: 11px; }
	.action-note {
		flex: 1;
		font-size: 11px;
		color: var(--text-faint);
		font-style: italic;
		line-height: 1.3;
		padding: 5px 8px;
	}
	.round-time { font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; flex-shrink: 0; }
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
	.round-diff-line.added { background: color-mix(in srgb, var(--diff-added-color) 9%, transparent); }
	.round-diff-line.removed { background: color-mix(in srgb, var(--diff-removed-color) 9%, transparent); }
	.round-diff-line.gap { color: var(--text-faint); font-style: italic; }
	.round-diff-num, .round-diff-prefix { color: var(--text-faint); user-select: none; }
	.round-diff-prefix { text-align: center; }
	.round-diff-text { min-width: 0; color: var(--text); }
	.round-diff-token.token-added { background: color-mix(in srgb, var(--diff-added-color) 22%, transparent); border-radius: 2px; }
	.round-diff-token.token-removed { background: color-mix(in srgb, var(--diff-removed-color) 18%, transparent); border-radius: 2px; }

	.dismiss-all-btn {
		margin-left: auto;
		background: none;
		border: none;
		font: inherit;
		font-size: 10.5px;
		color: var(--text-faint);
		cursor: pointer;
		padding: 1px 4px;
		border-radius: 3px;
		text-transform: none;
		letter-spacing: 0;
	}
	.dismiss-all-btn:hover { color: var(--text-secondary); background: var(--bg-hover); }
	.comment-card {
		cursor: pointer;
		transition: border-color 120ms ease, background-color 120ms ease;
		border-color: var(--accent-light);
	}
	.comment-card:hover { border-color: var(--accent); background: var(--bg-hover); }
	.comment-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}
	.unread-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		animation: unread-pulse 1.8s ease-in-out infinite;
	}
	@keyframes unread-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50%       { opacity: 0.45; transform: scale(1.3); }
	}
	.comment-anchor {
		flex: 1;
		font-size: 11px;
		color: var(--text-faint);
		font-style: italic;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.comment-body {
		font-size: 12px;
		color: var(--text-secondary);
		line-height: 1.4;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.rule-card { margin-bottom: 8px; }
	.rule-card:last-child { margin-bottom: 0; }
	.rule-proposal-text { font-size: 13px; color: var(--text); font-weight: 500; margin-bottom: 4px; line-height: 1.35; }
	.rule-proposal-reason { font-size: 11.5px; color: var(--text-muted); line-height: 1.4; margin-bottom: 10px; font-style: italic; }
	.hook-meta { display: flex; gap: 6px; margin-bottom: 4px; }
	.hook-event-tag { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #0891b2; background: color-mix(in srgb, #0891b2 12%, transparent); padding: 1px 6px; border-radius: 3px; }
	.hook-matcher-tag { font-family: 'SF Mono', 'Menlo', monospace; font-size: 10px; color: var(--text-faint); padding: 1px 0; }
	.hook-command { font-family: 'SF Mono', 'Menlo', monospace; font-size: 11.5px; color: var(--text); line-height: 1.4; margin-bottom: 6px; word-break: break-word; }
	.pending-actions { display: flex; gap: 6px; flex-wrap: wrap; }
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
	.btn-accept:disabled, .btn-reject:disabled, .btn-retry:disabled, .btn-secondary:disabled { opacity: 0.45; cursor: default; }
	.btn-accept { color: var(--diff-added-color); }
	.btn-accept:hover { background: color-mix(in srgb, var(--diff-added-color) 12%, transparent); border-color: var(--diff-added-color); }
	.btn-reject { color: var(--diff-removed-color); }
	.btn-reject:hover { background: color-mix(in srgb, var(--diff-removed-color) 10%, transparent); border-color: var(--diff-removed-color); }
	.btn-retry { color: var(--accent); }
	.btn-retry:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: color-mix(in srgb, var(--accent) 65%, var(--border-light)); }
	.btn-secondary { color: var(--text-muted); }
	.btn-secondary:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border); }
	.retry-feedback-popover {
		margin-top: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-light));
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
		border-radius: 6px;
		padding: 10px;
	}
	.retry-feedback-label { font-size: 11.5px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
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
	.retry-feedback-popover textarea:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 70%, var(--border-light)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
	.retry-feedback-popover textarea::placeholder { color: var(--text-faint); }
	.retry-feedback-actions { display: flex; gap: 6px; margin-top: 8px; }
	.retry-feedback-actions .btn-secondary, .retry-feedback-actions .btn-retry { flex: 0 0 auto; padding-inline: 10px; }
</style>
