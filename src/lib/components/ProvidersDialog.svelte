<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Check, KeyRound, RefreshCw, TerminalSquare, X } from 'lucide-svelte';
	import LoginTerminal from './LoginTerminal.svelte';

	interface LoginStatus {
		cli: string;
		command: string;
		cliFound: boolean;
		loggedIn: boolean;
		version?: string;
		method?: string;
		email?: string;
		organization?: string;
		plan?: string;
		note?: string;
	}

	interface ProviderStatus {
		id: string;
		label: string;
		envVar: string;
		required: boolean;
		present: boolean;
		usable: boolean;
		source: 'env' | 'login' | null;
		altAuthNote?: string;
		altEnvVars?: string[];
		login?: LoginStatus;
	}

	type Mode = 'cli' | 'key';

	interface Props {
		open: boolean;
		onClose: () => void;
	}
	let { open, onClose }: Props = $props();

	let providers = $state<ProviderStatus[]>([]);
	let selectedId = $state<string>('claude');
	let drafts = $state<Record<string, string>>({});
	/** Which auth mode each provider's page shows; seeded from what is
	 * actually in effect, and flipped by clicking the other card. */
	let mode = $state<Record<string, Mode>>({});
	let saving = $state<string | null>(null);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	/** Provider whose login terminal is open, if any. */
	let terminalFor = $state<'claude' | 'codex' | null>(null);
	let terminalDone = $state(false);

	const selected = $derived(providers.find((p) => p.id === selectedId) ?? null);

	function applyStatus(list: ProviderStatus[]) {
		providers = list;
		for (const p of list) {
			if (!(p.id in mode)) mode[p.id] = p.login && !p.present ? 'cli' : 'key';
		}
	}

	async function load() {
		try {
			const res = await fetch('/api/keys');
			const data = await res.json();
			applyStatus(data.providers ?? []);
			error = null;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loaded = true;
		}
	}

	async function refresh() {
		refreshing = true;
		await load();
		refreshing = false;
	}

	onMount(() => {
		if (open) void load();
	});
	$effect(() => {
		if (open) void load();
		else {
			terminalFor = null;
			terminalDone = false;
		}
	});

	async function post(envVar: string, value: string, verb: string) {
		saving = envVar;
		error = null;
		try {
			const res = await fetch('/api/keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ envVar, value })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `failed to ${verb}`);
			applyStatus(data.providers ?? providers);
			return true;
		} catch (e) {
			error = (e as Error).message;
			return false;
		} finally {
			saving = null;
		}
	}

	async function save(p: ProviderStatus) {
		const value = (drafts[p.envVar] ?? '').trim();
		if (!value) return;
		if (await post(p.envVar, value, 'save')) {
			drafts = { ...drafts, [p.envVar]: '' };
			mode[p.id] = 'key';
		}
	}

	async function clear(p: ProviderStatus) {
		if (await post(p.envVar, '', 'clear')) {
			if (p.login) mode[p.id] = 'cli';
		}
	}

	function openTerminal(p: ProviderStatus) {
		if (p.id !== 'claude' && p.id !== 'codex') return;
		terminalDone = false;
		terminalFor = p.id;
	}

	function onTerminalExit() {
		terminalDone = true;
		void refresh();
	}

	function statusLine(p: ProviderStatus): { ok: boolean; label: string } {
		const m = p.login ? mode[p.id] : 'key';
		if (m === 'cli' && p.login) {
			if (p.present) return { ok: false, label: `Overridden by ${p.envVar}` };
			return p.login.loggedIn
				? { ok: true, label: 'Connected' }
				: { ok: false, label: 'Not signed in' };
		}
		if (p.present) return { ok: true, label: 'Connected' };
		if (p.usable) return { ok: true, label: 'Connected' };
		return { ok: false, label: 'Not connected' };
	}

	function railState(p: ProviderStatus): 'ok' | 'off' {
		return p.usable ? 'ok' : 'off';
	}

	function keyNote(p: ProviderStatus): string | null {
		if (p.id === 'claude') {
			return 'Bills Anthropic API usage. Leave empty to use your Claude subscription through Claude Code.';
		}
		if (p.id === 'codex') {
			return 'Bills OpenAI API usage. Leave empty to use your ChatGPT account through the Codex CLI.';
		}
		return p.altAuthNote ?? null;
	}

	function close() {
		onClose();
	}

	function closeOnBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open || e.key !== 'Escape') return;
		// Escape inside the login terminal belongs to the CLI (it cancels a
		// prompt there); only close the dialog when focus is elsewhere.
		const target = e.target as HTMLElement | null;
		if (target?.closest('.login-terminal')) return;
		e.preventDefault();
		close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="backdrop" role="presentation" onclick={closeOnBackdrop} transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="providers-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				<span id="providers-title">Providers</span>
				<div class="header-actions">
					<button class="text-btn" type="button" onclick={refresh} disabled={refreshing}>
						<RefreshCw size={13} class={refreshing ? 'spin' : ''} />
						{refreshing ? 'Checking…' : 'Refresh'}
					</button>
					<button class="icon-btn" type="button" onclick={close} aria-label="Close"><X size={15} /></button>
				</div>
			</div>

			<div class="dialog-body">
				<nav class="rail" aria-label="Providers">
					{#each providers as p (p.id)}
						<button
							type="button"
							class="rail-item"
							class:active={p.id === selectedId}
							onclick={() => (selectedId = p.id)}
						>
							<span class="dot {railState(p)}"></span>
							<span class="rail-label">{p.label}</span>
						</button>
					{/each}
				</nav>

				<div class="content">
					{#if error}
						<div class="error-box">{error}</div>
					{/if}
					{#if !loaded}
						<div class="muted">Checking logins…</div>
					{:else if selected}
						{@const p = selected}
						{@const view = p.login ? mode[p.id] : 'key'}
						{@const st = statusLine(p)}
						<h2 class="section-title">Authentication</h2>

						{#if p.login}
							<div class="mode-cards">
								<button
									type="button"
									class="mode-card"
									class:selected={view === 'cli'}
									onclick={() => (mode[p.id] = 'cli')}
								>
									{#if view === 'cli'}<span class="tick"><Check size={13} /></span>{/if}
									<TerminalSquare size={22} strokeWidth={1.5} />
									<span class="mode-label">CLI login</span>
									<span class="mode-sub">Use your {p.login.cli} account</span>
								</button>
								<button
									type="button"
									class="mode-card"
									class:selected={view === 'key'}
									onclick={() => (mode[p.id] = 'key')}
								>
									{#if view === 'key'}<span class="tick"><Check size={13} /></span>{/if}
									<KeyRound size={22} strokeWidth={1.5} />
									<span class="mode-label">API key</span>
									<span class="mode-sub">Set {p.envVar}</span>
								</button>
							</div>
						{/if}

						<div class="status-row">
							<span class="status" class:ok={st.ok}><span class="dot {st.ok ? 'ok' : 'off'}"></span>{st.label}</span>
						</div>

						{#if p.login && view === 'cli'}
							{#if p.present}
								<div class="note warn">
									A stored <code>{p.envVar}</code> takes precedence over this login.
									<button class="link-btn" type="button" onclick={() => clear(p)} disabled={saving === p.envVar}>
										Remove the stored key
									</button>
									to use it.
								</div>
							{/if}

							{#if p.login.loggedIn}
								<div class="facts">
									{#if p.login.version}<div class="fact"><span>Version</span><span>{p.login.version}</span></div>{/if}
									<div class="fact"><span>Provider</span><span>{p.id === 'claude' ? 'Anthropic' : 'OpenAI'}</span></div>
									{#if p.login.method}<div class="fact"><span>Login method</span><span>{p.login.method}</span></div>{/if}
									{#if p.login.organization}<div class="fact"><span>Organization</span><span>{p.login.organization}</span></div>{/if}
									{#if p.login.email}<div class="fact"><span>Email</span><span>{p.login.email}</span></div>{/if}
									{#if p.login.plan}<div class="fact"><span>Plan</span><span>{p.login.plan}</span></div>{/if}
								</div>
							{:else}
								<p class="note">
									Sign in with {p.login.cli} on this computer. The login opens a browser window; when it
									finishes, DocWriter picks it up automatically.
								</p>
							{/if}

							{#if terminalFor === p.id}
								<div class="terminal-wrap">
									<LoginTerminal
										provider={p.id}
										onExit={onTerminalExit}
										onClose={() => (terminalFor = null)}
									/>
								</div>
								{#if terminalDone}
									<div class="actions">
										<button class="btn-secondary" type="button" onclick={() => openTerminal(p)}>Run again</button>
									</div>
								{/if}
							{:else}
								<div class="actions">
									<button class="btn-primary" type="button" onclick={() => openTerminal(p)}>
										<TerminalSquare size={14} />
										{p.login.loggedIn ? 'Sign in again' : 'Sign in'}
									</button>
									<span class="actions-hint">Runs <code>{p.login.command}</code> here.</span>
								</div>
							{/if}
							{#if p.login.note}
								<div class="note warn">{p.login.note}</div>
							{/if}
						{:else}
							<div class="key-block">
								<div class="key-label"><code>{p.envVar}</code></div>
								{#if keyNote(p)}<p class="note">{keyNote(p)}</p>{/if}
								<div class="key-input">
									<input
										type="password"
										placeholder={p.present ? 'Replace key…' : `Paste ${p.envVar}…`}
										bind:value={drafts[p.envVar]}
										onkeydown={(e) => e.key === 'Enter' && save(p)}
									/>
									<button
										class="btn-primary"
										type="button"
										disabled={saving === p.envVar || !(drafts[p.envVar] ?? '').trim()}
										onclick={() => save(p)}
									>
										{saving === p.envVar ? '…' : 'Save'}
									</button>
								</div>
								{#if p.present}
									<div class="facts">
										<div class="fact"><span>Key</span><span>Set · stored in <code>~/.docwriter/keys.env</code></span></div>
									</div>
									<div class="actions">
										<button class="btn-secondary" type="button" onclick={() => clear(p)} disabled={saving === p.envVar}>
											Remove stored key
										</button>
									</div>
								{/if}
								{#if p.altEnvVars?.length && !p.present && p.usable}
									<p class="note">Connected through {p.altEnvVars.join(' / ')} from the environment.</p>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 210;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
	}
	.dialog {
		display: flex;
		flex-direction: column;
		width: min(860px, calc(100vw - 24px));
		height: min(640px, calc(100vh - 24px));
		overflow: hidden;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-elevated);
		box-shadow:
			0 24px 60px rgba(0, 0, 0, 0.2),
			0 4px 12px rgba(0, 0, 0, 0.08);
		color: var(--text);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 16px 14px 24px;
		font-size: 18px;
		font-weight: 600;
		letter-spacing: -0.01em;
		border-bottom: 1px solid var(--border-light);
		flex-shrink: 0;
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
	.icon-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.text-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-family: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.text-btn:hover {
		color: var(--text);
	}
	.text-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.dialog-body {
		display: grid;
		grid-template-columns: 180px minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.rail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 8px;
		border-right: 1px solid var(--border-light);
		background: var(--bg-surface);
		overflow-y: auto;
	}
	.rail-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-muted);
		font-family: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.rail-item:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.rail-item.active {
		background: var(--bg-elevated);
		color: var(--text);
		font-weight: 500;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.rail-label {
		flex: 1;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}
	.dot.ok {
		background: #22c55e;
	}
	.content {
		padding: 20px 28px 24px;
		overflow-y: auto;
		font-size: 13px;
	}
	.section-title {
		margin: 0 0 12px;
		font-size: 15px;
		font-weight: 600;
	}
	.mode-cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-bottom: 16px;
	}
	.mode-card {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 18px 12px 14px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-family: inherit;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s,
			color 0.15s;
	}
	.mode-card:hover {
		border-color: var(--text-faint);
		color: var(--text);
	}
	.mode-card.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
		color: var(--text);
	}
	.tick {
		position: absolute;
		top: 8px;
		right: 8px;
		color: var(--accent);
	}
	.mode-label {
		font-size: 13px;
		font-weight: 600;
	}
	.mode-sub {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.status-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
	}
	.status.ok {
		color: var(--text);
	}
	.facts {
		border: 1px solid var(--border-light);
		border-radius: 8px;
		overflow: hidden;
		margin-bottom: 14px;
	}
	.fact {
		display: grid;
		grid-template-columns: 140px 1fr;
		padding: 9px 12px;
		border-top: 1px solid var(--border-light);
		font-size: 12.5px;
	}
	.fact:first-child {
		border-top: none;
	}
	.fact > span:first-child {
		color: var(--text-faint);
	}
	.fact > span:last-child {
		overflow-wrap: anywhere;
	}
	.note {
		margin: 0 0 12px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.note.warn {
		padding: 8px 10px;
		border-radius: 6px;
		color: #92400e;
		background: #fffbeb;
	}
	code {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		padding: 1px 4px;
		border-radius: 4px;
		background: var(--bg-surface);
	}
	.terminal-wrap {
		margin-bottom: 12px;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}
	.actions-hint {
		font-size: 12px;
		color: var(--text-faint);
	}
	.btn-primary,
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 12px;
		border-radius: 6px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 600;
		cursor: pointer;
	}
	.btn-primary {
		border: none;
		background: var(--accent);
		color: white;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.btn-secondary {
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		color: var(--text);
	}
	.btn-secondary:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.key-block {
		max-width: 520px;
	}
	.key-label {
		margin-bottom: 6px;
	}
	.key-input {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}
	.key-input input {
		flex: 1;
		min-width: 0;
		padding: 7px 10px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text);
		font-family: ui-monospace, monospace;
		font-size: 12px;
	}
	.link-btn {
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	.link-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.error-box {
		margin-bottom: 12px;
		padding: 8px 12px;
		border-radius: 6px;
		background: #fef2f2;
		color: #b91c1c;
		font-size: 12.5px;
	}
	.muted {
		color: var(--text-muted);
		font-size: 12px;
	}
</style>
