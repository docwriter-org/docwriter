<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { Send, Cat, Check, Copy, X, User, MessageSquare } from 'lucide-svelte';
	import { isModEnter, modEnterToSend } from '$lib/keyboard';

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
	import { get } from 'svelte/store';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { CommentMessage, CommentThread } from '$lib/types';
	import type { ThreadMarkSummary } from '$lib/shared/proposals';
	import { firstThreadPos } from '$lib/editor/thread-overlay';
	import { tooltip } from '$lib/actions/tooltip';
	import { commentReplyDrafts, isRendering, customReviewers } from '$lib/stores';
	import { BUILTIN_REVIEWERS, type Reviewer } from '$lib/shared/reviewers';
	import ReviewerMascot from '$lib/components/ReviewerMascot.svelte';

	interface Props {
		threads: CommentThread[];
		/** The marks each thread holds on this tab: whether it carries a
		 * proposal, and the before / after text of each paragraph it changes.
		 * The proposal itself is tracked changes in the document. */
		marks: ThreadMarkSummary[];
		editor: Editor | undefined;
		tabId: string;
		openThreadId: string | null;
		onOpen: (threadId: string) => void;
		onClose: () => void;
		/** Fires after a user reply is successfully posted to a thread. Used
		 * by TiptapEditor to wake the agent so it can respond on the same
		 * thread. The thread argument is the *post-reply* state. */
		onReply?: (thread: CommentThread, replyText: string) => void;
		/** Accept / reject the proposal a thread holds. */
		onAccept: (threadId: string) => void;
		onReject: (threadId: string) => void;
		/** Accept / reject every proposal on this tab. */
		onAcceptAll?: () => void;
		onRejectAll?: () => void;
		/** Dismiss / reopen a thread (undoable; dismissing also drops its proposal). */
		onResolveThread: (threadId: string, resolved: boolean) => void;
		/** Agent muted: hide the agent's own threads from the gutter so muted
		 * review is quiet. User-opened comment threads stay. */
		muted: boolean;
		/** Thread id just created by the user's feedback action. When set,
		 * CommentGutter marks it as awaiting the agent's response so the
		 * "Thinking…" indicator appears immediately. */
		newAwaitingThreadId?: string | null;
	}
	let {
		threads,
		marks,
		editor,
		tabId,
		openThreadId,
		onOpen,
		onClose,
		onReply,
		onAccept,
		onReject,
		onAcceptAll,
		onRejectAll,
		onResolveThread,
		muted,
		newAwaitingThreadId
	}: Props = $props();

	/** Offset of the batch bar from the top of the gutter (mirrors its
	 * `top`). Its height is measured rather than assumed: the bar wraps to a
	 * second row in a narrow gutter with a large count, and a hard-coded
	 * height would let the first card slide under it. */
	const BATCH_BAR_TOP = 6;
	let batchBarHeight = $state(0);

	let markById = $derived(new Map(marks.map((m) => [m.threadId, m])));
	let openThreadIds = $derived(new Set(threads.filter((t) => !t.resolved).map((t) => t.id)));
	/** A thread the agent opened (first message is the agent's) — hidden in
	 * mute mode. User-opened threads always show. */
	function isAgentThread(thread: CommentThread): boolean {
		return thread.messages[0]?.author === 'agent';
	}
	function threadShown(thread: CommentThread): boolean {
		return !thread.resolved && !(muted && isAgentThread(thread));
	}
	/** The proposal a thread holds, if it holds one and its card is shown. */
	function proposalFor(threadId: string): ThreadMarkSummary | null {
		const m = markById.get(threadId);
		return m && m.hasProposal ? m : null;
	}
	let proposalCount = $derived(
		threads.filter((t) => threadShown(t) && proposalFor(t.id)).length
	);
	/** The batch bar earns its place only from two proposals up: a single
	 * card already carries its own Accept and Reject, so "Accept all (1)"
	 * above it is a second button for the same action. */
	let showBatchBar = $derived(!muted && proposalCount > 1 && !!(onAcceptAll || onRejectAll));

	/** A short one-line snippet — just enough to tell changes apart in the
	 * card. The full change is tracked in the document, not here. */
	function snippet(s: string, max = 26): string {
		const t = (s ?? '').replace(/\s+/g, ' ').trim();
		if (!t) return '(empty line)';
		return t.length > max ? t.slice(0, max - 1) + '…' : t;
	}
	/** A string that changes whenever the thread's proposal changes. */
	function fingerprint(summary: ThreadMarkSummary | null | undefined): string | null {
		if (!summary?.hasProposal) return null;
		return summary.changes.map((c) => `${c.para}:${c.before}\0${c.after}`).join('\x01');
	}
	/** Copy a thread's full proposed text — the user may want the agent's
	 * wording (or part of it) without accepting the edit. */
	async function copyProposedText(summary: ThreadMarkSummary): Promise<void> {
		const text = summary.changes.map((c) => c.after).join('\n');
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* clipboard permission denied; nothing sensible to do */
		}
	}

	/** Cards whose thread no longer holds any mark (its passage was deleted
	 * around it), pinned at the top of the gutter by the layout effect. The
	 * card says so, because a card far from any text otherwise reads as a
	 * bug. */
	let parkedIds = $state<Set<string>>(new Set());

	// ── Reviewer attribution ──────────────────────────────────────────────
	// Messages created during a critique pass carry a `reviewerId`; render
	// the reviewer's mascot + name in place of the default agent cat.
	// Unknown ids (a deleted custom reviewer) fall back to the plain agent
	// style.
	let reviewerById = $derived(
		new Map<string, Reviewer>(
			[...BUILTIN_REVIEWERS, ...$customReviewers].map((r) => [r.id, r])
		)
	);
	function messageReviewer(message: CommentMessage | undefined): Reviewer | null {
		if (!message?.reviewerId) return null;
		return reviewerById.get(message.reviewerId) ?? null;
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
	/** Card entrance: a delayed fly-in for newly-arrived cards; instant for
	 * the initial render. */
	function cardIn() {
		return cardsReady
			? { x: 12, duration: 360, delay: 260, easing: cubicOut }
			: { duration: 0 };
	}

	let gutterEl: HTMLDivElement | null = $state(null);
	let replyDrafts = $state<Record<string, string>>({});
	const unsubscribeReplyDrafts = commentReplyDrafts.subscribe((v) => (replyDrafts = v));
	let replying = $state<Record<string, boolean>>({});
	/** Threads currently waiting for the agent's response to a just-sent reply.
	 * Set on send; cleared when the agent posts a new message OR a new
	 * proposal on the thread (see the $effect below), with a timeout safety
	 * net. */
	let awaitingAgent = $state<Record<string, boolean>>({});
	/** Snapshot of the agent messages + proposal a thread had when its reply
	 * was sent, so we can detect the agent's NEW response and clear the
	 * spinner. */
	const awaitBaseline = new Map<string, { msgIds: Set<string>; proposal: string | null }>();
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
	function startAwaiting(threadId: string) {
		const thread = threads.find((t) => t.id === threadId);
		awaitBaseline.set(threadId, {
			msgIds: new Set(
				(thread?.messages ?? []).filter((m) => m.author === 'agent').map((m) => m.id)
			),
			proposal: fingerprint(markById.get(threadId))
		});
		awaitingAgent = { ...awaitingAgent, [threadId]: true };
		const prev = awaitTimers.get(threadId);
		if (prev) clearTimeout(prev);
		awaitTimers.set(threadId, setTimeout(() => clearAwaiting(threadId), 120000));
	}
	/** Scroll the editor so a card is not hidden under the fixed agent dock.
	 * The dock floats over the lower part of the gutter column, so a card
	 * anchored to a passage in the lower half of the view — or the proposal
	 * section and reply box of an open card — can sit fully behind it while
	 * every other signal (the agent's log entry, the tab badge) says a
	 * proposal is there. Runs after layout settles. */
	function revealCard(cardId: string) {
		if (typeof window === 'undefined' || editor?.isFocused) return;
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (!gutterEl) return;
				const el = gutterEl.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`);
				const wrapper = gutterEl.closest<HTMLElement>('.tiptap-wrapper');
				if (!el || !wrapper) return;
				const reserved =
					parseFloat(
						getComputedStyle(document.documentElement).getPropertyValue('--dock-reserved-bottom')
					) || 0;
				const wrapperRect = wrapper.getBoundingClientRect();
				const dockTop = window.innerHeight - reserved;
				const visibleBottom = Math.min(wrapperRect.bottom, dockTop);
				const rect = el.getBoundingClientRect();
				if (rect.bottom > visibleBottom && rect.height < visibleBottom - wrapperRect.top) {
					wrapper.scrollTop += rect.bottom - visibleBottom + 12;
				} else if (rect.top < wrapperRect.top) {
					wrapper.scrollTop -= wrapperRect.top - rect.top + 12;
				}
			})
		);
	}
	// An open card must be readable end to end: its proposal section and
	// reply box sit below the messages, which is exactly the part the dock
	// covers. The open id can precede its thread: a comment the author just
	// made is opened before the server's thread syncs back, so the reveal
	// waits for the thread and runs once per opening.
	let revealedOpenId: string | null = null;
	$effect(() => {
		if (!openThreadId) {
			revealedOpenId = null;
			return;
		}
		if (revealedOpenId === openThreadId) return;
		if (!threads.some((t) => t.id === openThreadId)) return;
		revealedOpenId = openThreadId;
		revealCard(openThreadId);
	});

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
	// Clear the waiting indicator when the agent's proposal lands on the
	// thread. While a render is active, an agent *message* alone doesn't
	// clear: the agent replies first (explanation), then calls edit_doc (the
	// proposal). Clearing on the reply hides the spinner while the edit is
	// still in flight. The render-end handler (above) sweeps any remaining.
	$effect(() => {
		threads;
		markById;
		const rendering = get(isRendering);
		for (const tid of Object.keys(awaitingAgent)) {
			if (!awaitingAgent[tid]) continue;
			const base = awaitBaseline.get(tid);
			if (!base) continue;
			const thread = threads.find((t) => t.id === tid);
			const newAgentMsg = !!thread?.messages.some(
				(m) => m.author === 'agent' && !base.msgIds.has(m.id)
			);
			const current = fingerprint(markById.get(tid));
			const newProposal = current !== null && current !== base.proposal;
			if (newProposal) {
				clearAwaiting(tid);
				revealCard(tid);
			} else if (newAgentMsg && !rendering) {
				clearAwaiting(tid);
			}
		}
	});
	// A proposal that lands on a thread the author is not looking at (the
	// agent opened its own announce thread instead of using the feedback
	// thread) stacks below the open card, where the dock hides it. Bring it
	// into view when it arrives during a turn the author is waiting on.
	const seenProposals = new Map<string, string>();
	let seenProposalsPrimed = false;
	$effect(() => {
		const current = marks;
		if (!seenProposalsPrimed) {
			for (const m of current) if (m.hasProposal) seenProposals.set(m.threadId, fingerprint(m) ?? '');
			seenProposalsPrimed = true;
			return;
		}
		const waiting = Object.values(awaitingAgent).some(Boolean);
		for (const m of current) {
			if (!m.hasProposal) continue;
			const fp = fingerprint(m) ?? '';
			if (seenProposals.get(m.threadId) === fp) continue;
			seenProposals.set(m.threadId, fp);
			if (!waiting || awaitingAgent[m.threadId]) continue;
			if (document.activeElement instanceof HTMLTextAreaElement) continue;
			if (openThreadIds.has(m.threadId)) revealCard(m.threadId);
		}
	});
	$effect(() => {
		const tid = newAwaitingThreadId;
		if (!tid) return;
		if (awaitingAgent[tid]) return;
		startAwaiting(tid);
	});
	onDestroy(() => {
		// Flush whatever is still in the open reply box — some input
		// paths (IME, automation) update the textarea without oninput.
		if (gutterEl) {
			const flushed = { ...get(commentReplyDrafts) };
			gutterEl
				.querySelectorAll<HTMLTextAreaElement>('textarea.reply-input[data-thread-id]')
				.forEach((el) => {
					const id = el.dataset.threadId;
					if (id) flushed[id] = el.value;
				});
			commentReplyDrafts.set(flushed);
		}
		unsubscribeRendering();
		unsubscribeReplyDrafts();
		for (const t of awaitTimers.values()) clearTimeout(t);
		awaitTimers.clear();
	});

	/** Per-thread absolute Y offset inside the gutter column. Computed
	 * from the editor's `coordsAtPos` on the thread's first mark, then
	 * pushed down when neighbors collide so no two cards overlap. */
	let stackedPositions = $state<Map<string, number>>(new Map());
	/** Actual rendered height per card (by id), measured from the DOM after
	 * each render. The collision stack uses these so an expanded card pushes
	 * the cards below it by its REAL height, not a rough estimate — otherwise
	 * the gap below an expanded card feels wrong. Falls back to the estimate
	 * until a card has been measured once. */
	let cardHeights = $state<Map<string, number>>(new Map());

	const EXPANDED_H_APPROX = 260;
	const CARD_GAP = 8;

	function cardHeight(changeCount = 0): number {
		let h = EXPANDED_H_APPROX;
		// A thread with a proposal grows by the change rows (+ the actions
		// row) when expanded.
		if (changeCount > 0) h += changeCount * 44 + 38;
		return h;
	}
	function cardHeightFor(id: string, changeCount = 0): number {
		return cardHeights.get(id) ?? cardHeight(changeCount);
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
		const entries: Array<{ id: string; top: number; changeCount: number }> = [];
		const parked: Array<{ id: string; changeCount: number }> = [];
		for (const thread of threads) {
			if (!threadShown(thread)) continue;
			const changeCount = thread.id === openThreadId ? proposalFor(thread.id)?.changes.length ?? 0 : 0;
			const anchorPos = firstThreadPos(editor.state.doc, thread.id);
			if (anchorPos == null) {
				// No mark left (neighboring accept wiped it, external edit) —
				// park the card at the top so the thread stays visible and
				// dismissable. A skipped card would leave actionable state
				// with no UI at all.
				parked.push({ id: thread.id, changeCount });
				continue;
			}
			try {
				let coords = editor.view.coordsAtPos(anchorPos, -1);
				// A folded insertion can have no DOM rectangle. Anchor its
				// card at the surrounding text instead of the viewport top.
				if (coords.top === 0 && coords.bottom === 0) {
					const anchor = editor.state.doc.resolve(anchorPos);
					if (anchor.depth > 0) coords = editor.view.coordsAtPos(anchor.before(1), -1);
				}
				entries.push({ id: thread.id, top: coords.top - gutterRect.top, changeCount });
			} catch {
				// coordsAtPos throws if the view isn't mounted — skip.
			}
		}
		entries.sort((a, b) => a.top - b.top);
		parkedIds = new Set(parked.map((c) => c.id));
		// Collision stack: each card claims [top, top + height + gap]; if
		// the next card's natural top falls inside that, push it down to
		// sit right below the previous one. Reserve room for the batch bar.
		// Parked cards sit at the top so they stay clickable.
		let runningBottom = showBatchBar ? BATCH_BAR_TOP + batchBarHeight + CARD_GAP : -Infinity;
		const next = new Map<string, number>();
		for (const card of parked) {
			const h = cardHeightFor(card.id, card.changeCount);
			const top = Math.max(0, runningBottom);
			next.set(card.id, top);
			runningBottom = top + h + CARD_GAP;
		}
		for (const entry of entries) {
			const h = cardHeightFor(entry.id, entry.changeCount);
			const top = Math.max(entry.top, runningBottom);
			next.set(entry.id, top);
			runningBottom = top + h + CARD_GAP;
		}
		stackedPositions = next;
		scheduleMeasure();
	}

	// Recompute whenever threads, the open thread, or the editor content
	// changes. The editor update listener covers user/agent edits that
	// reflow the marked passages; ResizeObserver covers container
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
		marks;
		muted;
		showBatchBar;
		batchBarHeight;
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
			.filter((t) => threadShown(t) && stackedPositions.has(t.id))
			.sort(
				(a, b) =>
					(stackedPositions.get(a.id) ?? 0) - (stackedPositions.get(b.id) ?? 0)
			)
	);

	// Keep the newest message visible: attached to the open card's message
	// list (use:followNewMessages). The list is capped in height and
	// scrolls, so a card opens showing its END — the latest reply and the
	// proposal section below it — not the oldest message; a long first
	// comment (a reviewer's paragraph) used to fill the whole box and hide
	// the agent's answer and the proposal. The open-time scroll is instant;
	// growth after that (a reply syncing back, the agent's response,
	// messages that arrived while the card was closed) scrolls smoothly.
	const seenMsgCounts = new Map<string, number>();
	function followNewMessages(node: HTMLElement, params: { id: string; count: number }) {
		const track = ({ id, count }: { id: string; count: number }) => {
			const prev = seenMsgCounts.get(id);
			seenMsgCounts.set(id, count);
			if (prev === undefined) {
				// First open: jump to the bottom so the latest message is visible.
				requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
			} else if (count > prev) {
				requestAnimationFrame(() =>
					node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
				);
			}
		};
		track(params);
		requestAnimationFrame(() => {
			node.scrollTop = node.scrollHeight;
		});
		return { update: track };
	}

	async function sendReply(thread: CommentThread) {
		const text = (replyDrafts[thread.id] ?? '').trim();
		if (!text || replying[thread.id]) return;
		replying = { ...replying, [thread.id]: true };
		try {
			const res = await fetch('/api/comments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: 'reply', tabId, threadId: thread.id, message: text })
			});
			if (!res.ok) throw new Error(await res.text());
			commentReplyDrafts.update((d) => ({ ...d, [thread.id]: '' }));
			// Snapshot what the thread had BEFORE the agent responds, so the
			// $effect can detect the agent's new message / proposal and clear
			// the waiting indicator. Timeout is a safety net if the agent stays
			// silent (no comment, no edit).
			startAwaiting(thread.id);
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
		// Dismissing also drops the thread's proposal, and the whole action
		// is applied locally with USER_ORIGIN by the parent so ctrl+z reopens
		// the thread and brings its marks back in one step.
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


</script>

<div class="comment-gutter" bind:this={gutterEl}>
	{#if showBatchBar}
		<div class="gutter-batch-bar" bind:clientHeight={batchBarHeight}>
			<button
				class="batch-btn reject"
				type="button"
				onclick={() => onRejectAll?.()}
				disabled={!onRejectAll}
				use:tooltip={`Reject all ${proposalCount} pending proposals`}
			>
				<X size={11} /> Reject all ({proposalCount})
			</button>
			<button
				class="batch-btn accept"
				type="button"
				onclick={() => onAcceptAll?.()}
				disabled={!onAcceptAll}
				use:tooltip={`Accept all ${proposalCount} pending proposals`}
			>
				<Check size={11} /> Accept all ({proposalCount})
			</button>
		</div>
	{/if}
	{#each visibleThreads as thread (thread.id)}
		{@const top = stackedPositions.get(thread.id) ?? 0}
		{@const proposal = proposalFor(thread.id)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gutter-card expanded"
			onfocusin={() => onOpen(thread.id)}
			data-card-id={thread.id}
			style:top="{top}px"
			in:fly={cardIn()}
			onclick={(e) => {
				if (thread.id === openThreadId) return;
				e.stopPropagation();
				onOpen(thread.id);
			}}
		>
			{#if parkedIds.has(thread.id)}
				<div class="parked-note">This passage is no longer in the document.</div>
			{/if}
			<div
				class="card-messages"
				use:followNewMessages={{ id: thread.id, count: thread.messages.length }}
			>
				{#each thread.messages as message (message.id)}
					{@const rv = message.author === 'agent' ? messageReviewer(message) : null}
					<div class="message" class:from-agent={message.author === 'agent'} class:from-user={message.author === 'user'} class:from-external={message.author === 'external'}>
						<span
							class="avatar msg"
							class:avatar-agent={message.author === 'agent'}
							class:avatar-user={message.author === 'user'}
							class:avatar-external={message.author === 'external'}
							style:color={rv?.color}
						>
							{#if message.author === 'agent'}
								{#if rv}
									<ReviewerMascot icon={rv.icon} size={14} />
								{:else}
									<Cat size={14} strokeWidth={1.8} />
								{/if}
							{:else if message.author === 'external'}
								<MessageSquare size={14} strokeWidth={1.8} />
							{:else}
								<User size={14} strokeWidth={1.8} />
							{/if}
						</span>
						<span class="author-block">
							<span class="author-name" style:color={rv?.color}
								>{message.author === 'agent' ? (rv?.name ?? 'Agent') : message.author === 'external' ? (message.externalAuthor ?? 'Reviewer') : 'You'}</span
							>
							<span class="timestamp">{formatTimestamp(message.timestamp)}</span>
						</span>
						<div class="message-body">{@html renderMarkdown(message.text)}</div>
					</div>
				{/each}
			</div>
			{#if awaitingAgent[thread.id]}
				<div class="awaiting-agent">
					<span class="awaiting-dots"><span></span><span></span><span></span></span>
					<span>Thinking…</span>
				</div>
			{/if}
			{#if proposal && thread.id !== openThreadId}
				<button type="button" class="pending-proposal" onclick={() => onOpen(thread.id)}>
					Click to review proposed changes.
				</button>
			{/if}
			{#if proposal && thread.id === openThreadId}
				<div class="thread-proposal">
					<div class="thread-proposal-head">
						<span class="edit-kicker">
							Proposed change{proposal.changes.length === 1 ? '' : 's'}
						</span>
						<button
							class="mini-btn copy"
							title="Copy proposed text"
							onclick={(e) => {
								e.stopPropagation();
								void copyProposedText(proposal);
							}}
						>
							<Copy size={11} />
						</button>
					</div>
					{#each proposal.changes as change (change.para)}
						<div class="proposal-row" title={`${change.before || '(new line)'} → ${change.after || '(removed)'}`}>
							{#if change.before}
								<span class="er-old">{snippet(change.before)}</span>
							{/if}
							{#if change.before && change.after}
								<span class="er-arrow">→</span>
							{/if}
							{#if change.after}
								<span class="er-new">{snippet(change.after)}</span>
							{:else}
								<span class="er-removed">removed</span>
							{/if}
						</div>
					{/each}
					<div class="proposal-actions">
						<button
							class="proposal-btn reject"
							type="button"
							title="Reject this proposal. The thread closes; reply instead to ask for a revision."
							onclick={(e) => {
								e.stopPropagation();
								onReject(thread.id);
							}}
						>
							<X size={11} /> Reject
						</button>
						<button
							class="proposal-btn accept"
							type="button"
							title="Accept this proposal"
							onclick={(e) => {
								e.stopPropagation();
								onAccept(thread.id);
							}}
						>
							<Check size={11} /> Accept
						</button>
					</div>
				</div>
			{/if}
			<textarea
				class="reply-input"
				data-thread-id={thread.id}
				placeholder="Reply…"
				rows="2"
				value={replyDrafts[thread.id] ?? ''}
				oninput={(e) => {
					commentReplyDrafts.update((d) => ({
						...d,
						[thread.id]: (e.currentTarget as HTMLTextAreaElement).value
					}));
				}}
				onkeydown={(e) => {
					if (isModEnter(e)) {
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
						: 'Dismiss this thread. It hides from the gutter and the agent prompt. An unaccepted proposal on this thread is discarded.'}
				>
					{thread.resolved ? 'Reopen' : 'Dismiss'}
				</button>
				<div class="card-actions-right">
					<span class="kbd-hint">{modEnterToSend}</span>
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
		</div>
	{/each}
</div>

<style>
	.comment-gutter {
		position: relative;
		flex-shrink: 0;
		/* Reads `--gutter-width` from +page.svelte. */
		width: var(--gutter-width, 300px);
		min-width: var(--gutter-width, 300px);
		max-width: var(--gutter-width, 300px);
		height: 100%;
		/* Extra bottom room so the lowest card can sit clear of the fixed
		 * agent dock (AgentDockShell publishes its height as the var). */
		padding: 0 10px calc(20px + var(--dock-reserved-bottom, 0px));
		box-sizing: border-box;
		overflow: visible;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	/* Two real buttons, right-aligned to the cards' edge. No container: a
	 * solid primary anchors the pair, so neither button floats on the
	 * column's grey the way loose text did. The count lives inside each
	 * button rather than in a separate label (GitHub's batched "Commit
	 * suggestions"). Both buttons name the whole action - "Accept all (2)",
	 * not "Accept 2" - so neither can be misread as applying to a subset. */
	.gutter-batch-bar {
		position: absolute;
		top: 6px;
		right: 10px;
		z-index: 4;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
	}
	.batch-btn,
	.proposal-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 10px 0 8px;
		border-radius: 7px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.batch-btn.reject,
	.proposal-btn.reject {
		color: var(--text-faint);
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
	}
	.batch-btn.reject:hover:not(:disabled),
	.proposal-btn.reject:hover:not(:disabled) {
		color: var(--text);
		background: var(--bg-hover);
		border-color: color-mix(in srgb, #ef4444 40%, var(--border-light));
	}
	.batch-btn.accept,
	.proposal-btn.accept {
		color: #fff;
		font-weight: 600;
		background: var(--accent);
		border: 1px solid var(--accent);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.batch-btn.accept:hover:not(:disabled),
	.proposal-btn.accept:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 88%, black);
		border-color: color-mix(in srgb, var(--accent) 88%, black);
	}
	.batch-btn:disabled {
		opacity: 0.5;
		cursor: default;
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
		padding: 16px;
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
	/* Message-header avatar: enough room so the
	 * name + stacked timestamp line up beside it (Google-Docs-sized). */
	.avatar.msg {
		width: 26px;
		height: 26px;
	}
	.avatar-agent {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--accent);
	}
	.avatar-user {
		background: color-mix(in srgb, #3b82f6 16%, transparent);
		color: #2563eb;
	}
	.avatar-external {
		background: color-mix(in srgb, #8b5cf6 16%, transparent);
		color: #7c3aed;
	}
	.parked-note {
		margin-bottom: 8px;
		padding: 3px 8px;
		font-size: 11px;
		color: var(--text-muted);
		background: var(--bg-surface);
		border-radius: 6px;
	}
	.pending-proposal {
		display: block;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
		margin: 10px 0;
		font-size: 11px;
		color: var(--text-muted);
	}
	.card-messages {
		max-height: 300px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	/* "Agent is responding…" — shown after sending a reply until the agent
	 * posts a new message or proposal (or the safety timeout fires). */
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
	/* Per-message, Google-Docs anatomy: a roomy avatar, the name in real
	 * (13px) dark type with the timestamp stacked in small gray UNDER it —
	 * not competing on the same line — then the body full-width below.
	 * Author distinction comes from the avatar + name alone; no accent
	 * rules, no nested box. */
	.message {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 9px;
		align-items: center;
	}
	.author-block {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		min-width: 0;
	}
	.author-name {
		font-size: 13px;
		font-weight: 600;
		line-height: 1.2;
		color: var(--text);
	}
	.timestamp {
		font-size: 11px;
		line-height: 1.2;
		color: var(--text-faint);
	}
	.message-body {
		grid-column: 1 / 3;
		margin-top: 7px;
		font-size: 13px;
		line-height: 1.5;
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
		font-family: var(--font-mono);
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
	/* Text-style buttons for secondary actions (Dismiss, Close) — no
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
	/* ── The proposal a thread holds ────────────────────────────────────── */

	.thread-proposal {
		margin-top: 11px;
		padding-top: 10px;
		border-top: 1px solid var(--border-light);
	}
	.thread-proposal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
	}
	.proposal-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 2px 3px;
		padding: 4px 6px;
		margin: 0 -6px;
		border-radius: 6px;
		font-size: 12px;
		line-height: 1.4;
		cursor: default;
	}
	.proposal-row + .proposal-row {
		border-top: 1px solid color-mix(in srgb, var(--text) 6%, transparent);
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
	.er-removed {
		color: var(--text-faint);
		font-style: italic;
	}
	.proposal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 8px;
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
	.mini-btn.copy:hover {
		background: var(--bg-hover);
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-light));
		color: var(--accent);
	}
</style>
