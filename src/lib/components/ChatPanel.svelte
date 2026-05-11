<script lang="ts">
	import { onMount } from 'svelte';
	import { Send } from 'lucide-svelte';

	interface Props {
		onSend: (message: string, opts: { planMode: boolean }) => void;
		/** True while a render is in flight. Sends still work — they get
		 * appended to the queue and run when the current render finishes. */
		rendering?: boolean;
		/** How many messages are already queued (excluding the in-flight
		 * render). Used for the "Queue (3)" send-button label. */
		queuedCount?: number;
	}
	let { onSend, rendering = false, queuedCount = 0 }: Props = $props();

	let message = $state('');
	let planMode = $state(false);
	let textareaEl: HTMLTextAreaElement | null = $state(null);

	function send() {
		const trimmed = message.trim();
		if (!trimmed) return;
		onSend(trimmed, { planMode });
		message = '';
	}

	function onKeyDown(e: KeyboardEvent) {
		// Cmd/Ctrl+Enter sends. Plain Enter makes a new line (multi-line editing).
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			send();
		}
	}

	// Autofocus on mount. MenuBar unmounts+remounts the panel each time the
	// user hovers a different item, so this fires fresh every open. raf
	// guarantees the textarea is painted before we grab focus; without it,
	// the focus can race with whatever stole focus when the hover opened.
	onMount(() => {
		requestAnimationFrame(() => textareaEl?.focus());
	});
</script>

<div class="chat-panel">
	<div class="panel-header">
		<span class="panel-title">{rendering ? 'Queue message' : 'Send message'}</span>
		<span class="panel-subtitle">
			{#if rendering}
				will run after the current render finishes
			{:else}
				free-form request to the agent
			{/if}
		</span>
	</div>

	<textarea
		bind:this={textareaEl}
		bind:value={message}
		onkeydown={onKeyDown}
		placeholder={`Ask the agent anything, e.g.\n• "Add a hook that runs pdflatex after every Edit"\n• "Tighten the first paragraph of every open file"\n• "Create outline.md and fill it from document.md"`}
		rows="5"
	></textarea>

	<div class="panel-footer">
		<label class="plan-toggle" title="Ask the agent to produce a plan first. Nothing gets edited until you approve the plan.">
			<input type="checkbox" bind:checked={planMode} />
			<span>Plan first</span>
		</label>
		<div class="footer-right">
			<span class="hint">⌘↵ to send</span>
			<button class="send-btn" onclick={send} disabled={!message.trim()}>
				<Send size={12} />
				{#if rendering}
					Queue{queuedCount > 0 ? ` (${queuedCount})` : ''}
				{:else}
					{planMode ? 'Plan' : 'Send'}
				{/if}
			</button>
		</div>
	</div>
</div>

<style>
	.chat-panel {
		/* Fills the popover, which itself spans the floating toolbar
		 * (left:0 / right:0 anchored to .pane-header). So the panel
		 * always fits whatever pane width the user has set. */
		width: 100%;
		box-sizing: border-box;
		padding: 12px 14px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.panel-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}
	.panel-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.panel-subtitle {
		font-size: 11px;
		color: var(--text-faint);
	}
	textarea {
		width: 100%;
		resize: vertical;
		font-family: inherit;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 10px 12px;
		outline: none;
		box-sizing: border-box;
		transition: border-color 0.15s, box-shadow 0.15s;
	}
	textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	textarea::placeholder {
		color: var(--text-faint);
		font-size: 12px;
		line-height: 1.5;
	}
	.panel-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.footer-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.plan-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		color: var(--text-faint);
		cursor: pointer;
		user-select: none;
	}
	.plan-toggle input {
		margin: 0;
		cursor: pointer;
	}
	.hint {
		font-size: 11px;
		color: var(--text-faint);
	}
	.send-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 5px 12px;
		background: var(--accent-bg);
		color: var(--accent);
		border: 1px solid var(--accent-light);
		border-radius: 5px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.send-btn:hover:not(:disabled) {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
	.send-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
