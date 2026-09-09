<script lang="ts">
	/**
	 * Embedded terminal running a provider's login command (see
	 * src/lib/server/login-terminal.ts). Output arrives over SSE, keystrokes
	 * and resizes go back over POST — no second WebSocket server needed for
	 * a flow that lasts a minute.
	 */
	import { onMount } from 'svelte';
	import { X } from 'lucide-svelte';
	import '@xterm/xterm/css/xterm.css';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';

	interface Props {
		provider: 'claude' | 'codex';
		/** Called once the login process exits. */
		onExit: (code: number) => void;
		onClose: () => void;
	}
	let { provider, onExit, onClose }: Props = $props();

	let host: HTMLDivElement | null = $state(null);
	let display = $state('');
	let source = $state<'path' | 'bundled' | null>(null);
	let error = $state<string | null>(null);
	let exitCode = $state<number | null>(null);
	let sessionId: string | null = null;
	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let events: EventSource | null = null;
	let observer: ResizeObserver | null = null;

	async function post(body: Record<string, unknown>) {
		if (!sessionId) return;
		try {
			await fetch(`/api/login-terminal/${sessionId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			// The stream's error handler reports a dead session.
		}
	}

	function sendResize() {
		if (!term || !fit) return;
		try {
			fit.fit();
		} catch {
			return;
		}
		void post({ type: 'resize', cols: term.cols, rows: term.rows });
	}

	onMount(() => {
		let cancelled = false;
		(async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit')
			]);
			if (cancelled || !host) return;
			term = new Terminal({
				cursorBlink: true,
				fontSize: 12,
				lineHeight: 1.25,
				fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
				theme: {
					background: '#18181b',
					foreground: '#e4e4e7',
					cursor: '#e4e4e7',
					selectionBackground: 'rgba(255,255,255,0.22)'
				},
				convertEol: false,
				scrollback: 2000
			});
			fit = new FitAddon();
			term.loadAddon(fit);
			term.open(host);
			try {
				fit.fit();
			} catch {
				// host not laid out yet; the observer fits it shortly
			}
			term.onData((data) => void post({ type: 'input', data }));
			host.closest('.login-terminal')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

			let res: Response;
			try {
				res = await fetch('/api/login-terminal', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ provider, cols: term.cols, rows: term.rows })
				});
			} catch (e) {
				error = (e as Error).message;
				return;
			}
			const started = await res.json();
			if (!res.ok) {
				error = started.error ?? 'could not start the login terminal';
				return;
			}
			if (cancelled) {
				await fetch(`/api/login-terminal/${started.id}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: 'kill' })
				}).catch(() => {});
				return;
			}
			sessionId = started.id;
			display = started.display;
			source = started.source;

			events = new EventSource(`/api/login-terminal/${sessionId}`);
			events.addEventListener('data', (ev) => {
				const payload = JSON.parse((ev as MessageEvent).data) as { data: string };
				term?.write(payload.data);
			});
			events.addEventListener('exit', (ev) => {
				const payload = JSON.parse((ev as MessageEvent).data) as { code: number };
				exitCode = payload.code;
				events?.close();
				events = null;
				onExit(payload.code);
			});
			events.onerror = () => {
				if (exitCode === null && sessionId) {
					// The server closes the stream on exit; anything else is a drop.
					error = 'Lost the connection to the login terminal.';
				}
			};

			observer = new ResizeObserver(() => sendResize());
			observer.observe(host);
			term.focus();
		})();
		return () => {
			cancelled = true;
			observer?.disconnect();
			events?.close();
			if (sessionId && exitCode === null) void post({ type: 'kill' });
			term?.dispose();
			term = null;
		};
	});
</script>

<div class="login-terminal">
	<div class="term-head">
		<span class="term-prompt">&gt;_</span>
		<span class="term-title">
			{#if error}
				Could not start the login.
			{:else if exitCode === null}
				Running <code>{display || (provider === 'claude' ? 'claude auth login' : 'codex login')}</code>.
			{:else if exitCode === 0}
				Finished.
			{:else}
				Exited with code {exitCode}.
			{/if}
			{#if source === 'bundled'}<span class="term-src">(bundled binary)</span>{/if}
		</span>
		<button class="term-close" type="button" onclick={onClose} aria-label="Close terminal">
			<X size={14} />
		</button>
	</div>
	{#if error}
		<div class="term-error">{error}</div>
	{/if}
	<div class="term-body" bind:this={host}></div>
</div>

<style>
	.login-terminal {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		overflow: hidden;
		background: #18181b;
	}
	.term-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		background: var(--bg-surface);
		border-bottom: 1px solid var(--border-light);
		font-size: 12px;
		color: var(--text-muted);
	}
	.term-prompt {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-faint);
	}
	.term-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.term-title code {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text);
	}
	.term-src {
		margin-left: 6px;
		color: var(--text-faint);
	}
	.term-close {
		display: inline-flex;
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 2px;
		border-radius: 4px;
	}
	.term-close:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.term-error {
		padding: 8px 10px;
		font-size: 12px;
		color: #fca5a5;
		background: #27272a;
		white-space: pre-wrap;
	}
	.term-body {
		height: 360px;
		padding: 8px 6px 4px 10px;
		box-sizing: border-box;
	}
	.term-body :global(.xterm) {
		height: 100%;
	}
</style>
