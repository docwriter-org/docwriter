<script lang="ts">
	import { get } from 'svelte/store';
	import { MessageCircle } from 'lucide-svelte';
	import ChatPanel from './ChatPanel.svelte';
	import { chatCompose, isRendering, queuedSubmissionCount } from '$lib/stores';
	import { tooltip } from '$lib/actions/tooltip';
	import type { ImageAttachment } from '$lib/types';

	interface Props {
		onSendMessage: (message: string, opts: { planMode: boolean; images: ImageAttachment[] }) => void;
	}
	let { onSendMessage }: Props = $props();

	let rendering = $state(false);
	isRendering.subscribe((v) => (rendering = v));

	let queuedCount = $state(0);
	queuedSubmissionCount.subscribe((v) => (queuedCount = v));

	// Hydrate from the session store so a remount (tab switch used to
	// tear the dock down with `docLoaded`) restores the open popover and
	// whatever the user was typing / had attached.
	const initial = get(chatCompose);
	let chatOpen = $state(initial.open);
	let chatMessageDraft = $state(initial.message);
	let chatPlanModeDraft = $state(initial.planMode);
	let chatImagesDraft = $state<ImageAttachment[]>(initial.images);
	let dockEl: HTMLDivElement | null = $state(null);

	$effect(() => {
		chatCompose.set({
			open: chatOpen,
			message: chatMessageDraft,
			planMode: chatPlanModeDraft,
			images: chatImagesDraft
		});
	});

	function toggleChat() {
		chatOpen = !chatOpen;
	}

	function sendMessage(message: string, opts: { planMode: boolean; images: ImageAttachment[] }) {
		onSendMessage(message, opts);
		if (!rendering) chatOpen = false;
	}

	$effect(() => {
		if (!chatOpen) return;
		function onDown(e: MouseEvent) {
			// Check against the whole dock (button + popover), not just the
			// popover: a mousedown on the Chat button would close here and the
			// button's click would immediately toggle it back open, making the
			// button unable to ever close the popover.
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (dockEl && dockEl.contains(target)) return;
			// Switching files, clicking a tab, or peeking at the editor
			// should not dismiss an in-progress compose. `.body` is the
			// workspace (file tree + outline + tabs + editor).
			if (target.closest('.body')) return;
			chatOpen = false;
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') chatOpen = false;
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="agent-dock" bind:this={dockEl}>
	<button
		class="dock-message-btn header-pill-btn"
		class:has-queue={queuedCount > 0}
		type="button"
		aria-pressed={chatOpen}
		use:tooltip={queuedCount > 0
			? `Chat with the agent. ${queuedCount} message${queuedCount === 1 ? '' : 's'} already queued — a new message will run after them.`
			: rendering
				? 'Chat with the agent. Messages sent while it works are queued and run after the current render finishes.'
				: chatMessageDraft.trim() || chatImagesDraft.length > 0
					? 'Chat with the agent. Your unsent draft is still here.'
					: 'Chat with the agent. Type a request and Claude will run a render with your message as the prompt.'}
		onclick={toggleChat}
	>
		<MessageCircle size={12} />
		<span>Chat</span>
		{#if queuedCount > 0}
			<span class="queue-badge">{queuedCount}</span>
		{:else if !chatOpen && (chatMessageDraft.trim().length > 0 || chatImagesDraft.length > 0)}
			<span class="draft-dot" aria-label="Unsent draft"></span>
		{/if}
	</button>
	{#if chatOpen}
		<div class="dock-chat-popover">
			<ChatPanel
				bind:message={chatMessageDraft}
				bind:planMode={chatPlanModeDraft}
				bind:images={chatImagesDraft}
				onSend={sendMessage}
				onClose={() => (chatOpen = false)}
				rendering={rendering}
				queuedCount={queuedCount}
			/>
		</div>
	{/if}
</div>

<style>
	.agent-dock {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 6px;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.dock-message-btn {
		position: relative;
	}
	:global(.dock-message-btn[aria-pressed='true']) {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border-light);
	}
	:global(.dock-message-btn.has-queue) {
		color: var(--accent);
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
	.queue-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border-radius: 999px;
		background: var(--accent);
		color: white;
		font-size: 9px;
		font-weight: 700;
		line-height: 14px;
		text-align: center;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 0 0 1.5px var(--bg-surface);
	}
	.draft-dot {
		position: absolute;
		top: -3px;
		right: -3px;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 1.5px var(--bg-surface);
	}
	.dock-chat-popover {
		position: absolute;
		top: calc(100% + 8px);
		left: 0;
		right: 0;
		z-index: 20;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
		overflow: hidden;
	}
</style>
