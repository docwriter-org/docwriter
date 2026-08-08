<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { MessageSquare, X, Upload } from 'lucide-svelte';
	import { parseCommentsPaste } from '$lib/shared/feedback-import';
	import type { ImportedComment } from '$lib/types';

	interface Props {
		open: boolean;
		onClose: () => void;
		onImport: (comments: ImportedComment[]) => void;
	}
	let { open, onClose, onImport }: Props = $props();

	let rawText = $state('');
	let parsed = $state<ImportedComment[]>([]);
	let step = $state<'input' | 'preview'>('input');

	function reset() {
		rawText = '';
		parsed = [];
		step = 'input';
	}

	function close() {
		reset();
		onClose();
	}

	function doParse() {
		parsed = parseCommentsPaste(rawText);
		if (parsed.length > 0) {
			step = 'preview';
		}
	}

	function doImport() {
		onImport(parsed);
		close();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			if (step === 'preview') {
				step = 'input';
			} else {
				close();
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="backdrop" transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="feedback-import-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				<span id="feedback-import-title">
					<MessageSquare size={13} />
					Import feedback
				</span>
				<button class="close-btn" onclick={close}><X size={14} /></button>
			</div>

			{#if step === 'input'}
				<div class="dialog-body">
					<p class="hint">
						Paste comments from a Google Doc, email, or any source. Use
						<code>[Name]: comment</code> format, one comment per line or paragraph.
					</p>
					<!-- svelte-ignore a11y_autofocus -->
					<textarea
						bind:value={rawText}
						placeholder={`[Maya]: The intro is too long — consider cutting the first two paragraphs.\n\n[Raj]: Can you cite the 2023 paper here?\n\n[Maya]: This claim needs evidence.`}
						autofocus
					></textarea>
				</div>
				<div class="dialog-footer">
					<button class="btn" onclick={close}>Cancel</button>
					<button
						class="btn primary"
						disabled={!rawText.trim()}
						onclick={doParse}
					>
						Preview
					</button>
				</div>
			{:else}
				<div class="dialog-body">
					<p class="hint">
						{parsed.length} comment{parsed.length === 1 ? '' : 's'} detected. The agent will
						create a thread for each and take a first pass at addressing them.
					</p>
					<div class="comment-list">
						{#each parsed as c (c.id)}
							<div class="comment-preview">
								<span class="comment-author">{c.author}</span>
								<span class="comment-text">{c.text}</span>
							</div>
						{/each}
					</div>
				</div>
				<div class="dialog-footer">
					<button class="btn" onclick={() => (step = 'input')}>Back</button>
					<button class="btn primary" onclick={doImport}>
						<Upload size={13} />
						Import &amp; address
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 210;
		padding: 16px;
	}
	.dialog {
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		width: min(520px, 100%);
		display: flex;
		flex-direction: column;
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
		max-height: 80vh;
	}
	.dialog-header {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-light);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	.dialog-header span {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.close-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		border-radius: 4px;
	}
	.close-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.dialog-body {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		overflow-y: auto;
	}
	.hint {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.5;
		margin: 0;
	}
	.hint code {
		font-size: 11.5px;
		background: var(--bg);
		padding: 1px 4px;
		border-radius: 3px;
		border: 1px solid var(--border-light);
	}
	textarea {
		font-family: 'Geist Mono', 'SF Mono', monospace;
		font-size: 12.5px;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 7px;
		padding: 10px 12px;
		resize: vertical;
		line-height: 1.6;
		min-height: 160px;
	}
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.comment-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-height: 300px;
		overflow-y: auto;
	}
	.comment-preview {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		font-size: 12.5px;
		line-height: 1.5;
	}
	.comment-author {
		font-weight: 600;
		font-size: 11px;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.comment-text {
		color: var(--text-secondary);
	}
	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--border-light);
	}
	.btn {
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		padding: 6px 14px;
		border-radius: 7px;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.btn:hover {
		background: var(--bg-hover);
	}
	.btn.primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
	.btn.primary:hover {
		filter: brightness(1.08);
	}
	.btn:disabled {
		opacity: 0.4;
		pointer-events: none;
	}
</style>
