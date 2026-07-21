<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { Cat } from 'lucide-svelte';
	import HistoryPane from './HistoryPane.svelte';
	import ShineBorder from './ShineBorder.svelte';
	import { dockExpanded, isRendering, submitCountdown, queuedSubmissionCount } from '$lib/stores';
	import { tooltip } from '$lib/actions/tooltip';

	interface Props {
		onNewSession?: () => void | Promise<void>;
		onWakeUp?: () => void;
		onCancel?: () => void;
		onToggleMuted?: () => void;
		/** Slot forwarded into HistoryPane's header (the AgentDock buttons). */
		dock?: Snippet;
	}
	let { onNewSession, onWakeUp, onCancel, onToggleMuted, dock }: Props = $props();

	let expanded = $state(false);
	dockExpanded.subscribe((v) => (expanded = v));

	let rendering = $state(false);
	let nudge = $state(false);
	let lastIdleAt = Date.now();
	const NUDGE_COOLDOWN_MS = 60_000;

	isRendering.subscribe((v) => {
		const wasIdle = !rendering;
		rendering = v;
		if (v && wasIdle && !expanded) {
			const idleFor = Date.now() - lastIdleAt;
			if (idleFor >= NUDGE_COOLDOWN_MS) {
				nudge = true;
				setTimeout(() => (nudge = false), 1200);
			}
		}
		if (!v) lastIdleAt = Date.now();
	});

	let countdown = $state(0);
	submitCountdown.subscribe((v) => (countdown = v));
	// Badge = messages the user has queued while a render is in flight, NOT
	// pending diffs. Pending-edit awareness lives on the tab dots.
	let queued = $state(0);
	queuedSubmissionCount.subscribe((v) => (queued = v));

	// Reserve bottom space so the lowest gutter card can scroll above the
	// fixed dock instead of hiding behind it. Measured from the live shell
	// element and published as a CSS var the editor gutter can consume.
	let shellEl: HTMLDivElement | null = $state(null);
	let resizeObserver: ResizeObserver | null = null;

	$effect(() => {
		// retrack on expand/collapse — the element swaps size
		expanded;
		if (typeof ResizeObserver === 'undefined') return;
		if (!resizeObserver) {
			resizeObserver = new ResizeObserver(publishReserved);
		}
		resizeObserver.disconnect();
		if (shellEl) resizeObserver.observe(shellEl);
		requestAnimationFrame(publishReserved);
	});

	function publishReserved() {
		if (typeof document === 'undefined') return;
		const h = shellEl ? shellEl.getBoundingClientRect().height : 0;
		document.documentElement.style.setProperty('--dock-reserved-bottom', `${Math.round(h) + 24}px`);
	}

	onDestroy(() => {
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (typeof document !== 'undefined') {
			document.documentElement.style.removeProperty('--dock-reserved-bottom');
		}
	});
</script>

