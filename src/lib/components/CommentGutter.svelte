<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { Send, Sparkles, Cat } from 'lucide-svelte';

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
	import { onDestroy } from 'svelte';
	import type { CommentThread } from '$lib/types';
	import { resolveThreadRange } from '$lib/editor/comment-overlay';

	interface Props {
		threads: CommentThread[];
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
	}
	let {
		threads,
		editor,
		tabId,
		openThreadId,
		onOpen,
		onClose,
		onApprove,
		onReply
	}: Props = $props();

	let gutterEl: HTMLDivElement | null = $state(null);
	let replyDrafts = $state<Record<string, string>>({});
	let replying = $state<Record<string, boolean>>({});
	let resolving = $state<Record<string, boolean>>({});

	/** Per-thread absolute Y offset inside the gutter column. Computed
	 * from the editor's `coordsAtPos` on the anchored range, then pushed
	 * down when neighbors collide so no two cards overlap. Null for
	 * threads whose anchor quote no longer appears in the doc
	 * (detached — skipped from the gutter entirely). */
	let stackedPositions = $state<Map<string, number>>(new Map());

	const COLLAPSED_H = 54;
	const EXPANDED_H_APPROX = 260;
	const CARD_GAP = 8;

	function recomputePositions() {
		if (!editor || !gutterEl) return;
		const gutterRect = gutterEl.getBoundingClientRect();
		const entries: Array<{ id: string; top: number; expanded: boolean }> = [];
		for (const thread of threads) {
			if (thread.resolved) continue;
			const range = resolveThreadRange(editor, thread);
			if (!range) continue;
			try {
				const coords = editor.view.coordsAtPos(range.from);
				entries.push({
					id: thread.id,
					top: coords.top - gutterRect.top,
					expanded: thread.id === openThreadId
				});
			} catch {
				// coordsAtPos throws if the view isn't mounted — skip.
			}
		}
		entries.sort((a, b) => a.top - b.top);
		// Collision stack: each card claims [top, top + height + gap]; if
		// the next card's natural top falls inside that, push it down to
		// sit right below the previous one.
		let runningBottom = -Infinity;
		const next = new Map<string, number>();
		for (const entry of entries) {
			const h = entry.expanded ? EXPANDED_H_APPROX : COLLAPSED_H;
			const top = Math.max(entry.top, runningBottom);
			next.set(entry.id, top);
			runningBottom = top + h + CARD_GAP;
		}
		stackedPositions = next;
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
			.filter((t) => !t.resolved && stackedPositions.has(t.id))
			.sort(
				(a, b) =>
					(stackedPositions.get(a.id) ?? 0) - (stackedPositions.get(b.id) ?? 0)
			)
	);

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
			replyDrafts = { ...replyDrafts, [thread.id]: '' };
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

	async function toggleResolved(thread: CommentThread) {
		if (resolving[thread.id]) return;
		resolving = { ...resolving, [thread.id]: true };
		try {
			const res = await fetch('/api/comments', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tabId, threadId: thread.id, resolved: !thread.resolved })
			});
			if (!res.ok) throw new Error(await res.text());
			if (!thread.resolved) onClose();
		} catch (e) {
			console.error('Failed to toggle resolved:', e);
		} finally {
			resolving = { ...resolving, [thread.id]: false };
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
			style:top="{top}px"
			onclick={(e) => {
				if (isOpen) return;
				e.stopPropagation();
				onOpen(thread.id);
			}}
		>
			{#if isOpen}
				<div class="card-messages">
					{#each thread.messages as message (message.id)}
						<div class="message" class:from-agent={message.author === 'agent'} class:from-user={message.author === 'user'}>
							<span class="author">
								{#if message.author === 'agent'}
									<Cat size={12} strokeWidth={1.7} />
								{:else}
									You
								{/if}
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
						disabled={resolving[thread.id]}
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
					<div class="card-author">
						{#if firstMessageAuthor(thread) === 'agent'}
							<Cat size={12} strokeWidth={1.7} class="author-icon-agent" />
						{:else}
							<span class="author-label-user">You</span>
						{/if}
					</div>
					<div class="card-preview" title={firstMessageBody(thread)}>
						{firstMessageBody(thread)}
					</div>
					<span class="card-count">{thread.messages.length}</span>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.comment-gutter {
		position: relative;
		flex-shrink: 0;
		/* Keep in sync with `.plain-editor-shell.has-comment-gutter`'s
		 * third grid column in TiptapEditor.svelte. Compromise between
		 * the original 220px (felt too wide collapsed) and 180px (too
		 * narrow for an expanded thread with code paths / long URLs). */
		width: 200px;
		min-width: 200px;
		max-width: 200px;
		height: 100%;
		padding: 0 10px 20px;
		box-sizing: border-box;
		overflow: visible;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.gutter-card {
		position: absolute;
		left: 10px;
		right: 10px;
		background: var(--bg-elevated);
		border: 1px solid color-mix(in srgb, #f59e0b 28%, var(--border-light));
		border-radius: 8px;
		padding: 6px 8px;
		font-size: 12.5px;
		color: var(--text);
		cursor: pointer;
		transition: box-shadow 0.12s, border-color 0.12s;
		z-index: 1;
	}
	.gutter-card:hover {
		border-color: color-mix(in srgb, #f59e0b 50%, var(--border-light));
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
	}
	.gutter-card.expanded {
		cursor: default;
		z-index: 2;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);
		padding: 8px 10px;
		border-color: color-mix(in srgb, #f59e0b 55%, var(--border-light));
	}
	.card-collapsed-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.card-author {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		height: 14px;
	}
	:global(.author-icon-agent) {
		color: #b45309;
	}
	.author-label-user {
		font-size: 11px;
		font-weight: 600;
		color: #2563eb;
	}
	.card-preview {
		flex: 1;
		min-width: 0;
		font-size: 12px;
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
		color: #92400e;
		background: #fef3c7;
		padding: 1px 6px;
		border-radius: 8px;
	}
	.card-messages {
		max-height: 260px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
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
		font-size: 11px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		height: 14px;
	}
	.message.from-user .author {
		color: #2563eb;
	}
	.message.from-agent .author {
		color: #b45309;
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
</style>
