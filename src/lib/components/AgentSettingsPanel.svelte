<script lang="ts">
	import { agentSettings } from '$lib/stores';
	import type { AgentSettings } from '$lib/types';
	import { logUi } from '$lib/interaction-log-client';

	type Agency = AgentSettings['agency'];
	type SettingsChange = { type: 'agency'; from: Agency; to: Agency };

	interface Props {
		onSettingsChange: (s: AgentSettings, change?: SettingsChange) => void | Promise<void>;
	}
	let { onSettingsChange }: Props = $props();

	let settings: AgentSettings = $state({ agency: 'conservative', muted: false, paused: false });
	let previewAgency: Agency | null = $state(null);
	agentSettings.subscribe((v) => (settings = v));

	async function updateSettings(patch: Partial<AgentSettings>, change?: SettingsChange) {
		const next: AgentSettings = { ...settings, ...patch };
		agentSettings.set(next);
		await onSettingsChange(next, change);
	}

	// Keep internal `agency` name (matches AgentSettings type and AI
	// literature) but surface "autonomy" in the UI — reads more naturally
	// for writers.
	const autonomyLevels: Agency[] = ['conservative', 'balanced', 'aggressive'];
	const autonomyCopy: Record<Agency, { label: string; description: string }> = {
		conservative: {
			label: 'Low',
			description:
				'The agent acts only when you ask it to, or when something is clearly broken.'
		},
		balanced: {
			label: 'Medium',
			description:
				'The agent can proactively create new comment threads. It does not make edits unless you ask.'
		},
		aggressive: {
			label: 'High',
			description:
				'The agent can proactively create new comment threads and propose edits when it sees a useful improvement.'
		}
	};
	const visibleAgency = $derived(previewAgency ?? settings.agency);

	function selectAgency(level: Agency) {
		if (settings.agency === level) return;
		void updateSettings(
			{ agency: level },
			{ type: 'agency', from: settings.agency, to: level }
		);
	}
</script>

<div class="settings-panel" role="dialog">
	<div class="settings-header">
		<span class="settings-title">Agent behavior</span>
	</div>

	<div class="settings-section">
		<div class="setting-label">Autonomy</div>
		<div class="setting-hint">
			How willing the agent is to edit on its own initiative. Hover an option to preview it. Click to change it.
		</div>
		<div class="agency-slider">
			{#each autonomyLevels as level}
				<button
					class="agency-btn"
					class:active={settings.agency === level}
					type="button"
					aria-pressed={settings.agency === level}
					onmouseenter={() => {
						if (level !== settings.agency) logUi('ui.autonomy_preview', { level });
						previewAgency = level;
					}}
					onmouseleave={() => (previewAgency = null)}
					onfocus={() => (previewAgency = level)}
					onblur={() => (previewAgency = null)}
					onclick={() => selectAgency(level)}
				>
					{autonomyCopy[level].label}
				</button>
			{/each}
		</div>
		<div class="setting-detail">{autonomyCopy[visibleAgency].description}</div>
	</div>

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
		margin-bottom: 12px;
	}
	.settings-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.settings-section {
		margin-bottom: 16px;
	}
	.settings-section:last-child {
		margin-bottom: 0;
	}
	.setting-label {
		display: block;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 2px;
	}
	.setting-hint {
		display: block;
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-bottom: 8px;
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.setting-detail {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-top: 8px;
		padding: 8px 10px;
		background: var(--bg-surface);
		word-break: break-word;
		overflow-wrap: anywhere;
		border-radius: 6px;
	}
	.agency-slider {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 4px;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 3px;
	}
	.agency-btn {
		border: none;
		background: transparent;
		padding: 6px 10px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-faint);
		cursor: pointer;
		border-radius: 4px;
		font-family: inherit;
		transition: background 0.15s, color 0.15s;
	}
	.agency-btn:hover {
		color: var(--text-secondary);
	}
	.agency-btn.active {
		background: var(--bg-elevated);
		color: var(--accent);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
</style>
