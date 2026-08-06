<script lang="ts">
	import { agentSettings } from '$lib/stores';
	import type { AgentSettings } from '$lib/types';

	interface Props {
		onSave: (audience: string) => void | Promise<void>;
	}
	let { onSave }: Props = $props();

	const PLACEHOLDER =
		'Busy engineering managers who already know Kubernetes; skip basics, keep examples concrete and short.';

	let settings: AgentSettings = $state({
		agency: 'conservative',
		muted: false,
		paused: false,
		intendedAudience: ''
	});
	let draft = $state('');
	let dirty = $state(false);

	agentSettings.subscribe((v) => {
		settings = v;
		// Keep the draft in sync when settings arrive from the server or
		// another surface, but don't clobber in-progress typing.
		if (!dirty) draft = v.intendedAudience ?? '';
	});

	const canSave = $derived(dirty && draft.trim() !== (settings.intendedAudience ?? '').trim());
	const canClear = $derived((settings.intendedAudience ?? '').trim().length > 0 || draft.trim().length > 0);

	function onInput(e: Event) {
		draft = (e.target as HTMLTextAreaElement).value;
		dirty = true;
	}

	async function save() {
		const next = draft.trim();
		dirty = false;
		draft = next;
		await onSave(next);
	}

	async function clear() {
		draft = '';
		dirty = false;
		await onSave('');
	}
</script>

<div class="audience-panel" role="dialog">
	<span class="panel-title">Intended audience</span>
	<div class="setting-label">Who are you writing for?</div>
	<textarea
		class="audience-input"
		value={draft}
		oninput={onInput}
		placeholder={PLACEHOLDER}
		rows="5"
	></textarea>
	<div class="panel-actions">
		<button class="btn" type="button" onclick={() => void clear()} disabled={!canClear}>Clear</button>
		<button class="btn primary" type="button" onclick={() => void save()} disabled={!canSave}>Save</button>
	</div>
</div>

<style>
	.audience-panel {
		width: 340px;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		padding: 14px 16px 16px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.panel-title {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 12px;
	}
	.setting-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 8px;
	}
	.audience-input {
		width: 100%;
		min-height: 110px;
		resize: vertical;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 13px;
		line-height: 1.5;
		padding: 9px 10px;
		outline: none;
		box-sizing: border-box;
	}
	.audience-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-light);
	}
	.audience-input::placeholder {
		color: var(--text-faint);
	}
	.panel-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 14px;
	}
	.btn {
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		border-radius: 6px;
		padding: 6px 11px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-secondary);
		cursor: pointer;
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.btn.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: white;
	}
	.btn.primary:disabled {
		opacity: 0.45;
	}
</style>