<div class="dock-shell" class:expanded bind:this={shellEl}>
	{#if expanded}
		<div class="dock-panel">
			<HistoryPane
				{onNewSession}
				{onWakeUp}
				{onCancel}
				{onToggleMuted}
				{dock}
				onCollapse={() => dockExpanded.set(false)}
			/>
		</div>
	{:else}
		<ShineBorder
			active={rendering}
			radius={999}
			duration={2.5}
			borderWidth={1.5}
			size={45}
			thickness={10}
			color={['var(--accent)', 'var(--accent-subject)']}
		>
			{#snippet children()}
				<button
					class="dock-agent-btn"
					class:awake={rendering}
					class:nudge
					onclick={() => dockExpanded.set(true)}
					use:tooltip={'Open the agent dock'}
				>
					<span class="mascot-face" aria-hidden="true">
						<Cat size={16} strokeWidth={1.8} />
					</span>
					<span class="dock-label">Agent</span>
					<span class="header-status" aria-hidden="true">
						{#if rendering}
							<span class="bounce-dots"><span>.</span><span>.</span><span>.</span></span>
						{:else if countdown > 0}
							<span class="countdown">{countdown}s</span>
						{:else}
							<span class="sleep-dots"><span>z</span><span>z</span><span>z</span></span>
						{/if}
					</span>
					{#if queued > 0}
						<span class="pill-badge" aria-label="{queued} message{queued === 1 ? '' : 's'} queued">{queued}</span>
					{/if}
				</button>
			{/snippet}
		</ShineBorder>
	{/if}
</div>

<style>
	.dock-shell {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 150;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.dock-panel {
		width: min(420px, calc(100vw - 32px));
		height: min(600px, 70vh);
		background: var(--pane-bg);
		border: 1px solid var(--border-light);
		border-radius: 12px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22), 0 4px 12px rgba(0, 0, 0, 0.08);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	/* Collapsed pill — the exact same agent pill as the HistoryPane header
	 * (ShineBorder animated border while rendering, mascot bob/run, zzz idle,
	 * bouncing dots active), but a touch larger and with a visible floating
	 * chrome so it reads as a button on the canvas. */
	.dock-shell :global(.bb-host) {
		display: inline-flex;
		align-items: center;
	}
	.dock-agent-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 38px;
		padding: 0 16px 0 13px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text);
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 999px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
		cursor: pointer;
		white-space: nowrap;
		position: relative;
		transition: transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease, background 0.3s ease;
	}
	.dock-agent-btn:hover {
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
	}
	.dock-agent-btn.awake {
		border-color: transparent;
		background: var(--accent-bg);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
		animation: dock-glow 2s ease-in-out infinite;
	}
	.dock-agent-btn.nudge {
		animation: dock-nudge 1s cubic-bezier(0.22, 1, 0.36, 1), dock-glow 2s ease-in-out 1s infinite;
	}
	@keyframes dock-nudge {
		0% { transform: scale(1); }
		15% { transform: scale(1.35); }
		40% { transform: scale(1.1); }
		60% { transform: scale(1.2); }
		100% { transform: scale(1); }
	}
	@keyframes dock-glow {
		0%, 100% { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
		50% { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 0 0 6px color-mix(in srgb, var(--accent) 15%, transparent), 0 0 20px color-mix(in srgb, var(--accent) 20%, transparent); }
	}
	.dock-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.dock-agent-btn:hover .dock-label {
		color: var(--text);
	}
	.dock-agent-btn.awake .dock-label {
		color: var(--accent);
	}
	.mascot-face {
		display: inline-flex;
		align-items: center;
		color: var(--text-secondary);
		transform-origin: center bottom;
		animation: mascot-sleep-bob 3.2s ease-in-out infinite;
		transition: color 0.3s;
		flex-shrink: 0;
	}
	.dock-agent-btn.awake .mascot-face {
		color: var(--accent);
		animation: mascot-run 0.6s ease-in-out infinite;
	}
	@keyframes mascot-sleep-bob {
		0%, 100% { transform: scaleY(1) translateY(0); }
		50% { transform: scaleY(1.04) translateY(-1px); }
	}
	@keyframes mascot-run {
		0% { transform: translateY(0) rotate(-4deg) scaleY(1); }
		25% { transform: translateY(-5px) rotate(3deg) scaleY(1.05); }
		50% { transform: translateY(0) rotate(4deg) scaleY(1); }
		75% { transform: translateY(-3px) rotate(-3deg) scaleY(1.05); }
		100% { transform: translateY(0) rotate(-4deg) scaleY(1); }
	}
	.header-status {
		display: inline-flex;
		align-items: center;
		min-width: 16px;
	}
	.sleep-dots,
	.bounce-dots {
		display: inline-flex;
		gap: 1px;
		font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-faint);
	}
	.bounce-dots {
		color: var(--accent);
		font-weight: 700;
	}
	.countdown {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}
	.sleep-dots span {
		opacity: 0;
		animation: header-sleep-z 2.4s ease-in-out infinite;
	}
	.sleep-dots span:nth-child(1) { animation-delay: 0s; }
	.sleep-dots span:nth-child(2) { animation-delay: 0.5s; }
	.sleep-dots span:nth-child(3) { animation-delay: 1s; }
	.bounce-dots span {
		display: inline-block;
		animation: header-dot-bounce 1.2s ease-in-out infinite;
	}
	.bounce-dots span:nth-child(1) { animation-delay: 0s; }
	.bounce-dots span:nth-child(2) { animation-delay: 0.2s; }
	.bounce-dots span:nth-child(3) { animation-delay: 0.4s; }
	@keyframes header-sleep-z {
		0% { opacity: 0; transform: translateY(2px) scale(0.8); }
		20% { opacity: 0.8; transform: translateY(-1px) scale(1); }
		60% { opacity: 0.8; transform: translateY(-3px) scale(1); }
		100% { opacity: 0; transform: translateY(-5px) scale(0.9); }
	}
	@keyframes header-dot-bounce {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
		30% { transform: translateY(-2px); opacity: 1; }
	}
	.pill-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: var(--accent);
		color: #fff;
		font-size: 11px;
		font-weight: 600;
	}
	/* 14" laptop widths: the fixed pill starts eating into the comment
	 * margin, so drop the AGENT wordmark and keep just the mascot + live
	 * status (countdown / dots / zzz). Pairs with the narrower
	 * --paper-width / --comment-width overrides in +page.svelte. */
	@media (max-width: 1600px) {
		.dock-label {
			display: none;
		}
		.dock-agent-btn {
			padding: 0 13px;
		}
	}
</style>
