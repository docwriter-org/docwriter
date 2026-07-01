<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Bot, Clock, MessageSquare, RefreshCw, Search, X } from 'lucide-svelte';
	import { tooltip } from '$lib/actions/tooltip';

	interface SessionSummary {
		id: string;
		provider: string;
		model: string;
		created: number;
		updated: number;
		status: string;
		firstUserMessage: string | null;
		eventCount: number;
		nativeEntryCount: number;
		isCurrent: boolean;
	}

	interface Props {
		onClose: () => void;
		onSwitchSession?: (session: SessionSummary) => void | Promise<void>;
	}

	let { onClose, onSwitchSession }: Props = $props();

	let sessions = $state<SessionSummary[]>([]);
	let loading = $state(true);
	let error = $state('');
	let search = $state('');
	let switchingSessionId = $state<string | null>(null);

	const PROVIDER_LABELS: Record<string, string> = {
		claude: 'Claude',
		openai: 'OpenAI',
		codex: 'Codex',
		cursor: 'Cursor',
		pi: 'Pi'
	};

	async function loadSessions() {
		loading = true;
		error = '';
		try {
			const res = await fetch('/api/sessions');
			const data = await res.json();
			if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
			sessions = Array.isArray(data.sessions) ? data.sessions : [];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadSessions();
	});

	function formatDate(ts: number): string {
		if (!ts) return 'Unknown date';
		const date = new Date(ts);
		const today = new Date();
		const yesterday = new Date();
		yesterday.setDate(today.getDate() - 1);
		const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
		if (sameDay(date, today)) return 'Today';
		if (sameDay(date, yesterday)) return 'Yesterday';
		return date.toLocaleDateString([], {
			month: 'short',
			day: 'numeric',
			year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
		});
	}

	function formatTime(ts: number): string {
		if (!ts) return '';
		return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	function labelFor(session: SessionSummary): string {
		const message = session.firstUserMessage?.trim();
		if (message) return message;
		if (session.eventCount > 0) return 'Agent run';
		return 'Provider session';
	}

	function metaFor(session: SessionSummary): string {
		const provider = PROVIDER_LABELS[session.provider] ?? session.provider;
		const model = session.model ? ` · ${session.model}` : '';
		const count =
			session.eventCount > 0
				? ` · ${session.eventCount} events`
				: session.nativeEntryCount > 0
					? ` · ${session.nativeEntryCount} native entries`
					: '';
		return `${provider}${model}${count}`;
	}

	let filteredSessions = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return sessions;
		return sessions.filter((session) => {
			const haystack = [
				session.id,
				session.provider,
				session.model,
				session.firstUserMessage ?? '',
				session.status
			]
				.join(' ')
				.toLowerCase();
			return haystack.includes(q);
		});
	});

	let groupedSessions = $derived.by(() => {
		const groups: Array<{ day: string; sessions: SessionSummary[] }> = [];
		for (const session of filteredSessions) {
			const day = formatDate(session.updated || session.created);
			let group = groups.find((item) => item.day === day);
			if (!group) {
				group = { day, sessions: [] };
				groups.push(group);
			}
			group.sessions.push(session);
		}
		return groups;
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !switchingSessionId) onClose();
	}

	async function switchSession(session: SessionSummary) {
		if (session.isCurrent || switchingSessionId) return;
		switchingSessionId = session.id;
		error = '';
		try {
			if (onSwitchSession) {
				await onSwitchSession(session);
			} else {
				const res = await fetch('/api/sessions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sessionId: session.id })
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
			}
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			switchingSessionId = null;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="backdrop"
	transition:fade={{ duration: 150 }}
	role="presentation"
	onmousedown={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
>
	<div
		class="panel"
		role="dialog"
		aria-modal="true"
		aria-label="Agent sessions"
		transition:fly={{ y: 18, duration: 220, easing: cubicOut }}
	>
		<div class="topbar">
			<div>
				<div class="eyebrow">Sessions</div>
				<div class="subtitle">Choose which agent session is active.</div>
			</div>
			<div class="actions">
				<button
					class="icon-btn"
					onclick={() => void loadSessions()}
					disabled={loading}
					aria-label="Refresh sessions"
					use:tooltip={'Refresh the session list.'}
				>
					<RefreshCw size={15} />
				</button>
				<button class="icon-btn" onclick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
		</div>

		<div class="search-wrap">
			<Search size={14} />
			<input
				type="text"
				placeholder="Search sessions..."
				bind:value={search}
				aria-label="Search sessions"
			/>
		</div>

		{#if loading}
			<div class="empty">Loading sessions...</div>
		{:else if error}
			<div class="error">Could not load sessions. {error}</div>
		{:else if groupedSessions.length === 0}
			<div class="empty">No sessions found.</div>
		{:else}
			<div class="session-list">
				{#each groupedSessions as group (group.day)}
					<section class="day-group">
						<div class="day-label">{group.day}</div>
						{#each group.sessions as session (session.id)}
							<button
								class="session-row"
								class:current={session.isCurrent}
								class:switching={switchingSessionId === session.id}
								onclick={() => void switchSession(session)}
								disabled={!!switchingSessionId}
							>
								<div class="row-icon">
									{#if session.isCurrent}
										<Bot size={16} />
									{:else}
										<MessageSquare size={15} />
									{/if}
								</div>
								<div class="row-main">
									<div class="row-title">
										<span>{labelFor(session)}</span>
										{#if session.isCurrent}
											<span class="current-pill">Current</span>
										{:else if switchingSessionId === session.id}
											<span class="current-pill">Switching</span>
										{/if}
										{#if session.status === 'error'}
											<span class="error-pill">Error</span>
										{/if}
									</div>
									<div class="row-meta">{metaFor(session)}</div>
								</div>
								<div class="row-time">
									<Clock size={12} />
									<span>{formatTime(session.updated || session.created)}</span>
								</div>
							</button>
						{/each}
					</section>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: rgba(15, 23, 42, 0.38);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.panel {
		width: min(720px, calc(100vw - 48px));
		max-height: min(760px, calc(100vh - 48px));
		background: var(--bg-elevated);
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		color: var(--text);
	}

	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 18px 20px 14px;
		border-bottom: 1px solid var(--border);
	}

	.eyebrow {
		font-size: 13px;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.subtitle {
		margin-top: 4px;
		font-size: 14px;
		color: var(--muted);
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.icon-btn {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.icon-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--border-strong);
		background: var(--bg-surface);
	}

	.icon-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.search-wrap {
		margin: 14px 20px 8px;
		height: 38px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-surface);
		color: var(--muted);
	}

	.search-wrap input {
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		width: 100%;
		min-width: 0;
	}

	.session-list {
		overflow: auto;
		padding: 6px 20px 20px;
	}

	.day-group + .day-group {
		margin-top: 18px;
	}

	.day-label {
		margin: 8px 0;
		font-size: 11px;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.session-row {
		width: 100%;
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-elevated);
		color: var(--text);
		text-align: left;
		padding: 12px;
		cursor: pointer;
	}

	.session-row + .session-row {
		margin-top: 8px;
	}

	.session-row:hover {
		border-color: var(--accent);
		background: var(--bg-surface);
	}

	.session-row:disabled {
		cursor: default;
	}

	.session-row:disabled:not(.switching) {
		opacity: 0.72;
	}

	.session-row.current {
		border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));
	}

	.session-row.switching {
		border-color: var(--accent);
	}

	.row-icon {
		width: 34px;
		height: 34px;
		border-radius: 999px;
		border: 1px solid var(--border);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		background: var(--bg-surface);
	}

	.row-main {
		min-width: 0;
	}

	.row-title {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-weight: 700;
		font-size: 14px;
	}

	.row-title > span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-meta {
		margin-top: 4px;
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-time {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
	}

	.current-pill,
	.error-pill {
		flex: 0 0 auto;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 800;
	}

	.current-pill {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
	}

	.error-pill {
		background: color-mix(in srgb, #dc2626 12%, transparent);
		color: #b91c1c;
	}

	.empty,
	.error {
		margin: 18px 20px 24px;
		padding: 26px;
		border-radius: 8px;
		text-align: center;
		color: var(--muted);
		background: var(--bg-surface);
	}

	.error {
		color: #b91c1c;
		background: color-mix(in srgb, #dc2626 8%, var(--bg-elevated));
	}

	@media (max-width: 640px) {
		.backdrop {
			padding: 12px;
			align-items: stretch;
		}

		.panel {
			width: 100%;
			max-height: none;
		}

		.session-row {
			grid-template-columns: 30px minmax(0, 1fr);
		}

		.row-time {
			grid-column: 2;
			justify-self: start;
		}
	}
</style>
