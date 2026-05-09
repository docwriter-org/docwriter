<script lang="ts">
	import { Cat, Send } from 'lucide-svelte';
	import ChatPanel from './ChatPanel.svelte';
	import {
		isRendering,
		submitCountdown,
		agentSettings,
		pendingReviewRounds,
		sessionCost,
		queuedSubmissionCount,
		type SessionCost
	} from '$lib/stores';
	import ShineBorder from './ShineBorder.svelte';

	interface Props {
		onSubmit: () => void;
		onSendMessage: (message: string, opts: { planMode: boolean }) => void;
	}
	let { onSubmit, onSendMessage }: Props = $props();

	let rendering = $state(false);
	isRendering.subscribe((v) => (rendering = v));

	let countdown = $state(0);
	submitCountdown.subscribe((v) => (countdown = v));

	// `silent` treatment on the mascot card is driven by the
	// trackChanges agent setting (surfaced via Settings menu).
	let silent = $state(false);
	agentSettings.subscribe((v) => (silent = !v.trackChanges));

	// Active pending review count (active tab only). Drives a softer shine
	// on the dock when edits are waiting for Accept/Reject, so the user
	// notices without having to watch the outline pane.
	let pendingCount = $state(0);
	pendingReviewRounds.subscribe((v) => (pendingCount = v.length));

	let queuedCount = $state(0);
	queuedSubmissionCount.subscribe((v) => (queuedCount = v));

	let cost = $state<SessionCost>({
		totalCostUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		rounds: 0
	});
	sessionCost.subscribe((v) => (cost = v));

	/** Human-readable cost label: "$0.042" / "1.2¢". Below a cent, show
	 * cents with one decimal to be less noisy. */
	function formatCost(usd: number): string {
		if (usd === 0) return '$0';
		if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
		if (usd < 1) return `${(usd * 100).toFixed(1)}¢`;
		return `$${usd.toFixed(2)}`;
	}
	function formatTokens(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	}

	// Shine is active whenever the agent is working OR there's something
	// awaiting review. Working: bright accent gradient. Pending: softer
	// accent-only glow so it reads as "check this" not "in progress".
	let shineActive = $derived(rendering || pendingCount > 0);
	let shineColors = $derived(
		rendering
			? ['var(--accent)', 'var(--accent-light)', 'var(--accent)']
			: ['var(--accent-light)', 'var(--accent-light)', 'var(--accent-light)']
	);

	let chatOpen = $state(false);
	let chatPopoverEl: HTMLDivElement | null = $state(null);

	function toggleChat() {
		chatOpen = !chatOpen;
	}

	function sendMessage(message: string, opts: { planMode: boolean }) {
		onSendMessage(message, opts);
		// While the agent is working, the message gets queued — keep the
		// popover open so the user can see the queued count tick up and
		// fire off another follow-up without re-clicking the dock button.
		if (!rendering) chatOpen = false;
	}

	$effect(() => {
		if (!chatOpen) return;
		function onDown(e: MouseEvent) {
			const target = e.target as Node | null;
			if (chatPopoverEl && target && !chatPopoverEl.contains(target)) chatOpen = false;
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') chatOpen = false;
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="agent-dock">
	<!-- Colors pull from the active theme (CSS vars) so the shine matches
	     light/dark/sepia/etc. instead of a fixed purple gradient.
	     Active while rendering OR while edits are pending review. -->
	<ShineBorder
		active={shineActive}
		radius={12}
		duration={rendering ? 6 : 12}
		borderWidth={1.5}
		color={shineColors}
	>
		{#snippet children()}
			<button
				class="dock-card"
				class:awake={rendering}
				class:pending={!rendering && pendingCount > 0}
				class:silent
				onclick={onSubmit}
				disabled={rendering}
				aria-label={rendering ? 'Agent is working' : 'Wake up agent'}
			>
				<span class="mascot-face" aria-hidden="true">
					<Cat size={28} strokeWidth={1.6} />
				</span>
				<span class="dock-info">
					<span class="dock-label">
						{#if rendering}
							Working
						{:else}
							Wake up{#if countdown > 0}
								<span class="countdown">&nbsp;{countdown}s</span>
							{/if}
						{/if}
					</span>
					<span class="dock-status">
						{#if rendering}
							<span class="bounce-dots" aria-hidden="true">
								<span>.</span><span>.</span><span>.</span>
							</span>
						{:else}
							<span class="sleep-dots" aria-hidden="true">
								<span>z</span><span>z</span><span>z</span>
							</span>
						{/if}
					</span>
				</span>
			</button>
		{/snippet}
	</ShineBorder>
	<div class="dock-footer">
		{#if cost.rounds > 0}
			<div
				class="dock-cost"
				title={`${cost.rounds} round${cost.rounds === 1 ? '' : 's'} · ${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out · ${formatTokens(cost.cacheReadTokens)} cache read`}
			>
				{formatCost(cost.totalCostUsd)}
			</div>
		{/if}
		<button
			class="dock-message-btn"
			class:has-queue={queuedCount > 0}
			type="button"
			aria-pressed={chatOpen}
			title={queuedCount > 0
				? `${queuedCount} message${queuedCount === 1 ? '' : 's'} queued — will run after the current render`
				: rendering
					? 'Queue a follow-up message'
					: 'Send message'}
			onclick={toggleChat}
		>
			<Send size={12} />
			{#if queuedCount > 0}
				<span class="queue-badge">{queuedCount}</span>
			{/if}
		</button>
	</div>
	{#if chatOpen}
		<div class="dock-chat-popover" bind:this={chatPopoverEl}>
			<ChatPanel onSend={sendMessage} rendering={rendering} queuedCount={queuedCount} />
		</div>
	{/if}
</div>

<style>
	.agent-dock {
		position: absolute;
		top: 48px;
		right: 16px;
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.dock-footer {
		display: flex;
		align-items: center;
		gap: 6px;
		position: relative;
	}
	/* Tiny cost badge under the dock card. Monospace digits so the width
	 * stays stable as cost grows. Hover for full usage breakdown. */
	.dock-cost {
		font-size: 10.5px;
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		color: var(--text-faint);
		padding: 2px 8px;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-surface);
		font-variant-numeric: tabular-nums;
		cursor: default;
		user-select: none;
	}
	.dock-message-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--accent);
		cursor: pointer;
	}
	.dock-message-btn:hover,
	.dock-message-btn[aria-pressed='true'] {
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
	.dock-message-btn.has-queue {
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
	/* Tiny number floating off the top-right corner of the send button —
	 * shows how many messages are queued behind the active render. */
	.queue-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border-radius: 999px;
		background: var(--accent);
		color: white;
		font-size: 9px;
		font-weight: 700;
		line-height: 14px;
		text-align: center;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 0 0 1.5px var(--bg-surface);
	}
	.dock-chat-popover {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 20;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
		overflow: hidden;
	}

	/* One clickable card — mascot + label + status, all in a single button.
	 * Click anywhere to wake. Shine border (from parent ShineBorder) renders
	 * around the outside when rendering === true. */
	.dock-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 12px;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		color: var(--text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
		transition: background 0.15s, border-color 0.15s, transform 0.15s;
	}
	.dock-card:hover:not(:disabled) {
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
	.dock-card:active:not(:disabled) {
		transform: translateY(1px);
	}
	.dock-card:disabled {
		cursor: default;
	}
	.dock-card.awake,
	.dock-card.pending {
		/* While the shine border is animating around the outside, hide the
		 * card's own border so the two don't stack into a double ring. */
		border-color: transparent;
	}
	.dock-card.silent {
		border-color: color-mix(in srgb, #d97706 45%, var(--border-light));
		background: color-mix(in srgb, #d97706 4%, var(--bg-elevated));
	}

	.mascot-face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		transform-origin: center bottom;
		animation: mascot-sleep-bob 3.2s ease-in-out infinite;
		transition: color 0.3s;
		flex-shrink: 0;
	}
	.dock-card.awake .mascot-face {
		color: var(--accent);
		animation: mascot-run 0.6s ease-in-out infinite;
	}
	.dock-card.silent .mascot-face {
		color: #b45309;
	}

	.dock-info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}
	.dock-label {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
		line-height: 1.2;
	}
	.dock-card.awake .dock-label {
		color: var(--accent);
	}
	.dock-card.silent .dock-label {
		color: #b45309;
	}
	.countdown {
		font-size: 11px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}
	.dock-status {
		display: inline-flex;
		align-items: baseline;
		font-size: 10px;
		letter-spacing: 0.08em;
		color: var(--text-faint);
		text-transform: uppercase;
		font-weight: 600;
	}

	.sleep-dots {
		display: inline-flex;
		gap: 1px;
		font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
		font-size: 11px;
		color: var(--text-faint);
		font-weight: 600;
	}
	.dock-card.silent .sleep-dots {
		color: #b45309;
	}
	.sleep-dots span {
		opacity: 0;
		animation: sleep-z 2.4s ease-in-out infinite;
	}
	.sleep-dots span:nth-child(1) { animation-delay: 0s; }
	.sleep-dots span:nth-child(2) { animation-delay: 0.5s; }
	.sleep-dots span:nth-child(3) { animation-delay: 1.0s; }

	.bounce-dots {
		display: inline-flex;
		gap: 1px;
		color: var(--accent);
		font-weight: 700;
	}
	.bounce-dots span {
		display: inline-block;
		animation: dot-bounce 1.2s ease-in-out infinite;
	}
	.bounce-dots span:nth-child(1) { animation-delay: 0s; }
	.bounce-dots span:nth-child(2) { animation-delay: 0.2s; }
	.bounce-dots span:nth-child(3) { animation-delay: 0.4s; }

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
	@keyframes sleep-z {
		0% { opacity: 0; transform: translateY(2px) scale(0.8); }
		20% { opacity: 0.8; transform: translateY(-1px) scale(1); }
		60% { opacity: 0.8; transform: translateY(-4px) scale(1); }
		100% { opacity: 0; transform: translateY(-7px) scale(0.9); }
	}
	@keyframes dot-bounce {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
		30% { transform: translateY(-2px); opacity: 1; }
	}
</style>
