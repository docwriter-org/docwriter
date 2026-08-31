<script lang="ts">
	import { onMount } from 'svelte';
	import { showConfirm } from '$lib/dialogs';

	interface TabResetResult {
		tabId: string;
		reviewsCleared: number;
		commentsCleared: number;
		yjsUpdate: string | null;
	}

	interface Props {
		onApplied?: (tabs: TabResetResult[]) => void;
	}
	let { onApplied }: Props = $props();

	interface WorkspaceInfo {
		root: string;
		stateDir: string;
		name: string;
		cwd: string;
		warning: string | null;
	}

	let info = $state<WorkspaceInfo | null>(null);
	let error = $state<string | null>(null);
	let status = $state<string | null>(null);
	let busy = $state<'reviews' | 'comments' | 'both' | null>(null);

	async function load() {
		try {
			const res = await fetch('/api/workspace');
			if (!res.ok) throw new Error(`Failed to load workspace (${res.status})`);
			info = (await res.json()) as WorkspaceInfo;
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(() => {
		void load();
	});

	async function resetUi(
		kind: 'reviews' | 'comments' | 'both',
		confirm: { title: string; message: string }
	) {
		const ok = await showConfirm(confirm.message, {
			title: confirm.title,
			confirmLabel: 'Clear',
			danger: true
		});
		if (!ok) return;
		busy = kind;
		error = null;
		status = null;
		try {
			const res = await fetch('/api/workspace', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'reset_ui',
					reviews: kind === 'reviews' || kind === 'both',
					comments: kind === 'comments' || kind === 'both'
				})
			});
			const data = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				error?: string;
				reviewsCleared?: number;
				commentsCleared?: number;
				tabs?: TabResetResult[];
			};
			if (!res.ok || !data.ok) {
				throw new Error(data.error || `Reset failed (${res.status})`);
			}
			onApplied?.(data.tabs ?? []);
			const parts: string[] = [];
			if (kind === 'reviews' || kind === 'both') {
				parts.push(
					`${data.reviewsCleared ?? 0} pending review${(data.reviewsCleared ?? 0) === 1 ? '' : 's'}`
				);
			}
			if (kind === 'comments' || kind === 'both') {
				parts.push(
					`${data.commentsCleared ?? 0} comment thread${(data.commentsCleared ?? 0) === 1 ? '' : 's'}`
				);
			}
			status = `Cleared ${parts.join(' and ')}. Workspace files are unchanged.`;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}
</script>

<div class="settings-panel" role="dialog">
	<div class="settings-header">
		<span class="settings-title">Workspace</span>
	</div>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	{#if !info}
		<div class="muted">Loading…</div>
	{:else}
		<div class="intro">
			DocWriter state for this folder lives in <code>.docwriter</code>, not in the
			directory you ran the command from (unless they are the same).
		</div>

		<div class="field">
			<div class="field-label">Opened folder</div>
			<div class="field-value" title={info.root}>{info.root}</div>
		</div>
		<div class="field">
			<div class="field-label">State directory</div>
			<div class="field-value" title={info.stateDir}>{info.stateDir}</div>
		</div>

		{#if info.warning}
			<div class="warning">{info.warning}</div>
		{/if}

		{#if status}
			<div class="status">{status}</div>
		{/if}

		<div class="settings-section">
			<div class="setting-label">Reset review UI</div>
			<div class="setting-hint">
				Clear stuck pending reviews or comment threads without deleting the
				database or your files. Use this when Accept, Reject, or Dismiss no
				longer works. New session does not remove comment threads.
			</div>
			<div class="actions">
				<button
					class="btn"
					type="button"
					disabled={busy !== null}
					onclick={() =>
						void resetUi('reviews', {
							title: 'Clear pending reviews',
							message:
								'Remove every pending agent edit in this workspace. Document text, comments, rules, and settings stay. You cannot recover a cleared proposal unless you undo immediately.'
						})}
				>
					{busy === 'reviews' ? 'Clearing…' : 'Clear pending reviews'}
				</button>
				<button
					class="btn"
					type="button"
					disabled={busy !== null}
					onclick={() =>
						void resetUi('comments', {
							title: 'Clear comment threads',
							message:
								'Remove every comment thread in this workspace. Document text, pending reviews, rules, and settings stay. This cannot be undone after later edits replace undo history.'
						})}
				>
					{busy === 'comments' ? 'Clearing…' : 'Clear comment threads'}
				</button>
				<button
					class="btn danger"
					type="button"
					disabled={busy !== null}
					onclick={() =>
						void resetUi('both', {
							title: 'Reset review UI',
							message:
								'Remove every pending review and comment thread in this workspace. Document text, rules, hooks, and settings stay. This is the recovery step when gutter cards will not accept or dismiss.'
						})}
				>
					{busy === 'both' ? 'Resetting…' : 'Reset review UI'}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.settings-panel {
		width: 360px;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		padding: 14px 16px 16px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.settings-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.intro,
	.setting-hint {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-bottom: 12px;
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.intro code {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		background: var(--bg-surface);
		padding: 1px 4px;
		border-radius: 4px;
	}
	.field {
		margin-bottom: 10px;
	}
	.field-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 2px;
	}
	.field-value {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		line-height: 1.45;
		word-break: break-all;
		color: var(--text);
	}
	.warning,
	.error,
	.status {
		font-size: 12px;
		line-height: 1.45;
		border-radius: 6px;
		padding: 7px 8px;
		margin-bottom: 12px;
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.warning {
		color: #92400e;
		background: #fffbeb;
		border: 1px solid #fde68a;
	}
	.error {
		color: #b91c1c;
		background: #fef2f2;
	}
	.status {
		color: #166534;
		background: #f0fdf4;
	}
	.muted {
		font-size: 12px;
		color: var(--text-muted);
	}
	.settings-section {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--border-light);
	}
	.setting-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 4px;
	}
	.actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.btn {
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		padding: 7px 10px;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
	}
	.btn:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.btn.danger {
		color: #b91c1c;
		border-color: #fecaca;
		background: #fef2f2;
	}
	.btn.danger:hover:not(:disabled) {
		background: #fee2e2;
	}
</style>
