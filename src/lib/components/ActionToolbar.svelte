<script lang="ts">
	import {
		Scissors,
		Bot,
		Wrench,
		XCircle,
		Lightbulb,
		Zap,
		HelpCircle,
		MessageSquare,
		ArrowRight
	} from 'lucide-svelte';
	import type { Action } from '$lib/types';
	import { pinnedActions, recentActions, selectedAction } from '$lib/stores';

	const iconMap: Record<string, typeof Scissors> = {
		scissors: Scissors,
		bot: Bot,
		wrench: Wrench,
		'x-circle': XCircle,
		lightbulb: Lightbulb,
		zap: Zap,
		'help-circle': HelpCircle,
		'message-square': MessageSquare,
		'arrow-right': ArrowRight
	};

	function selectAction(action: Action) {
		selectedAction.update((current) => (current?.id === action.id ? null : action));
		if (!action.pinned) {
			recentActions.update((prev) => [action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6));
		}
	}

	let recent: Action[] = $state([]);
	recentActions.subscribe((v) => (recent = v));

	let selected: Action | null = $state(null);
	selectedAction.subscribe((v) => (selected = v));
</script>

<div class="toolbar">
	{#each pinnedActions as action}
		<button
			class="action-btn"
			class:active={selected?.id === action.id}
			style:--action-color={action.color}
			title={action.label}
			onclick={() => selectAction(action)}
		>
			{action.label}
		</button>
	{/each}

	{#if recent.length > 0}
		<div class="divider"></div>
	{/if}

	{#each recent.slice(0, 4) as action}
		{@const Icon = iconMap[action.icon]}
		<button
			class="action-btn recent"
			class:active={selected?.id === action.id}
			style:--action-color={action.color}
			title={action.label}
			onclick={() => selectAction(action)}
		>
			{#if Icon}<Icon size={12} />{/if}
			<span>{action.label}</span>
		</button>
	{/each}
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		background: var(--bg-surface);
		border-radius: 7px;
		padding: 3px;
		border: 1px solid var(--border-light);
	}
	.action-btn {
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		font-family: inherit;
		padding: 0 10px;
		font-size: 13px;
		white-space: nowrap;
	}
	.action-btn.active {
		background: color-mix(in srgb, var(--action-color) 15%, transparent);
		color: var(--action-color);
	}
	.action-btn:hover:not(.active) {
		background: var(--bg-hover);
	}
	.divider {
		width: 1px;
		height: 16px;
		background: var(--border-light);
		margin: 0 2px;
	}
</style>
