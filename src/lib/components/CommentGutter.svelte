<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { Send, Sparkles, Cat, Check, X, User } from 'lucide-svelte';

	/** Minimal inline markdown → HTML. Matches the renderer used in
	 * HistoryPane so assistant_text and comments look the same. Escapes
	 * first, then substitutes safe subset (bold, italic, inline code,
	 * bullets, line breaks). Input is trusted enough (user + agent text
	 * already stored on our server) that we skip a full sanitizer. */
	function renderMarkdown(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>')
			.replace(/`(.+?)`/g, '<code>$1</code>')
			.replace(/^- (.+)$/gm, '<span class="md-bullet">$1</span>')
			.replace(/\n/g, '<br>');
	}
	import { onDestroy, onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { CommentThread } from '$lib/types';
	import { resolveThreadRange } from '$lib/editor/comment-overlay';
	import { resolveRoundAnchorPos } from '$lib/editor/diff-overlay';
	import { tooltip } from '$lib/actions/tooltip';
	import type { MaterializedPendingReviewRound } from '$lib/review-rounds';
	import { summarizeRound } from '$lib/review-diff';
	import { isRendering } from '$lib/stores';
	import { authFetch } from '$lib/auth-recovery';

	interface Props {
		threads: CommentThread[];
		/** Pending agent-edit rounds for the active tab. Rendered as edit
		 * cards in the same collision-stacked column as comment threads, each
		 * anchored next to its in-situ diff. */
		rounds: MaterializedPendingReviewRound[];
		/** Document baseline the rounds diff against (reviewBaseline store).
		 * Needed to locate each round's first changed paragraph. */
		baseline: string | null;
		editor: Editor | undefined;
		tabId: string;
		openThreadId: string | null;
		onOpen: (threadId: string) => void;
		onClose: () => void;
		onApprove: (thread: CommentThread, messageId: string) => void;
		/** Fires after a user reply is successfully posted to a thread. Used
		 * by TiptapEditor to wake the agent so it can respond on the same
		 * thread. The thread argument is the *post-reply* state. */
		onReply?: (thread: CommentThread, replyText: string) => void;
		onAcceptRound: (roundId: string) => void;
		onRejectRound: (roundId: string) => void;
		/** Rounds pinned "keep diff visible" (per-thread, via onPinThreadEdits). */
		pinnedRoundIds: Set<string>;
		/** Accept every still-pending edit for one feedback thread at once. */
		onAcceptFeedback: (roundIds: string[]) => void;
		/** Resolve / reopen a thread (undoable; resolving also drops its edits). */
		onResolveThread: (threadId: string, resolved: boolean) => void;
		/** Pin/unpin a whole feedback thread's edits so their diffs stay shown
		 * even when the card is collapsed. */
		onPinThreadEdits: (roundIds: string[], pinned: boolean) => void;
		/** Hover a numbered edit row → flash that edit's diff in the document
		 * (null on mouse-leave). */
		onHoverEdit: (roundId: string | null) => void;
		/** Agent muted: hide the agent's proposal surfaces in the gutter —
		 * standalone edit cards, the edits grouped inside feedback threads, and
		 * any agent-authored comment threads — so muted review is truly quiet.
		 * User-opened comment threads stay. */
		muted: boolean;
		/** Thread id just created by the user's feedback action. When set,
		 * CommentGutter marks it as awaiting the agent's response so the
		 * "Thinking…" indicator appears immediately. */
		newAwaitingThreadId?: string | null;
	}
	let {
		threads,
		rounds,
		baseline,
		editor,
		tabId,
		openThreadId,
		onOpen,
		onClose,
		onApprove,
		onReply,
		onAcceptRound,
		onRejectRound,
		pinnedRoundIds,
		onAcceptFeedback,
		onPinThreadEdits,
		onHoverEdit,
		onResolveThread,
		muted,
		newAwaitingThreadId
	}: Props = $props();

	/** A short one-line snippet — just enough to tell edits apart in the card.
	 * The full (possibly large) diff is shown in the editor, not here. */
	function snippet(s: string, max = 22): string {
		const t = (s ?? '').replace(/\s+/g, ' ').trim();
		return t.length > max ? t.slice(0, max - 1) + '…' : t;
	}

	// ── Group an agent's edits under the feedback thread that triggered them ──
	// Rounds tagged with `feedbackThreadId` matching an open thread are shown
	// INSIDE that thread's card (numbered), not as separate edit cards.
	let openThreadIds = $derived(new Set(threads.filter((t) => !t.resolved).map((t) => t.id)));
	let roundsByThread = $derived.by(() => {
		const m = new Map<string, MaterializedPendingReviewRound[]>();
		for (const r of rounds) {
			const tid = r.feedbackThreadId;
			if (!tid || !openThreadIds.has(tid)) continue;
			const list = m.get(tid);
			if (list) list.push(r);
			else m.set(tid, [r]);
		}
		return m;
	});
	function editsForThread(threadId: string): MaterializedPendingReviewRound[] {
		// Muted: the agent's proposed edits are hidden from the gutter (and the
		// inline diff overlay is hidden too), so the review is quiet.
		if (muted) return [];
		return roundsByThread.get(threadId) ?? [];
	}
	function editCardId(roundId: string): string {
		return `edit:${roundId}`;
	}
	let looseEditRounds = $derived(
		muted
			? []
			: rounds.filter((r) => !r.feedbackThreadId || !openThreadIds.has(r.feedbackThreadId))
	);
	/** A thread the agent opened (first message is the agent's) — hidden in
	 * mute mode. User-opened threads always show. */
	function isAgentThread(thread: CommentThread): boolean {
		return thread.messages[0]?.author === 'agent';
	}

	// Cards that appear during the initial mount / position pass shouldn't
	// animate (that would make every tab switch feel laggy). Only cards that
	// arrive AFTER the gutter has settled get the delayed slide-in — i.e. a
	// genuinely new agent edit or comment.
	let cardsReady = $state(false);
	onMount(() => {
		const t = setTimeout(() => (cardsReady = true), 700);
		return () => clearTimeout(t);
	});
	/** Card entrance: a delayed fly-in (after the in-doc strike sweep) for
	 * newly-arrived cards; instant for the initial render. */
	function cardIn() {
		return cardsReady
			? { x: 12, duration: 360, delay: 560, easing: cubicOut }
			: { duration: 0 };
	}

	let gutterEl: HTMLDivElement | null = $state(null);
	let replyDrafts = $state<Record<string, string>>({});
	let replying = $state<Record<string, boolean>>({});
	/** Threads currently waiting for the agent's response to a just-sent reply.
	 * Set on send; cleared when the agent posts a new message OR a new edit on
	 * the thread (see the $effect below), with a timeout safety net. */
	let awaitingAgent = $state<Record<string, boolean>>({});
	/** Snapshot of the agent messages + edits a thread had when its reply was
	 * sent, so we can detect the agent's NEW response and clear the spinner. */
	const awaitBaseline = new Map<string, { msgIds: Set<string>; roundIds: Set<string> }>();
	const awaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
	function clearAwaiting(threadId: string) {
		if (awaitingAgent[threadId]) awaitingAgent = { ...awaitingAgent, [threadId]: false };
		awaitBaseline.delete(threadId);
		const t = awaitTimers.get(threadId);
		if (t) {
			clearTimeout(t);
			awaitTimers.delete(threadId);
		}
	}
	let renderWasActive = false;
	const unsubscribeRendering = isRendering.subscribe((value) => {
		if (value) {
			renderWasActive = true;
			return;
		}
		if (!renderWasActive) return;
		renderWasActive = false;
		for (const tid of Object.keys(awaitingAgent)) {
			if (awaitingAgent[tid]) clearAwaiting(tid);
		}
	});
	// Clear the waiting indicator as soon as the agent's response lands — a new
	// agent-authored message in the thread, or a new edit grouped under it.
	$effect(() => {
		// Touch reactive inputs so this re-runs when the thread or its edits change.
		threads;
		roundsByThread;
		for (const tid of Object.keys(awaitingAgent)) {
			if (!awaitingAgent[tid]) continue;
			const base = awaitBaseline.get(tid);
			if (!base) continue;
			const thread = threads.find((t) => t.id === tid);
			const newAgentMsg = !!thread?.messages.some(
				(m) => m.author === 'agent' && !base.msgIds.has(m.id)
			);
			const newRound = (roundsByThread.get(tid) ?? []).some((r) => !base.roundIds.has(r.id));
			if (newAgentMsg || newRound) clearAwaiting(tid);
		}
	});
	$effect(() => {
		const tid = newAwaitingThreadId;
		if (!tid) return;
		if (awaitingAgent[tid]) return;
		const thread = threads.find((t) => t.id === tid);
		awaitBaseline.set(tid, {
			msgIds: new Set(
				(thread?.messages ?? []).filter((m) => m.author === 'agent').map((m) => m.id)
			),
			roundIds: new Set((roundsByThread.get(tid) ?? []).map((r) => r.id))
		});
		awaitingAgent = { ...awaitingAgent, [tid]: true };
		const prev = awaitTimers.get(tid);
		if (prev) clearTimeout(prev);
		awaitTimers.set(tid, setTimeout(() => clearAwaiting(tid), 120000));
	});
	onDestroy(() => {
		unsubscribeRendering();
		for (const t of awaitTimers.values()) clearTimeout(t);
		awaitTimers.clear();
	});

	/** Per-thread absolute Y offset inside the gutter column. Computed
	 * from the editor's `coordsAtPos` on the anchored range, then pushed
	 * down when neighbors collide so no two cards overlap. Null for
	 * threads whose anchor quote no longer appears in the doc
	 * (detached — skipped from the gutter entirely). */
	let stackedPositions = $state<Map<string, number>>(new Map());
	/** Actual rendered height per card (by id), measured from the DOM after
	 * each render. The collision stack uses these so an expanded card pushes
	 * the cards below it by its REAL height, not a rough estimate — otherwise
	 * the gap below an expanded card feels wrong. Falls back to the estimate
	 * until a card has been measured once. */
	let cardHeights = $state<Map<string, number>>(new Map());

	const COLLAPSED_H = 54;
	const EXPANDED_H_APPROX = 260;
	const EDIT_COLLAPSED_H = 48;
	const EDIT_EXPANDED_H_APPROX = 180;
	const CARD_GAP = 8;

	function cardHeight(
		kind: 'comment' | 'edit',
		expanded: boolean,
		editCount = 0
	): number {
		if (kind === 'edit') return expanded ? EDIT_EXPANDED_H_APPROX : EDIT_COLLAPSED_H;
		let h = expanded ? EXPANDED_H_APPROX : COLLAPSED_H;
		// A thread with linked edits grows by the numbered edit rows (+ the
		// Accept-all row) when expanded.
		if (expanded && editCount > 0) h += editCount * 66 + 38;
		return h;
	}
	function cardHeightFor(
		id: string,
		kind: 'comment' | 'edit',
		expanded: boolean,
		editCount = 0
	): number {
		return cardHeights.get(id) ?? cardHeight(kind, expanded, editCount);
	}

	let measureQueued = false;
	/** After a render, read each card's real height; if any changed, restack
	 * once with the accurate numbers. Converges in one extra pass. */
	function scheduleMeasure() {
		if (measureQueued) return;
		measureQueued = true;
		requestAnimationFrame(() => {
			measureQueued = false;
			if (!gutterEl) return;
			let changed = false;
			const next = new Map(cardHeights);
			gutterEl.querySelectorAll<HTMLElement>('.gutter-card').forEach((el) => {
				const id = el.dataset.cardId;
				if (!id) return;
				const h = el.offsetHeight;
				if (Math.abs((next.get(id) ?? -1) - h) > 1) {
					next.set(id, h);
					changed = true;
				}
			});
			if (changed) {
				cardHeights = next;
				recomputePositions();
			}
		});
	}

	function recomputePositions() {
		if (!editor || !gutterEl) return;
		const gutterRect = gutterEl.getBoundingClientRect();
		const entries: Array<{
			id: string;
			kind: 'comment' | 'edit';
			top: number;
			expanded: boolean;
			editCount: number;
		}> = [];
		for (const thread of threads) {
			if (thread.resolved) continue;
			if (muted && isAgentThread(thread)) continue;
			const threadEdits = editsForThread(thread.id);
			const editPos =
				baseline && threadEdits.length > 0
					? resolveRoundAnchorPos(editor, threadEdits[0], baseline)
					: null;
			const range = editPos == null ? resolveThreadRange(editor, thread) : null;
			const anchorPos = editPos ?? range?.from ?? null;
			if (anchorPos == null) continue;
			try {
				const coords = editor.view.coordsAtPos(anchorPos);
				entries.push({
					id: thread.id,
					kind: 'comment',
					top: coords.top - gutterRect.top,
					expanded: thread.id === openThreadId,
					editCount: threadEdits.length
				});
			} catch {
				// coordsAtPos throws if the view isn't mounted — skip.
			}
		}
		if (!muted && baseline) {
			for (const round of looseEditRounds) {
				const pos = resolveRoundAnchorPos(editor, round, baseline);
				if (pos == null) continue;
				try {
					const coords = editor.view.coordsAtPos(pos);
					entries.push({
						id: editCardId(round.id),
						kind: 'edit',
						top: coords.top - gutterRect.top,
						expanded: false,
						editCount: 0
					});
				} catch {
					// View not mounted or anchor no longer addressable.
				}
			}
		}
		entries.sort((a, b) => a.top - b.top);
		// Collision stack: each card claims [top, top + height + gap]; if
		// the next card's natural top falls inside that, push it down to
		// sit right below the previous one.
		let runningBottom = -Infinity;
		const next = new Map<string, number>();
		for (const entry of entries) {
			const h = cardHeightFor(entry.id, entry.kind, entry.expanded, entry.editCount);
			const top = Math.max(entry.top, runningBottom);
			next.set(entry.id, top);
			runningBottom = top + h + CARD_GAP;
		}
		stackedPositions = next;
		scheduleMeasure();
	}

	// Recompute whenever threads, the open thread, or the editor content
	// changes. The editor update listener covers user/agent edits that
	// reflow the anchored passages; ResizeObserver covers container
	// resizes (window resize, soft-wrap toggle, font scale).
	let editorUpdateHandler: (() => void) | null = null;
	let resizeObserver: ResizeObserver | null = null;

	$effect(() => {
		if (!editor) return;
		if (!editorUpdateHandler) {
			editorUpdateHandler = () => recomputePositions();
			editor.on('update', editorUpdateHandler);
			editor.on('selectionUpdate', editorUpdateHandler);
		}
		if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => recomputePositions());
			const dom = editor.view.dom as HTMLElement | null;
			if (dom) resizeObserver.observe(dom);
		}
		// Touch reactive inputs so this effect retracks when they change.
		threads;
		openThreadId;
		rounds;
		looseEditRounds;
		baseline;
		muted;
		requestAnimationFrame(() => recomputePositions());
	});

	onDestroy(() => {
		if (editor && editorUpdateHandler) {
			editor.off('update', editorUpdateHandler);
			editor.off('selectionUpdate', editorUpdateHandler);
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
	});

	let visibleThreads = $derived(
		threads
			.filter(
				(t) => !t.resolved && stackedPositions.has(t.id) && !(muted && isAgentThread(t))
			)
			.sort(
				(a, b) =>
					(stackedPositions.get(a.id) ?? 0) - (stackedPositions.get(b.id) ?? 0)
			)
	);
	let visibleLooseEditRounds = $derived(
		looseEditRounds
			.filter((r) => stackedPositions.has(editCardId(r.id)))
			.sort(
				(a, b) =>
					(stackedPositions.get(editCardId(a.id)) ?? 0) -
					(stackedPositions.get(editCardId(b.id)) ?? 0)
			)
	);

	async function sendReply(thread: CommentThread) {
		const text = (replyDrafts[thread.id] ?? '').trim();
		if (!text || replying[thread.id]) return;
		replying = { ...replying, [thread.id]: true };
		try {
			const res = await authFetch('/api/comments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: 'reply', tabId, threadId: thread.id, message: text })
			});
			if (!res.ok) throw new Error(await res.text());
			replyDrafts = { ...replyDrafts, [thread.id]: '' };
			// Snapshot what the thread had BEFORE the agent responds, so the
			// $effect can detect the agent's new message/edit and clear the
			// waiting indicator. Timeout is a safety net if the agent stays
			// silent (no comment, no edit).
			awaitBaseline.set(thread.id, {
				msgIds: new Set(thread.messages.filter((m) => m.author === 'agent').map((m) => m.id)),
				roundIds: new Set((roundsByThread.get(thread.id) ?? []).map((r) => r.id))
			});
			awaitingAgent = { ...awaitingAgent, [thread.id]: true };
			const prev = awaitTimers.get(thread.id);
			if (prev) clearTimeout(prev);
			awaitTimers.set(
				thread.id,
				setTimeout(() => clearAwaiting(thread.id), 120000)
			);
			// Wake the agent so it can respond on this thread. Pass the
			// post-reply thread state so the parent has the full transcript
			// (including the just-posted user message) for the trigger.
			onReply?.(thread, text);
		} catch (e) {
			console.error('Failed to post reply:', e);
		} finally {
			replying = { ...replying, [thread.id]: false };
		}
	}

	function toggleResolved(thread: CommentThread) {
		const next = !thread.resolved;
		// Resolving also drops the thread's pending edits, and the whole action
		// is applied locally with USER_ORIGIN by the parent so ctrl+z reopens
		// the thread and brings its edits back in one step.
		onResolveThread(thread.id, next);
		if (next) {
			clearAwaiting(thread.id);
			onClose();
		}
	}

	function formatTimestamp(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function firstMessageAuthor(thread: CommentThread): 'agent' | 'user' | null {
		const first = thread.messages[0];
		return first ? first.author : null;
	}
	function firstMessageBody(thread: CommentThread): string {
		const first = thread.messages[0];
		if (!first) return '';
		const body = first.text.replace(/\n+/g, ' ').replace(/[*_`]/g, '');
		return body.length > 90 ? body.slice(0, 87) + '…' : body;
	}
</script>

<div class="comment-gutter" bind:this={gutterEl}>
	{#each visibleThreads as thread (thread.id)}
		{@const isOpen = thread.id === openThreadId}
		{@const top = stackedPositions.get(thread.id) ?? 0}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gutter-card"
			class:expanded={isOpen}
			data-card-id={thread.id}
			style:top="{top}px"
			in:fly={cardIn()}
			onclick={(e) => {
				if (isOpen) return;
				e.stopPropagation();
				onOpen(thread.id);
			}}
		>
			{#if isOpen}
				{@const tEdits = editsForThread(thread.id)}
				{#if tEdits.length > 0}
					<span
						class="pin-corner"
						use:tooltip={tEdits.every((e) => pinnedRoundIds.has(e.id))
							? 'Diffs stay shown in the document even when this card is collapsed. Turn off to hide them unless the card is open.'
							: "Keep these edits' diffs shown in the document even when this card is collapsed."}
					>
						<input
							type="checkbox"
							class="pin-switch"
							aria-label="Keep diffs shown in document"
							checked={tEdits.every((e) => pinnedRoundIds.has(e.id))}
							onclick={(e) => e.stopPropagation()}
							onchange={(e) =>
								onPinThreadEdits(
									tEdits.map((x) => x.id),
									(e.currentTarget as HTMLInputElement).checked
								)}
						/>
					</span>
				{/if}
				<div class="card-messages">
					{#each thread.messages as message (message.id)}
						<div class="message" class:from-agent={message.author === 'agent'} class:from-user={message.author === 'user'}>
							<span class="author">
								<span
									class="avatar small"
									class:avatar-agent={message.author === 'agent'}
									class:avatar-user={message.author !== 'agent'}
								>
									{#if message.author === 'agent'}
										<Cat size={11} strokeWidth={1.8} />
									{:else}
										<User size={11} strokeWidth={1.8} />
									{/if}
								</span>
								<span class="author-name">{message.author === 'agent' ? 'Agent' : 'You'}</span>
							</span>
							<span class="timestamp">{formatTimestamp(message.timestamp)}</span>
							<div class="message-body">{@html renderMarkdown(message.text)}</div>
							{#if message.author === 'agent' && message.proposedEdit}
								<button
									class="approve-btn"
									onclick={() => onApprove(thread, message.id)}
								>
									<Sparkles size={11} />
									Approve & propose edit
								</button>
							{/if}
						</div>
					{/each}
				</div>
				{#if awaitingAgent[thread.id]}
					<div class="awaiting-agent">
						<span class="awaiting-dots"><span></span><span></span><span></span></span>
						<span>Thinking…</span>
					</div>
				{/if}
				{@const edits = editsForThread(thread.id)}
				{#if edits.length > 0}
					{@const allPinned = edits.every((e) => pinnedRoundIds.has(e.id))}
					<div class="thread-edits">
						<div class="thread-edits-head">
							<span class="edit-kicker">
								{edits.length} proposed edit{edits.length === 1 ? '' : 's'}
							</span>
							{#if edits.length > 1}
								<button
									class="accept-all-btn"
									onclick={() => onAcceptFeedback(edits.filter((e) => !e.stale).map((e) => e.id))}
								>
									<Check size={11} /> Accept all
								</button>
							{/if}
						</div>
						{#each edits as ed, i (ed.id)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="thread-edit-row"
								class:stale={ed.stale}
								onmouseenter={() => onHoverEdit(ed.id)}
								onmouseleave={() => onHoverEdit(null)}
							>
								<span class="edit-num">{i + 1}</span>
								<span
									class="edit-row-summary"
									title={ed.operation?.type === 'edit'
										? `${ed.operation.oldString} → ${ed.operation.newString}`
										: summarizeRound(ed)}
								>
									{#if ed.operation?.type === 'edit'}
										<span class="er-old">{snippet(ed.operation.oldString)}</span>
										<span class="er-arrow">→</span>
										<span class="er-new">{snippet(ed.operation.newString)}</span>
									{:else}
										{summarizeRound(ed)}
									{/if}
								</span>
								<span class="edit-row-actions">
									<button class="mini-btn reject" title="Reject this edit" onclick={() => onRejectRound(ed.id)}>
										<X size={12} />
									</button>
									<button
										class="mini-btn accept"
										title={ed.stale ? 'Stale — can no longer apply' : 'Accept this edit'}
										disabled={ed.stale}
										onclick={() => onAcceptRound(ed.id)}
									>
										<Check size={12} />
									</button>
								</span>
							</div>
						{/each}
					</div>
				{/if}
				<textarea
					class="reply-input"
					placeholder="Reply…"
					rows="2"
					value={replyDrafts[thread.id] ?? ''}
					oninput={(e) => {
						replyDrafts = {
							...replyDrafts,
							[thread.id]: (e.currentTarget as HTMLTextAreaElement).value
						};
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void sendReply(thread);
						}
						if (e.key === 'Escape') onClose();
					}}
				></textarea>
				<div class="card-actions">
					<button
						class="resolve-link"
						onclick={() => toggleResolved(thread)}
						title={thread.resolved
							? 'Re-open this thread (it will appear in the agent prompt again)'
							: 'Mark this thread done. It stops being inlined into the agent prompt.'}
					>
						{thread.resolved ? 'Reopen' : 'Resolve'}
					</button>
					<div class="card-actions-right">
						<button
							class="send-btn"
							onclick={() => sendReply(thread)}
							disabled={replying[thread.id] || !(replyDrafts[thread.id] ?? '').trim()}
						>
							<Send size={11} />
							Send
						</button>
					</div>
				</div>
			{:else}
				<div class="card-collapsed-row">
					<span
						class="avatar"
						class:avatar-agent={firstMessageAuthor(thread) === 'agent'}
						class:avatar-user={firstMessageAuthor(thread) !== 'agent'}
					>
						{#if firstMessageAuthor(thread) === 'agent'}
							<Cat size={12} strokeWidth={1.8} />
						{:else}
							<User size={12} strokeWidth={1.8} />
						{/if}
					</span>
					<div class="card-preview" title={firstMessageBody(thread)}>
						{firstMessageBody(thread)}
					</div>
					{#if editsForThread(thread.id).length > 0}
						<span class="edit-pill" title="{editsForThread(thread.id).length} proposed edit(s)">
							<Sparkles size={9} />{editsForThread(thread.id).length}
						</span>
					{:else if thread.messages.length > 1}
						<span class="card-count">{thread.messages.length}</span>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
	{#each visibleLooseEditRounds as round (round.id)}
		{@const top = stackedPositions.get(editCardId(round.id)) ?? 0}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gutter-card loose-edit-card"
			class:stale={round.stale}
			data-card-id={editCardId(round.id)}
			style:top="{top}px"
			in:fly={cardIn()}
			onmouseenter={() => onHoverEdit(round.id)}
			onmouseleave={() => onHoverEdit(null)}
		>
			<div class="card-collapsed-row">
				<span class="avatar avatar-agent">
					<Sparkles size={12} strokeWidth={1.8} />
				</span>
				<div class="card-preview" title={summarizeRound(round)}>
					{summarizeRound(round)}
				</div>
				<span class="edit-row-actions">
					<button class="mini-btn reject" title="Reject this edit" onclick={() => onRejectRound(round.id)}>
						<X size={12} />
					</button>
					<button
						class="mini-btn accept"
						title={round.stale ? 'Stale — can no longer apply' : 'Accept this edit'}
						disabled={round.stale}
						onclick={() => onAcceptRound(round.id)}
					>
						<Check size={12} />
					</button>
				</span>
			</div>
		</div>
	{/each}
</div>

<style>
	.comment-gutter {
		position: relative;
		flex-shrink: 0;
		/* Reads `--gutter-width` from +page.svelte. */
		width: var(--gutter-width, 240px);
		min-width: var(--gutter-width, 240px);
		max-width: var(--gutter-width, 240px);
		height: 100%;
		/* Extra bottom room so the lowest card can sit clear of the fixed
		 * agent dock (AgentDockShell publishes its height as the var). */
		padding: 0 10px calc(20px + var(--dock-reserved-bottom, 0px));
		box-sizing: border-box;
		overflow: visible;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.gutter-card {
		position: absolute;
		left: 10px;
		right: 10px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		padding: 9px 11px;
		font-size: 12.5px;
		color: var(--text);
		cursor: pointer;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		transition: box-shadow 0.12s ease, border-color 0.12s ease;
		z-index: 1;
	}
	.gutter-card:hover {
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
	}
	.gutter-card.expanded {
		cursor: default;
		z-index: 2;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.13), 0 2px 6px rgba(0, 0, 0, 0.05);
		border-color: color-mix(in srgb, var(--text) 14%, var(--border-light));
		padding: 13px 14px;
	}
	/* Circular avatars carry the only color on the card (Google-Docs style):
	 * the card itself stays a neutral white sheet. */
	.avatar {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
	}
	.avatar.small {
		width: 18px;
		height: 18px;
	}
	.avatar-agent {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--accent);
	}
	.avatar-user {
		background: color-mix(in srgb, #3b82f6 16%, transparent);
		color: #2563eb;
	}
	.card-collapsed-row {
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
	}
	.card-preview {
		flex: 1;
		min-width: 0;
		font-size: 12.5px;
		color: var(--text);
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card-count {
		flex-shrink: 0;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-faint);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		padding: 0 6px;
		border-radius: 9px;
	}
	.card-messages {
		max-height: 260px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		/* Room at the top-right for the keep-shown toggle (pin-corner) so it
		 * doesn't sit on the first message's timestamp. */
		padding-right: 40px;
	}
	/* "Agent is responding…" — shown after sending a reply until the agent
	 * posts a new message or edit (or the safety timeout fires). */
	.awaiting-agent {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--text-faint);
		font-style: italic;
	}
	.awaiting-dots {
		display: inline-flex;
		gap: 3px;
	}
	.awaiting-dots span {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--accent, #6366f1);
		opacity: 0.4;
		animation: awaitingDotBounce 1.2s ease-in-out infinite;
	}
	.awaiting-dots span:nth-child(2) {
		animation-delay: 0.15s;
	}
	.awaiting-dots span:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes awaitingDotBounce {
		0%, 100% { opacity: 0.3; transform: translateY(0); }
		50% { opacity: 0.9; transform: translateY(-2px); }
	}
	/* Per-message: clear author distinction via left-accent + author
	 * color. No nested box; body sits directly in the card. User is
	 * blue-ish (cool), agent is amber (warm) to match the thread's
	 * comment color and the pill in the text. */
	.message {
		display: grid;
		grid-template-columns: auto 1fr auto;
		column-gap: 6px;
		padding-left: 8px;
		border-left: 2px solid var(--border-light);
	}
	.message.from-user {
		border-left-color: color-mix(in srgb, #3b82f6 60%, transparent);
	}
	.message.from-agent {
		border-left-color: color-mix(in srgb, #f59e0b 70%, transparent);
	}
	.author {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text);
	}
	.timestamp {
		font-size: 10.5px;
		color: var(--text-faint);
		grid-column: 3;
	}
	.message-body {
		grid-column: 1 / 4;
		margin-top: 2px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text);
		word-break: break-word;
	}
	.message-body :global(strong) {
		font-weight: 600;
	}
	.message-body :global(em) {
		font-style: italic;
	}
	.message-body :global(code) {
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 11.5px;
		background: var(--bg-surface);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.message-body :global(.md-bullet)::before {
		content: '• ';
	}
	.message-body :global(.md-bullet) {
		display: block;
	}
	.approve-btn {
		grid-column: 1 / 4;
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 5px;
		padding: 3px 7px;
		font: inherit;
		font-size: 10.5px;
		font-weight: 500;
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
		border-radius: 4px;
		cursor: pointer;
	}
	.approve-btn:hover {
		background: color-mix(in srgb, var(--accent) 88%, black);
	}
	.reply-input {
		resize: none;
		width: 100%;
		box-sizing: border-box;
		margin-top: 10px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 5px;
		padding: 5px 7px;
		outline: none;
	}
	.reply-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-bg);
	}
	.card-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 7px;
	}
	.card-actions-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	/* Text-style buttons for secondary actions (Resolve, Close) — no
	 * border, just a link-y color. Keeps the card from stacking more
	 * boxed UI. */
	.resolve-link {
		font: inherit;
		font-size: 11.5px;
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
	}
	.resolve-link:hover:not(:disabled) {
		color: var(--text);
		background: var(--bg-hover);
	}
	.resolve-link:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.send-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
	}
	.send-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 88%, black);
	}
	.send-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.edit-kicker {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent);
	}
	.pin-corner {
		position: absolute;
		top: 12px;
		right: 13px;
		display: inline-flex;
		align-items: center;
		z-index: 1;
	}
	/* A compact iOS-style switch built from the checkbox. */
	.pin-switch {
		appearance: none;
		-webkit-appearance: none;
		position: relative;
		flex-shrink: 0;
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text) 22%, transparent);
		cursor: pointer;
		transition: background 0.15s ease;
		margin: 0;
	}
	.pin-switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #fff;
		transition: transform 0.15s ease;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
	}
	.pin-switch:checked {
		background: var(--accent);
	}
	.pin-switch:checked::after {
		transform: translateX(12px);
	}
	/* ── Edits grouped inside a feedback thread card ──────────────────── */
	.edit-pill {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		font-weight: 600;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		padding: 1px 6px 1px 5px;
		border-radius: 8px;
	}
	.thread-edits {
		margin-top: 11px;
		padding-top: 10px;
		border-top: 1px solid var(--border-light);
	}
	.thread-edits-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
	}
	.er-old {
		color: #b91c1c;
		text-decoration: line-through;
		text-decoration-thickness: 1px;
	}
	.er-arrow {
		color: var(--text-faint);
		margin: 0 3px;
	}
	.er-new {
		color: #047857;
	}
	.thread-edit-row.stale .er-old,
	.thread-edit-row.stale .er-new {
		color: var(--text-faint);
	}
	.accept-all-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		font: inherit;
		font-size: 11px;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
		background: var(--accent);
		color: #fff;
		border: 1px solid var(--accent);
		white-space: nowrap;
		flex-shrink: 0;
	}
	.accept-all-btn:hover {
		background: color-mix(in srgb, var(--accent) 88%, black);
	}
	.thread-edit-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 6px;
		margin: 0 -6px;
		border-radius: 6px;
		cursor: default;
		transition: background 0.1s ease;
	}
	.thread-edit-row:hover {
		background: color-mix(in srgb, var(--accent) 9%, transparent);
	}
	.thread-edit-row + .thread-edit-row {
		border-top: 1px solid color-mix(in srgb, var(--text) 6%, transparent);
	}
	.edit-num {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent);
		font-size: 10.5px;
		font-weight: 600;
	}
	.edit-row-summary {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.thread-edit-row.stale .edit-row-summary {
		color: var(--text-faint);
		text-decoration: line-through;
	}
	.edit-row-actions {
		flex-shrink: 0;
		display: inline-flex;
		gap: 4px;
	}
	.mini-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 5px;
		cursor: pointer;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text);
	}
	.mini-btn.accept {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.mini-btn.accept:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 88%, black);
	}
	.mini-btn.accept:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.mini-btn.reject:hover {
		background: var(--bg-hover);
		border-color: color-mix(in srgb, #ef4444 40%, var(--border-light));
	}
</style>
