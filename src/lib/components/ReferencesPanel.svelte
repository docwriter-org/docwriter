<script lang="ts" module>
	/** Drafts survive the popover unmounting. Clicking outside the menu
	 * destroys this panel on mousedown, so without this a half-typed
	 * sample or URL was silently lost. */
	let savedDrafts = {
		sampleName: '',
		sampleContent: '',
		sampleExpanded: false,
		urlValue: '',
		urlLabel: ''
	};
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Link2, NotebookPen, Plus, Trash2 } from 'lucide-svelte';
	import { pushHistory } from '$lib/stores';

	type StyleReferenceType = 'workspace-file' | 'stored-sample' | 'url';
	interface StyleReference {
		id: string;
		label: string;
		type: StyleReferenceType;
		target: string;
		addedAt: number;
	}

	interface Props {
		activeTabId?: string | null;
		onSubmit?: (trigger: string) => void;
	}
	let { activeTabId = null, onSubmit }: Props = $props();

	let references = $state<StyleReference[]>([]);
	let loading = $state(true);
	let savingCurrent = $state(false);
	let savingSample = $state(false);
	let savingUrl = $state(false);

	let sampleName = $state(savedDrafts.sampleName);
	let sampleContent = $state(savedDrafts.sampleContent);
	let sampleExpanded = $state(savedDrafts.sampleExpanded);

	let urlValue = $state(savedDrafts.urlValue);
	let urlLabel = $state(savedDrafts.urlLabel);

	onDestroy(() => {
		savedDrafts = { sampleName, sampleContent, sampleExpanded, urlValue, urlLabel };
	});

	async function loadReferences() {
		loading = true;
		try {
			const res = await fetch('/api/references');
			const data = await res.json();
			references = Array.isArray(data?.references) ? data.references : [];
		} catch (e) {
			console.error('Failed to load references:', e);
		} finally {
			loading = false;
		}
	}

	async function addCurrentFile() {
		if (!activeTabId || savingCurrent) return;
		savingCurrent = true;
		try {
			await fetch('/api/references', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: 'add-current-file', tabId: activeTabId })
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Added style reference: ${activeTabId}`
			});
			await loadReferences();
			// Do not wake the writing agent — style analysis runs from the Style modal.
		} catch (e) {
			console.error('Failed to add current file reference:', e);
		} finally {
			savingCurrent = false;
		}
	}

	async function addSample() {
		const name = sampleName.trim();
		const content = sampleContent.trim();
		if (!name || !content || savingSample) return;
		savingSample = true;
		try {
			await fetch('/api/references', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: 'add-sample',
					name,
					content
				})
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Added stored style sample: ${name}`
			});
			const addedName = name;
			sampleName = '';
			sampleContent = '';
			sampleExpanded = false;
			await loadReferences();
			void addedName;
		} catch (e) {
			console.error('Failed to add stored sample:', e);
		} finally {
			savingSample = false;
		}
	}

	async function addUrl() {
		const url = urlValue.trim();
		if (!url || savingUrl) return;
		savingUrl = true;
		try {
			await fetch('/api/references', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: 'add-url',
					url,
					label: urlLabel.trim() || undefined
				})
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Added style reference URL: ${url}`
			});
			const addedUrl = url;
			const addedLabel = urlLabel.trim();
			urlValue = '';
			urlLabel = '';
			await loadReferences();
			void addedUrl;
			void addedLabel;
		} catch (e) {
			console.error('Failed to add URL reference:', e);
		} finally {
			savingUrl = false;
		}
	}

	async function removeReference(ref: StyleReference) {
		try {
			await fetch(`/api/references/${encodeURIComponent(ref.id)}`, { method: 'DELETE' });
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Removed style reference: ${ref.label}`
			});
			await loadReferences();
		} catch (e) {
			console.error('Failed to remove reference:', e);
		}
	}

	function typeLabel(type: StyleReferenceType): string {
		if (type === 'workspace-file') return 'Workspace file';
		if (type === 'stored-sample') return 'Saved sample';
		return 'URL';
	}

	onMount(() => {
		void loadReferences();
	});
</script>

