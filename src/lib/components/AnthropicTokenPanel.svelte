<script lang="ts">
	import { onMount } from 'svelte';
	import { CheckCircle2, KeyRound, Trash2 } from 'lucide-svelte';

	interface Props {
		onSaved?: () => void | Promise<void>;
	}

	let { onSaved }: Props = $props();

	let token = $state('');
	let configured = $state(false);
	let source = $state<'cookie' | 'saved' | 'environment' | 'none'>('none');
	let busy = $state(false);
	let message = $state('');
	let errorMessage = $state('');

	const sourceLabel: Record<typeof source, string> = {
		cookie: 'Saved for this browser',
		saved: 'Saved in this workspace',
		environment: 'Configured by environment',
		none: 'Not configured'
	};

	async function loadStatus() {
		const res = await fetch('/api/anthropic-token');
		if (!res.ok) return;
		const data = await res.json();
		configured = Boolean(data.configured);
		source = data.source ?? 'none';
	}

	onMount(() => {
		void loadStatus();
	});

	async function saveToken() {
		busy = true;
		message = '';
		errorMessage = '';
		try {
			const res = await fetch('/api/anthropic-token', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
			configured = Boolean(data.configured);
			source = data.source ?? 'saved';
			token = '';
			message = 'Saved';
			await onSaved?.();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Unable to save key';
		} finally {
			busy = false;
		}
	}

	async function clearToken() {
		busy = true;
		message = '';
		errorMessage = '';
		try {
			const res = await fetch('/api/anthropic-token', { method: 'DELETE' });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
			configured = Boolean(data.configured);
			source = data.source ?? 'none';
			token = '';
			message = configured ? 'Cleared saved key' : 'Cleared';
			await onSaved?.();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Unable to clear key';
		} finally {
			busy = false;
		}
	}
</script>

<div class="token-panel" role="dialog" aria-label="Anthropic API key">
	<div class="token-header">
		<div class="token-title"><KeyRound size={14} /> Anthropic API key</div>
		<div class="token-status" class:configured>
			{#if configured}<CheckCircle2 size={13} />{/if}
			{sourceLabel[source]}
		</div>
	</div>

	<div class="token-row">
		<input
			type="password"
			autocomplete="off"
			placeholder="sk-ant-..."
			bind:value={token}
			onkeydown={(e) => {
				if (e.key === 'Enter' && token && !busy) void saveToken();
			}}
		/>
		<button type="button" disabled={busy || !token.trim()} onclick={saveToken}>Save</button>
	</div>

	<div class="token-actions">
		<button type="button" class="clear-btn" disabled={busy || source === 'none'} onclick={clearToken}>
			<Trash2 size={13} /> Clear
		</button>
		{#if message}<span class="token-message">{message}</span>{/if}
		{#if errorMessage}<span class="token-error">{errorMessage}</span>{/if}
	</div>
</div>

<style>
	.token-panel {
		width: 300px;
		padding: 12px;
		background: var(--bg-elevated);
		color: var(--text);
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
	}

	.token-header {
		display: grid;
		gap: 6px;
		margin-bottom: 10px;
	}

	.token-title,
	.token-status,
	.token-actions,
	.clear-btn {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.token-title {
		font-weight: 650;
		font-size: 13px;
	}

	.token-status {
		color: var(--text-muted);
		font-size: 12px;
	}

	.token-status.configured {
		color: var(--accent);
	}

	.token-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px;
	}

	input {
		min-width: 0;
		height: 30px;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--bg);
		color: var(--text);
		padding: 0 9px;
		font: inherit;
		font-size: 12px;
	}

	input:focus {
		outline: 1px solid var(--accent);
		outline-offset: 0;
	}

	button {
		height: 30px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--bg-hover);
		color: var(--text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.token-row button {
		padding: 0 10px;
	}

	.token-actions {
		min-height: 24px;
		margin-top: 8px;
		justify-content: space-between;
		font-size: 12px;
	}

	.clear-btn {
		padding: 0 8px;
		background: transparent;
	}

	.token-message {
		color: var(--accent);
	}

	.token-error {
		color: #b42318;
		text-align: right;
	}
</style>
