<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { FileText, LoaderCircle, Paperclip, Upload, X } from 'lucide-svelte';
	import type { ImportedComment } from '$lib/types';

	interface Props {
		open: boolean;
		tabId: string | null;
		onClose: () => void;
		onImportComments: (comments: ImportedComment[]) => void;
		onImportRawText: (text: string) => void;
	}
	let { open, tabId, onClose, onImportComments, onImportRawText }: Props = $props();

	/** Paste canvas is the default workspace (like References → Sources).
	 *  Uploading a .docx swaps the canvas for a comment preview. */
	let mode = $state<'text' | 'docx-preview'>('text');
	let rawText = $state('');
	let docxComments = $state<ImportedComment[]>([]);
	let docxFileName = $state('');
	let uploading = $state(false);
	let uploadError = $state('');
	let fileInput: HTMLInputElement | undefined = $state();
	/** dragenter/dragleave also fire for children, so count them instead of
	 *  toggling on the first leave. */
	let dragDepth = $state(0);
	const dragActive = $derived(dragDepth > 0);

	function reset() {
		mode = 'text';
		rawText = '';
		docxComments = [];
		docxFileName = '';
		uploading = false;
		uploadError = '';
		dragDepth = 0;
	}

	function close() {
		reset();
		onClose();
	}

	function removeDocx() {
		mode = 'text';
		docxComments = [];
		docxFileName = '';
		uploadError = '';
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
			const res = await fetch('/api/feedback-import?preview=1', {
				method: 'POST',
				body: formData
			});
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
		input.value = '';
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragDepth = 0;
		const file = e.dataTransfer?.files[0];
		if (file) void handleFile(file);
	}

	function onDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		dragDepth += 1;
	}

	function onDragLeave(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}

	async function doImportDocx() {
		const comments = docxComments;
		await fetch('/api/feedback-import', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ comments, tabId, source: 'docx' })
		});
		onImportComments(comments);
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
			if (mode === 'docx-preview') {
				removeDocx();
			} else {
				close();
			}
		}
	}

	function closeOnBackdrop(event: MouseEvent) {
		if (event.target === event.currentTarget) close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="backdrop" role="presentation" onclick={closeOnBackdrop} transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="feedback-import-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				<span id="feedback-import-title">Import feedback</span>
				<div class="header-actions">
					<input
						bind:this={fileInput}
						type="file"
						accept=".docx"
						onchange={onFileInput}
						hidden
					/>
					<button class="icon-btn" onclick={close} aria-label="Close"><X size={14} /></button>
				</div>
			</div>

			{#if uploadError}
				<div class="error-box">{uploadError}</div>
			{/if}

			<div
				class="dialog-body"
				role="group"
				aria-label="Feedback to import"
				ondragenter={onDragEnter}
				ondragover={(e) => e.preventDefault()}
				ondragleave={onDragLeave}
				ondrop={onDrop}
			>
				{#if mode === 'text'}
					<div class="workspace">
						<div class="canvas" class:dragging={dragActive}>
							<p class="canvas-lede">
								Paste collaborator notes as-is — email, Slack, reviewer comments.
								Include quotes of the passages when you can.
							</p>
							<!-- svelte-ignore a11y_autofocus -->
							<textarea
								class="canvas-text"
								bind:value={rawText}
								placeholder={`Maya said the intro is too long and we should cut the first two paragraphs.\n\nRaj wants a citation for the 2023 Smith et al. claim in the methods section.\n\nThe conclusion needs to be tightened — "too many hedging words" per Maya.`}
								autofocus
								aria-label="Pasted feedback"
							></textarea>
							{#if dragActive}
								<div class="drop-veil">
									<FileText size={22} />
									<span>Drop to read the comments from Word</span>
								</div>
							{/if}
							<div class="canvas-foot">
								<button
									class="btn attach"
									disabled={uploading}
									onclick={() => fileInput?.click()}
								>
									{#if uploading}
										<LoaderCircle size={13} class="spinner" />
										Reading the file…
									{:else}
										<Paperclip size={13} />
										Add a .docx with comments
									{/if}
								</button>
								<button
									class="btn primary"
									disabled={!rawText.trim()}
									onclick={doImportText}
								>
									<Upload size={13} />
									Import &amp; address
								</button>
							</div>
						</div>

						<aside class="rail">
							<span class="eyebrow">Google Docs → Word</span>
							<p class="rail-lede">
								To bring in comments (and open suggestions) from a shared Doc:
							</p>
							<ol class="howto">
								<li>Open the Doc that has the reviewer comments.</li>
								<li>
									<strong>File → Download → Microsoft Word (.docx)</strong>
								</li>
								<li>
									Drop that file onto this window, or use
									<strong>Add a .docx</strong> at the bottom of the page.
								</li>
							</ol>
							<p class="rail-note">
								Word keeps each comment’s author and the highlighted passage.
								Google’s <strong>version history</strong> does not export — only the
								current draft plus its comments/suggestions.
							</p>
							<p class="rail-note">
								Suggesting-mode edits export as suggestions if you leave them open
								(or convert them to comments) before downloading.
							</p>
						</aside>
					</div>
				{:else}
					<div class="workspace">
						<div class="canvas" class:dragging={dragActive}>
							<div class="file-chip">
								<FileText size={14} />
								<span class="file-name">{docxFileName}</span>
								<span class="file-count">
									{docxComments.length} comment{docxComments.length === 1 ? '' : 's'}
								</span>
								<button
									class="icon-btn"
									onclick={removeDocx}
									aria-label="Remove this file"
								><X size={13} /></button>
							</div>
							<p class="canvas-lede">
								The agent will open a thread for each of these and take a first pass.
							</p>
							<div class="comment-list">
								{#each docxComments as c (c.id)}
									<div class="comment-preview">
										<span class="comment-author">{c.author}</span>
										<span class="comment-text">{c.text}</span>
										{#if c.originalAnchor}
											<span class="comment-anchor"
												>on: "{c.originalAnchor.length > 100
													? c.originalAnchor.slice(0, 97) + '…'
													: c.originalAnchor}"</span
											>
										{/if}
									</div>
								{/each}
							</div>
							{#if dragActive}
								<div class="drop-veil">
									<FileText size={22} />
									<span>Drop to read the comments from Word</span>
								</div>
							{/if}
							<div class="canvas-foot">
								<button
									class="btn attach"
									disabled={uploading}
									onclick={() => fileInput?.click()}
								>
									{#if uploading}
										<LoaderCircle size={13} class="spinner" />
										Reading the file…
									{:else}
										<Paperclip size={13} />
										Use a different file
									{/if}
								</button>
								<button class="btn primary" onclick={() => void doImportDocx()}>
									<Upload size={13} />
									Import &amp; address
								</button>
							</div>
						</div>

						<aside class="rail">
							<span class="eyebrow">Ready to import</span>
							<p class="rail-note">
								Each comment keeps its author and the passage it was anchored to in
								Word. The agent remaps those anchors onto your current draft.
							</p>
						</aside>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 210;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
	}
	.dialog {
		display: flex;
		flex-direction: column;
		width: min(1320px, calc(100vw - 24px));
		height: min(880px, calc(100vh - 24px));
		overflow: hidden;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-elevated);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		color: var(--text);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 22px 20px 16px 28px;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
		border-bottom: 1px solid var(--border-light);
		flex-shrink: 0;
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
	.icon-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.error-box {
		margin: 12px 28px 0;
		padding: 8px 12px;
		border: 1px solid color-mix(in srgb, var(--diff-removed-color) 40%, var(--border-light));
		border-radius: 6px;
		background: color-mix(in srgb, var(--diff-removed-color) 8%, var(--bg));
		color: var(--diff-removed-color);
		font-size: 12.5px;
		flex-shrink: 0;
	}
	.dialog-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.workspace {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		height: 100%;
		overflow: hidden;
	}
	.canvas {
		position: relative;
		display: flex;
		box-sizing: border-box;
		width: 100%;
		max-width: 860px;
		height: 100%;
		min-height: 0;
		margin: 0 auto;
		flex-direction: column;
		padding: 28px 44px 20px;
	}
	.drop-veil {
		position: absolute;
		inset: 18px 28px 74px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		border: 2px dashed var(--accent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 7%, var(--bg-elevated));
		color: var(--accent);
		font-size: 13.5px;
		font-weight: 500;
		pointer-events: none;
	}
	.file-chip {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
		padding: 8px 8px 8px 12px;
		border: 1px solid var(--border-light);
		border-radius: 7px;
		background: var(--bg);
		color: var(--text-secondary);
	}
	.file-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file-count {
		margin-right: auto;
		font-size: 12px;
		color: var(--text-muted);
	}
	.canvas-lede {
		margin: 0 0 14px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		flex-shrink: 0;
	}
	.canvas-text {
		flex: 1 1 auto;
		min-height: 0;
		padding: 18px 0;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text);
		font-family: 'Geist Mono', 'SF Mono', monospace;
		font-size: 13.5px;
		line-height: 1.65;
		resize: none;
	}
	.canvas-text:focus {
		outline: none;
	}
	.canvas-foot {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border-light);
	}
	.rail {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 12px;
		padding: 24px 18px 18px;
		border-left: 1px solid var(--border-light);
		background: var(--bg);
		overflow-y: auto;
	}
	.eyebrow {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.rail-lede {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text);
	}
	.howto {
		margin: 0;
		padding-left: 1.15em;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.howto strong {
		color: var(--text);
		font-weight: 600;
	}
	.rail-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-muted);
	}
	.rail-note strong {
		color: var(--text-secondary);
		font-weight: 600;
	}
	.comment-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 0 12px;
	}
	.comment-preview {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		font-size: 13.5px;
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
		font-size: 12px;
		color: var(--text-muted);
		font-style: italic;
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
	.btn.attach {
		border-style: dashed;
		background: transparent;
	}
	.btn.attach:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent);
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
	:global(.spinner) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
