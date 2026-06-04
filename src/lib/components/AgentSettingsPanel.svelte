<script lang="ts">
	import { agentSettings } from '$lib/stores';
	import type { AgentSettings } from '$lib/types';

	interface Props {
		onSettingsChange: (s: AgentSettings) => void;
	}
	let { onSettingsChange }: Props = $props();

	let settings: AgentSettings = $state({ agency: 'conservative', muted: false });
	agentSettings.subscribe((v) => (settings = v));

	function updateSettings(patch: Partial<AgentSettings>) {
		const next: AgentSettings = { ...settings, ...patch };
		agentSettings.set(next);
		onSettingsChange(next);
	}

	// Keep internal `agency` name (matches AgentSettings type and AI
	// literature) but surface "autonomy" in the UI — reads more naturally
	// for writers.
	const autonomyButtonLabels: Record<AgentSettings['agency'], string> = {
		conservative: 'Low',
		balanced: 'Medium',
		aggressive: 'High'
	};
	const autonomyDescription: Record<AgentSettings['agency'], string> = {
		conservative:
			'The agent edits only when you ask it to, or when it finds an obvious typo or broken sentence. It will ignore prose that seems fine, even if it could be better.',
		balanced:
			'The agent will make one focused edit per round if it spots a clear problem — a clunky sentence, a confusing pronoun, a missing piece you asked for. It will not rewrite prose that is already working.',
		aggressive:
			'The agent actively looks for ways to improve the draft each round: tighten wordy passages, strengthen weak verbs, smooth out flow. It tries to preserve your voice but will not wait for permission.'
	};
</script>

<div class="settings-panel" role="dialog">
	<div class="settings-header">
		<span class="settings-title">Agent behavior</span>
	</div>

	<div class="settings-section">
		<div class="setting-label">Autonomy</div>
		<div class="setting-hint">
			How willing the agent is to edit on its own initiative.
		</div>
		<div class="agency-slider">
			{#each ['conservative', 'balanced', 'aggressive'] as level}
				<button
					class="agency-btn"
					class:active={settings.agency === level}
					onclick={() => updateSettings({ agency: level as AgentSettings['agency'] })}
				>
					{autonomyButtonLabels[level as AgentSettings['agency']]}
				</button>
			{/each}
		</div>
		<div class="setting-detail">{autonomyDescription[settings.agency]}</div>
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
