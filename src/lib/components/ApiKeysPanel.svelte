<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';

	interface KeyStatus {
		id: string;
		label: string;
		envVar: string;
		required: boolean;
		present: boolean;
		usable: boolean;
		source: 'env' | 'login' | null;
		altAuthNote?: string;
	}

	let providers = $state<KeyStatus[]>([]);
	let drafts = $state<Record<string, string>>({});
	let saving = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	const hosted = env.PUBLIC_DOCWRITER_HOSTED === '1';

	async function load() {
		if (hosted) {
			loaded = true;
			return;
		}
		try {
			const res = await fetch('/api/keys');
			const data = await res.json();
			providers = data.providers ?? [];
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loaded = true;
		}
	}

	onMount(load);

	async function save(envVar: string) {
		const value = (drafts[envVar] ?? '').trim();
		if (!value) return;
		saving = envVar;
		error = null;
		try {
			const res = await fetch('/api/keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ envVar, value })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? 'failed to save');
			providers = data.providers ?? providers;
			drafts = { ...drafts, [envVar]: '' };
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = null;
		}
	}

	async function clear(envVar: string) {
		saving = envVar;
		error = null;
		try {
			const res = await fetch('/api/keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ envVar, value: '' })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? 'failed to clear');
			providers = data.providers ?? providers;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = null;
		}
	}

	function statusLabel(p: KeyStatus): string {
		if (p.present) return 'Key set';
		if (p.usable && p.source === 'login') return 'Using login';
		if (p.required) return 'Missing';
		return 'Optional';
	}
	function statusClass(p: KeyStatus): string {
		if (p.present) return 'ok';
		if (p.usable) return 'login';
		if (p.required) return 'missing';
		return 'optional';
	}
</script>

<div class="settings-panel" role="dialog">
	<div class="settings-header">
		<span class="settings-title">API keys</span>
	</div>

	<div class="intro">
		{#if hosted}
			API keys are managed by the hosted deployment. Key editing is only available when self-hosting.
		{:else}
			Stored in <code>~/.docwriter/keys.env</code> and shared across all workspaces.
			Environment variables (and the repo <code>.env</code>) override these.
		{/if}
	</div>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	{#if hosted}
		<div class="disabled-note">
			Self-host DocWriter to configure provider API keys from this panel.
		</div>
	{:else if !loaded}
		<div class="muted">Loading…</div>
	{:else}
		{#each providers as p (p.envVar)}
			<div class="key-row">
				<div class="key-head">
					<span class="key-name">{p.label}</span>
					<span class="badge {statusClass(p)}">{statusLabel(p)}</span>
				</div>
				<div class="env-var"><code>{p.envVar}</code></div>
				{#if !p.present && p.usable && p.altAuthNote}
					<div class="alt-note">{p.altAuthNote}</div>
				{/if}
				<div class="key-input">
					<input
						type="password"
						placeholder={p.present ? 'Replace key…' : `Paste ${p.envVar}…`}
						bind:value={drafts[p.envVar]}
						onkeydown={(e) => e.key === 'Enter' && save(p.envVar)}
					/>
					<button
						class="save-btn"
						disabled={saving === p.envVar || !(drafts[p.envVar] ?? '').trim()}
						onclick={() => save(p.envVar)}
					>
						{saving === p.envVar ? '…' : 'Save'}
					</button>
				</div>
				{#if p.present}
					<button class="clear-btn" onclick={() => clear(p.envVar)}>Remove stored key</button>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<style>
	.settings-panel {
		width: 340px;
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
	.intro {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-bottom: 14px;
	}
	.intro code,
	.env-var code {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		background: var(--bg-surface);
		padding: 1px 4px;
		border-radius: 4px;
	}
	.error {
		font-size: 12px;
		color: #b91c1c;
		background: #fef2f2;
		border-radius: 6px;
		padding: 6px 8px;
		margin-bottom: 10px;
	}
	.disabled-note {
		font-size: 12px;
		color: var(--text-muted);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px 10px;
		line-height: 1.45;
	}
	.muted {
		font-size: 12px;
		color: var(--text-muted);
	}
	.key-row {
		padding: 10px 0;
		border-top: 1px solid var(--border-light);
	}
	.key-row:first-of-type {
		border-top: none;
	}
	.key-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 4px;
	}
	.key-name {
		font-size: 13px;
		font-weight: 600;
	}
	.badge {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 6px;
		border-radius: 10px;
	}
	.badge.ok {
		color: #15803d;
		background: #dcfce7;
	}
	.badge.login {
		color: #1d4ed8;
		background: #dbeafe;
	}
	.badge.missing {
		color: #b91c1c;
		background: #fee2e2;
	}
	.badge.optional {
		color: var(--text-faint);
		background: var(--bg-surface);
	}
	.env-var {
		margin-bottom: 6px;
	}
	.alt-note {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.45;
		margin-bottom: 8px;
	}
	.key-input {
		display: flex;
		gap: 6px;
	}
	.key-input input {
		flex: 1;
		min-width: 0;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		padding: 6px 8px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text);
	}
	.save-btn {
		border: none;
		background: var(--accent);
		color: white;
		font-size: 12px;
		font-weight: 600;
		padding: 0 12px;
		border-radius: 6px;
		cursor: pointer;
	}
	.save-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.clear-btn {
		margin-top: 6px;
		border: none;
		background: none;
		color: var(--text-faint);
		font-size: 11.5px;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
</style>
