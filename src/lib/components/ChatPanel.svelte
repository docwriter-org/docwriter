<script lang="ts">
	import { onMount } from 'svelte';
	import { Send, X, Image } from 'lucide-svelte';
	import { isModEnter, modEnterToSend } from '$lib/keyboard';
	import {
		ALLOWED_IMAGE_TYPES,
		type AllowedImageMediaType,
		type ImageAttachment
	} from '$lib/types';

	interface Props {
		onSend: (message: string, opts: { planMode: boolean; images: ImageAttachment[] }) => void;
		/** Renders an explicit ✕ in the header when provided. */
		onClose?: () => void;
		/** True while a render is in flight. Sends still work — they get
		 * appended to the queue and run when the current render finishes. */
		rendering?: boolean;
		/** How many messages are already queued (excluding the in-flight
		 * render). Used for the "Queue (3)" send-button label. */
		queuedCount?: number;
		/** Lifted so the parent can preserve text when the popover unmounts. */
		message?: string;
		planMode?: boolean;
	}
	let {
		onSend,
		onClose,
		rendering = false,
		queuedCount = 0,
		message = $bindable(''),
		planMode = $bindable(false)
	}: Props = $props();
	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let attachedImages = $state<ImageAttachment[]>([]);
	let isDragOver = $state(false);

	function send() {
		const trimmed = message.trim();
		if (!trimmed && attachedImages.length === 0) return;
		onSend(trimmed, { planMode, images: attachedImages });
		message = '';
		attachedImages = [];
	}

	function onKeyDown(e: KeyboardEvent) {
		if (isModEnter(e)) {
			e.preventDefault();
			send();
		}
	}

	function isAllowedImageType(type: string): type is AllowedImageMediaType {
		return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
	}

	async function readFileAsBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1] ?? '');
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function attachFiles(files: File[]) {
		const images = files.filter((f) => isAllowedImageType(f.type));
		if (images.length === 0) return;
		const newAttachments = await Promise.all(
			images.map(async (file): Promise<ImageAttachment> => ({
				name: file.name,
				mediaType: file.type as AllowedImageMediaType,
				data: await readFileAsBase64(file)
			}))
		);
		attachedImages = [...attachedImages, ...newAttachments];
	}

	function removeImage(index: number) {
		attachedImages = attachedImages.filter((_, i) => i !== index);
	}

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		isDragOver = true;
	}
	function handleDragLeave(e: DragEvent) {
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as Element).contains(related)) return;
		isDragOver = false;
	}
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragOver = false;
		if (!e.dataTransfer?.files.length) return;
		void attachFiles([...e.dataTransfer.files]);
	}

	onMount(() => {
		requestAnimationFrame(() => textareaEl?.focus());
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="chat-panel"
	class:drag-over={isDragOver}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<div class="panel-header">
		<span class="panel-title">{rendering ? 'Queue message' : 'Send message'}</span>
		<span class="panel-subtitle">
			{#if rendering}
				will run after the current render finishes
			{:else}
				free-form request to the agent
			{/if}
		</span>
		{#if onClose}
			<button class="panel-close" aria-label="Close" title="Close" onclick={onClose}>
				<X size={12} />
			</button>
		{/if}
	</div>

	<textarea
		bind:this={textareaEl}
		bind:value={message}
		onkeydown={onKeyDown}
		placeholder="Message the agent…"
		rows="5"
	></textarea>

	{#if attachedImages.length > 0}
		<div class="image-chips">
			{#each attachedImages as img, i}
				<div class="image-chip">
					<img
						class="chip-thumb"
						src="data:{img.mediaType};base64,{img.data}"
						alt={img.name}
						title={img.name}
					/>
					<span class="chip-name">{img.name}</span>
					<button
						class="chip-remove"
						aria-label="Remove {img.name}"
						onclick={() => removeImage(i)}
					>
						<X size={10} />
					</button>
				</div>
			{/each}
		</div>
	{:else if isDragOver}
		<div class="drop-hint">
			<Image size={16} />
			<span>Drop images here</span>
		</div>
	{/if}

	<div class="panel-footer">
		<label class="plan-toggle" title="Ask the agent to produce a plan first. Nothing gets edited until you approve the plan.">
			<input type="checkbox" bind:checked={planMode} />
			<span>Plan first</span>
		</label>
		<div class="footer-right">
			<span class="kbd-hint">{modEnterToSend}</span>
			<button class="send-btn" onclick={send} disabled={!message.trim() && attachedImages.length === 0}>
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
		width: 100%;
		box-sizing: border-box;
		padding: 12px 14px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
		display: flex;
		flex-direction: column;
		gap: 10px;
		transition: background 0.12s;
	}
	.chat-panel.drag-over {
		background: color-mix(in srgb, var(--accent) 5%, transparent);
		outline: 1.5px dashed var(--accent);
		outline-offset: -3px;
		border-radius: 6px;
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
		/* Keep the subtitle hugging the right edge (next to the ✕) instead
		 * of being centered by the header's space-between. */
		margin-left: auto;
	}
	.panel-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin-left: 4px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		border-radius: 4px;
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		align-self: center;
	}
	.panel-close:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
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
	}
	.image-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.image-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 6px 3px 4px;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 5px;
		max-width: 200px;
	}
	.chip-thumb {
		width: 28px;
		height: 28px;
		object-fit: cover;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.chip-name {
		font-size: 11px;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
	}
	.chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		border-radius: 3px;
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
	}
	.chip-remove:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
	.drop-hint {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px;
		color: var(--accent);
		font-size: 12px;
		border: 1.5px dashed var(--accent);
		border-radius: 5px;
		opacity: 0.8;
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
