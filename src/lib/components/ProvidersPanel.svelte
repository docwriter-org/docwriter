<script lang="ts">
	import { onMount } from 'svelte';

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

	type Mode = 'login' | 'key';

	let providers = $state<ProviderStatus[]>([]);
	let drafts = $state<Record<string, string>>({});
	/** Which side of the segmented control each provider shows. Seeded from
	 * what is actually active; the author can flip it to read the other. */
	let mode = $state<Record<string, Mode>>({});
	let saving = $state<string | null>(null);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	let copied = $state<string | null>(null);

	function applyStatus(list: ProviderStatus[]) {
		providers = list;
		for (const p of list) {
			if (!(p.id in mode)) mode[p.id] = p.login && !p.present ? 'login' : 'key';
		}
	}

	async function load() {
		try {
			const res = await fetch('/api/keys');
			const data = await res.json();
			applyStatus(data.providers ?? []);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loaded = true;
		}
	}

	onMount(load);

	async function refresh() {
		refreshing = true;
		error = null;
		await load();
		refreshing = false;
	}

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
			if (p.login) mode[p.id] = 'login';
		}
	}

	async function copy(text: string, id: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = id;
			setTimeout(() => (copied = null), 1500);
		} catch {
			// Clipboard unavailable (insecure context) — the command is still selectable.
		}
	}

	function connection(p: ProviderStatus): { label: string; cls: 'ok' | 'off' } {
		if (p.present) return { label: 'Connected · API key', cls: 'ok' };
		if (p.usable && p.source === 'login') return { label: 'Connected · CLI login', cls: 'ok' };
		if (p.usable) return { label: 'Connected', cls: 'ok' };
		return { label: 'Not connected', cls: 'off' };
	}

	function keyNote(p: ProviderStatus): string | null {
		if (p.present) {
			return p.login
				? `Key set — API billing. Remove it to use your ${p.login.cli} login instead.`
				: 'Key set.';
		}
		if (p.login) {
			return p.id === 'claude'
				? 'Bills Anthropic API usage. Leave empty to use your Claude subscription through Claude Code.'
				: 'Bills OpenAI API usage. Leave empty to use your ChatGPT account through the Codex CLI.';
		}
		return p.altAuthNote ?? null;
	}
</script>

