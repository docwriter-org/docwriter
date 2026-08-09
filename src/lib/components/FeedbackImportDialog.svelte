<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { FileUp, MessageSquare, X, Upload, FileText } from 'lucide-svelte';
	import type { ImportedComment } from '$lib/types';

	interface Props {
		open: boolean;
		tabId: string | null;
		onClose: () => void;
		onImportComments: (comments: ImportedComment[]) => void;
		onImportRawText: (text: string) => void;
	}
	let { open, tabId, onClose, onImportComments, onImportRawText }: Props = $props();

	let mode = $state<'choose' | 'docx-preview' | 'text'>('choose');
	let rawText = $state('');
	let docxComments = $state<ImportedComment[]>([]);
	let docxFileName = $state('');
	let uploading = $state(false);
	let uploadError = $state('');

	function reset() {
		mode = 'choose';
		rawText = '';
		docxComments = [];
		docxFileName = '';
		uploading = false;
		uploadError = '';
	}

	function close() {
		reset();
		onClose();
	}

	async function handleFile(file: File) {
		if (!file.name.endsWith('.docx')) {
			uploadError = 'Please upload a .docx file.';
			return;
		}
		uploading = true;
		uploadError = '';
		try {
			const formData = new FormData();
			formData.append('file', file);
			formData.append('tabId', tabId ?? '');
			const res = await fetch('/api/feedback-import', { method: 'POST', body: formData });
			const data = await res.json();
			if (!res.ok || data.error) {
				uploadError = data.error || 'Failed to parse document.';
				uploading = false;
				return;
			}
			docxComments = data.import.comments;
			docxFileName = file.name;
			mode = 'docx-preview';
		} catch (e) {
			uploadError = e instanceof Error ? e.message : 'Upload failed.';
		}
		uploading = false;
	}

	function onFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) void handleFile(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		const file = e.dataTransfer?.files[0];
		if (file) void handleFile(file);
	}

	function doImportDocx() {
		onImportComments(docxComments);
		close();
	}

	function doImportText() {
		if (!rawText.trim()) return;
		onImportRawText(rawText.trim());
		close();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			if (mode !== 'choose') {
				mode = 'choose';
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

			{#if mode === 'choose'}
				<div class="dialog-body">
					<p class="hint">
						Bring in feedback from collaborators. The agent will create a thread for each
						comment and take a first pass at addressing them.
					</p>

					<div class="option-cards">
						<label
							class="option-card"
							ondragover={(e) => e.preventDefault()}
							ondrop={onDrop}
						>
							<input type="file" accept=".docx" onchange={onFileInput} hidden />
							<FileUp size={24} strokeWidth={1.5} />
							<span class="option-title">Upload .docx</span>
							<span class="option-desc">Word document with comments or tracked changes</span>
							{#if uploading}
								<span class="option-status">Parsing…</span>
							{/if}
							{#if uploadError}
								<span class="option-error">{uploadError}</span>
							{/if}
						</label>

						<button class="option-card" onclick={() => (mode = 'text')}>
							<FileText size={24} strokeWidth={1.5} />
							<span class="option-title">Paste feedback</span>
							<span class="option-desc">Email, Slack messages, or any plain text</span>
						</button>
					</div>
				</div>
			{:else if mode === 'docx-preview'}
				<div class="dialog-body">
					<p class="hint">
						{docxComments.length} comment{docxComments.length === 1 ? '' : 's'} found in
						<strong>{docxFileName}</strong>.
					</p>
					<div class="comment-list">
						{#each docxComments as c (c.id)}
							<div class="comment-preview">
								<span class="comment-author">{c.author}</span>
								<span class="comment-text">{c.text}</span>
								{#if c.originalAnchor}
									<span class="comment-anchor">on: "{c.originalAnchor.length > 80 ? c.originalAnchor.slice(0, 77) + '…' : c.originalAnchor}"</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
				<div class="dialog-footer">
					<button class="btn" onclick={() => (mode = 'choose')}>Back</button>
					<button class="btn primary" onclick={doImportDocx}>
						<Upload size={13} />
						Import &amp; address
					</button>
				</div>
			{:else if mode === 'text'}
				<div class="dialog-body">
					<p class="hint">
						Paste feedback as-is — email threads, Slack messages, reviewer notes.
						Include quotes of the passages being discussed when possible so the agent
						can find the right spots.
					</p>
					<!-- svelte-ignore a11y_autofocus -->
					<textarea
						bind:value={rawText}
						placeholder={`Maya said the intro is too long and we should cut the first two paragraphs.\n\nRaj wants a citation for the 2023 Smith et al. claim in the methods section.\n\nThe conclusion needs to be tightened — "too many hedging words" per Maya.`}
						autofocus
					></textarea>
				</div>
				<div class="dialog-footer">
					<button class="btn" onclick={() => (mode = 'choose')}>Back</button>
					<button class="btn primary" disabled={!rawText.trim()} onclick={doImportText}>
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
	.option-cards {
		display: flex;
		gap: 10px;
	}
	.option-card {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 20px 14px;
		background: var(--bg);
		border: 1.5px dashed var(--border-light);
		border-radius: 8px;
		cursor: pointer;
		color: var(--text-secondary);
		text-align: center;
		font: inherit;
		transition: border-color 0.15s, background 0.15s;
	}
	.option-card:hover {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 4%, var(--bg));
	}
	.option-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.option-desc {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.option-status {
		font-size: 11px;
		color: var(--accent);
	}
	.option-error {
		font-size: 11px;
		color: var(--diff-removed-color);
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
	.comment-anchor {
		font-size: 11px;
		color: var(--text-muted);
		font-style: italic;
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
