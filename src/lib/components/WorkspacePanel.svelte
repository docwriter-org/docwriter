<script lang="ts">
	import { onMount } from 'svelte';
	import { showConfirm } from '$lib/dialogs';

	interface TabResetResult {
		tabId: string;
		reviewsCleared: number;
		commentsCleared: number;
		yjsUpdate: string | null;
	}

	interface LeftoverTab {
		tabId: string;
		kind: 'closed' | 'missing';
		hasUpdates: boolean;
		hasLastSeen: boolean;
		listed: boolean;
		intentionallyClosed: boolean;
		updateCount: number;
		lastActivity: number | null;
	}

	interface Props {
		onApplied?: (tabs: TabResetResult[]) => void;
		onTabsChanged?: () => void | Promise<void>;
	}
	let { onApplied, onTabsChanged }: Props = $props();

	interface WorkspaceInfo {
		root: string;
		stateDir: string;
		name: string;
		cwd: string;
		warning: string | null;
		leftovers?: LeftoverTab[];
	}

	let info = $state<WorkspaceInfo | null>(null);
	let leftovers = $state<LeftoverTab[]>([]);
	let error = $state<string | null>(null);
	let status = $state<string | null>(null);
	let busy = $state<'reviews' | 'comments' | 'both' | string | null>(null);

	async function load() {
		try {
			const res = await fetch('/api/workspace');
			if (!res.ok) throw new Error(`Failed to load workspace (${res.status})`);
			const data = (await res.json()) as WorkspaceInfo;
			info = data;
			leftovers = data.leftovers ?? [];
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

	async function leftoverAction(kind: 'reopen_tab' | 'purge_tab', tabId: string) {
		if (kind === 'purge_tab') {
			const ok = await showConfirm(
				`Remove leftover DocWriter state for "${tabId}"? The workspace file stays if it is still on disk. Comments, pending reviews, and the CRDT history for this path are deleted.`,
				{ title: 'Purge leftover tab', confirmLabel: 'Purge', danger: true }
			);
			if (!ok) return;
		}
		busy = `${kind}:${tabId}`;
		error = null;
		status = null;
		try {
			const res = await fetch('/api/workspace', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: kind, tabId })
			});
			const data = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				error?: string;
				leftovers?: LeftoverTab[];
			};
			if (!res.ok || !data.ok) {
				throw new Error(data.error || `Request failed (${res.status})`);
			}
			leftovers = data.leftovers ?? [];
			await onTabsChanged?.();
			status =
				kind === 'reopen_tab'
					? `Reopened ${tabId}.`
					: `Purged leftover state for ${tabId}.`;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}

	function leftoverHint(item: LeftoverTab): string {
		const updates =
			item.updateCount === 1 ? '1 saved update' : `${item.updateCount} saved updates`;
		if (item.kind === 'closed' && item.intentionallyClosed) {
			return `You closed this tab. ${updates}.`;
		}
		if (item.kind === 'closed') {
			return `Dropped from the tab list; the file is still here. ${updates}.`;
		}
		return `Not in the tab list and the file is missing. ${updates}.`;
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

		<div class="settings-section">
			<div class="setting-label">Leftover tab state</div>
			<div class="setting-hint">
				A dropped writing tab is put back automatically when you reload.
				This list is for tabs you closed on purpose, preview files with
				leftover history, or paths whose files are gone. Reopen keeps
				the history. Purge forgets it.
			</div>
			{#if leftovers.length === 0}
				<div class="muted">No leftover tab state.</div>
			{:else}
				<ul class="leftover-list">
					{#each leftovers as item (item.tabId)}
						<li class="leftover">
							<div class="leftover-path" title={item.tabId}>{item.tabId}</div>
							<div class="leftover-meta">{leftoverHint(item)}</div>
							<div class="leftover-actions">
								{#if item.kind === 'closed'}
									<button
										class="btn"
										type="button"
										disabled={busy !== null}
										onclick={() => void leftoverAction('reopen_tab', item.tabId)}
									>
										{busy === `reopen_tab:${item.tabId}` ? 'Opening…' : 'Reopen'}
									</button>
								{/if}
								<button
									class="btn danger"
									type="button"
									disabled={busy !== null}
									onclick={() => void leftoverAction('purge_tab', item.tabId)}
								>
									{busy === `purge_tab:${item.tabId}` ? 'Purging…' : 'Purge'}
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.leftover-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.leftover {
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px;
		background: var(--bg-surface);
	}
	.leftover-path {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		word-break: break-all;
		margin-bottom: 3px;
	}
	.leftover-meta {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.4;
		margin-bottom: 6px;
	}
	.leftover-actions {
		display: flex;
		gap: 6px;
	}
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