<div class="references-panel">
	<div class="panel-header">
		<span class="panel-title">Writing references</span>
		<span class="panel-subtitle">optional style inspiration</span>
	</div>

	<div class="panel-copy">
		DocWriter only lists these references in the agent prompt. The agent can choose to read them if they would help with tone or cadence.
	</div>

	<div class="actions">
		<button
			class="action-btn"
			onclick={addCurrentFile}
			disabled={!activeTabId || savingCurrent}
			title={activeTabId ? `Add ${activeTabId} as a style reference` : 'Open a file first'}
		>
			<NotebookPen size={13} />
			<span>{activeTabId ? 'Use current file' : 'Open a file first'}</span>
		</button>

		<button class="action-btn" onclick={() => (sampleExpanded = !sampleExpanded)}>
			<Plus size={13} />
			<span>{sampleExpanded ? 'Hide pasted sample' : 'Paste a sample'}</span>
		</button>
	</div>

	{#if sampleExpanded}
		<div class="sample-form">
			<input
				class="field"
				bind:value={sampleName}
				placeholder="Sample name, e.g. book-voice.md"
			/>
			<textarea
				class="sample-input"
				bind:value={sampleContent}
				placeholder="Paste a writing sample here"
			></textarea>
			<button class="save-btn" onclick={addSample} disabled={!sampleName.trim() || !sampleContent.trim() || savingSample}>
				Save sample
			</button>
		</div>
	{/if}

	<div class="url-form">
		<div class="url-title">Add a style URL</div>
		<input class="field" bind:value={urlValue} placeholder="https://example.com/style-inspo" />
		<input class="field" bind:value={urlLabel} placeholder="Optional label" />
		<button class="save-btn secondary" onclick={addUrl} disabled={!urlValue.trim() || savingUrl}>
			<Link2 size={12} />
			<span>Add URL</span>
		</button>
	</div>

	{#if loading}
		<div class="empty">Loading…</div>
	{:else if references.length === 0}
		<div class="empty">No style references yet.</div>
	{:else}
		<div class="reference-list">
			{#each references as ref (ref.id)}
				<div class="reference-row">
					<div class="reference-meta">
						<div class="reference-label" title={ref.label}>{ref.label}</div>
						<div class="reference-kind">{typeLabel(ref.type)}</div>
					</div>
					<div class="reference-target" title={ref.target}>{ref.target}</div>
					<button class="remove-btn" onclick={() => removeReference(ref)} title="Remove reference">
						<Trash2 size={12} />
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.references-panel {
		width: 400px;
		padding: 14px 14px 12px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.panel-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 10px;
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
	.panel-copy {
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-muted);
		margin-bottom: 12px;
	}
	.actions {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.action-btn,
	.save-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 7px 10px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text-secondary);
		font: inherit;
		cursor: pointer;
	}
	.action-btn:hover:not(:disabled),
	.save-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.action-btn:disabled,
	.save-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.sample-form,
	.url-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		margin-bottom: 10px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-surface);
	}
	.url-title {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-faint);
	}
	.field,
	.sample-input {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		padding: 8px 10px;
		outline: none;
	}
	.field:focus,
	.sample-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.sample-input {
		min-height: 120px;
		resize: vertical;
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 12px;
		line-height: 1.45;
	}
	.save-btn {
		align-self: flex-start;
		background: var(--accent-bg);
		color: var(--accent);
		border-color: var(--accent-light);
	}
	.save-btn.secondary {
		background: var(--bg);
		border-color: var(--border-light);
		color: var(--text-secondary);
	}
	.reference-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.reference-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-surface);
	}
	.reference-meta {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 3px;
	}
	.reference-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reference-kind {
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.reference-target {
		grid-column: 1;
		font-size: 11.5px;
		color: var(--text-muted);
		font-family: 'SF Mono', 'Menlo', monospace;
		line-height: 1.45;
		word-break: break-word;
	}
	.remove-btn {
		grid-column: 2;
		grid-row: 1 / span 2;
		align-self: start;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
	}
	.remove-btn:hover {
		color: var(--diff-removed-color);
		background: var(--bg-hover);
	}
	.empty {
		font-size: 12px;
		color: var(--text-faint);
		padding: 8px 2px;
	}
</style>