<div class="settings-panel" role="dialog">
	<div class="settings-header">
		<span class="settings-title">Providers</span>
		<button class="refresh-btn" type="button" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Checking…' : 'Refresh'}
		</button>
	</div>

	<div class="intro">
		Claude and Codex can reuse the login of their command-line tools on this computer, or an
		API key. Keys are stored in <code>~/.docwriter/keys.env</code> and shared across
		workspaces; an environment variable (or the repo <code>.env</code>) overrides them.
	</div>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	{#if !loaded}
		<div class="muted">Checking logins…</div>
	{:else}
		{#each providers as p (p.id)}
			{@const conn = connection(p)}
			{@const view = p.login ? mode[p.id] : 'key'}
			<section class="provider">
				<div class="prov-head">
					<span class="prov-name">{p.label}</span>
					<span class="conn {conn.cls}"><span class="dot"></span>{conn.label}</span>
				</div>

				{#if p.login}
					<div class="seg" role="tablist">
						<button
							type="button"
							role="tab"
							class="seg-btn"
							class:active={view === 'login'}
							aria-selected={view === 'login'}
							onclick={() => (mode[p.id] = 'login')}
						>
							CLI login
						</button>
						<button
							type="button"
							role="tab"
							class="seg-btn"
							class:active={view === 'key'}
							aria-selected={view === 'key'}
							onclick={() => (mode[p.id] = 'key')}
						>
							API key
						</button>
					</div>
				{/if}

				{#if p.login && view === 'login'}
					{#if p.present}
						<div class="note warn">
							A stored <code>{p.envVar}</code> takes precedence over this login.
							<button class="link-btn" type="button" onclick={() => clear(p)} disabled={saving === p.envVar}>
								Remove stored key
							</button>
							to use it.
						</div>
					{/if}
					{#if p.login.loggedIn}
						<dl class="facts">
							{#if p.login.version}<dt>Version</dt><dd>{p.login.version}</dd>{/if}
							{#if p.login.method}<dt>Login method</dt><dd>{p.login.method}</dd>{/if}
							{#if p.login.email}<dt>Email</dt><dd>{p.login.email}</dd>{/if}
							{#if p.login.organization}<dt>Organization</dt><dd>{p.login.organization}</dd>{/if}
							{#if p.login.plan}<dt>Plan</dt><dd>{p.login.plan}</dd>{/if}
						</dl>
						<div class="note">
							Signed in with {p.login.cli} on this computer. To switch accounts, run
							<code>{p.login.command}</code> in a terminal, then Refresh.
						</div>
					{:else}
						<div class="note">Not signed in. In a terminal on this computer, run:</div>
						<div class="cmd">
							<code>{p.login.command}</code>
							<button
								class="copy-btn"
								type="button"
								onclick={() => copy(p.login!.command, p.id)}
							>
								{copied === p.id ? 'Copied' : 'Copy'}
							</button>
						</div>
						<div class="note">
							Finish the browser sign-in, then press Refresh here.
							{#if p.id === 'claude'}
								Typing <code>/login</code> inside a running <code>claude</code> session works too.
							{/if}
						</div>
					{/if}
					{#if p.login.note}
						<div class="note warn">{p.login.note}</div>
					{/if}
				{:else}
					<div class="env-var"><code>{p.envVar}</code></div>
					{#if keyNote(p)}
						<div class="note">{keyNote(p)}</div>
					{/if}
					<div class="key-input">
						<input
							type="password"
							placeholder={p.present ? 'Replace key…' : `Paste ${p.envVar}…`}
							bind:value={drafts[p.envVar]}
							onkeydown={(e) => e.key === 'Enter' && save(p)}
						/>
						<button
							class="save-btn"
							type="button"
							disabled={saving === p.envVar || !(drafts[p.envVar] ?? '').trim()}
							onclick={() => save(p)}
						>
							{saving === p.envVar ? '…' : 'Save'}
						</button>
					</div>
					{#if p.present}
						<button class="link-btn standalone" type="button" onclick={() => clear(p)} disabled={saving === p.envVar}>
							Remove stored key
						</button>
					{/if}
				{/if}
			</section>
		{/each}
	{/if}
</div>

<style>
	.settings-panel {
		width: 360px;
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
	.refresh-btn {
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 11.5px;
		font-family: inherit;
		padding: 3px 8px;
		border-radius: 5px;
		cursor: pointer;
	}
	.refresh-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.intro {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-bottom: 12px;
	}
	code {
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
	.muted {
		font-size: 12px;
		color: var(--text-muted);
	}
	.provider {
		padding: 10px 0;
		border-top: 1px solid var(--border-light);
	}
	.provider:first-of-type {
		border-top: none;
	}
	.prov-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.prov-name {
		font-size: 13px;
		font-weight: 600;
	}
	.conn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		font-weight: 500;
		color: var(--text-muted);
	}
	.conn .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.conn.ok {
		color: #15803d;
	}
	.conn.ok .dot {
		background: #22c55e;
	}
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 3px;
		margin-bottom: 8px;
	}
	.seg-btn {
		border: none;
		background: transparent;
		padding: 5px 10px;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-faint);
		cursor: pointer;
		border-radius: 4px;
		font-family: inherit;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.seg-btn:hover {
		color: var(--text-secondary);
	}
	.seg-btn.active {
		background: var(--bg-elevated);
		color: var(--accent);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: 12px;
		row-gap: 3px;
		margin: 0 0 8px;
		font-size: 12px;
	}
	.facts dt {
		color: var(--text-faint);
	}
	.facts dd {
		margin: 0;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.note {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.45;
		margin-bottom: 8px;
	}
	.note.warn {
		color: #92400e;
		background: #fffbeb;
		border-radius: 6px;
		padding: 6px 8px;
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 8px;
	}
	.cmd code {
		flex: 1;
		font-size: 12px;
		padding: 6px 8px;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		user-select: all;
	}
	.copy-btn,
	.save-btn {
		border: none;
		background: var(--accent);
		color: white;
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		padding: 0 12px;
		border-radius: 6px;
		cursor: pointer;
		align-self: stretch;
	}
	.copy-btn {
		min-width: 60px;
	}
	.save-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.env-var {
		margin-bottom: 6px;
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
	.link-btn {
		border: none;
		background: none;
		color: inherit;
		font-size: inherit;
		font-family: inherit;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.link-btn.standalone {
		margin-top: 6px;
		color: var(--text-faint);
		font-size: 11.5px;
	}
	.link-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
