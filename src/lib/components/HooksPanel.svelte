<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Plus, Play, Sparkles } from 'lucide-svelte';
	import { agentHistory, activeTab } from '$lib/stores';
	import { HOOK_TEMPLATES, type HookTemplate } from '$lib/shared/hook-templates';

	type HookEvent =
		| 'PreToolUse'
		| 'PostToolUse'
		| 'PostToolUseFailure'
		| 'UserPromptSubmit'
		| 'Stop'
		| 'SubagentStop'
		| 'SessionStart'
		| 'SessionEnd'
		| 'Notification';

	const EVENT_OPTIONS: HookEvent[] = [
		'PreToolUse',
		'PostToolUse',
		'PostToolUseFailure',
		'UserPromptSubmit',
		'Stop',
		'SubagentStop',
		'SessionStart',
		'SessionEnd',
		'Notification'
	];
	interface Hook {
		id: string;
		event: HookEvent;
		matcher?: string;
		command: string;
		enabled?: boolean;
		/** Optional output file the hook produces (PDF, HTML, etc.). When
		 * set, the preview window watches for hook completion and reloads
		 * this file. Supports `{{file}}` / `{{tool}}` templating. */
		output?: string;
	}

	let hooks = $state<Hook[]>([]);
	let newEvent = $state<HookEvent>('PostToolUse');
	let newMatcher = $state('');
	let newCommand = $state('');
	let newOutput = $state('');
	let loading = $state(true);

	async function load() {
		try {
			const res = await fetch('/api/hooks');
			const data = await res.json();
			hooks = Array.isArray(data?.hooks) ? data.hooks : [];
		} catch (e) {
			console.error('Failed to load hooks:', e);
		} finally {
			loading = false;
		}
	}

	async function persist(next: Hook[]) {
		hooks = next;
		try {
			await fetch('/api/hooks', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hooks: next })
			});
		} catch (e) {
			console.error('Failed to persist hooks:', e);
		}
	}

	function addHook() {
		const command = newCommand.trim();
		if (!command) return;
		const output = newOutput.trim();
		const hook: Hook = {
			id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			event: newEvent,
			matcher: newMatcher.trim() || undefined,
			command,
			enabled: true,
			...(output ? { output } : {})
		};
		void persist([...hooks, hook]);
		newCommand = '';
		newMatcher = '';
		newOutput = '';
	}

	/** Populate the add-form fields from a HOOK_TEMPLATES entry. The user
	 * can tweak before clicking the + button. Doesn't auto-add the hook —
	 * gives the user a beat to confirm matcher / output / command. */
	function applyTemplate(t: HookTemplate) {
		newEvent = t.event;
		newMatcher = t.matcher ?? '';
		newCommand = t.command;
		newOutput = t.output ?? '';
	}

	function removeHook(id: string) {
		void persist(hooks.filter((h) => h.id !== id));
	}

	function toggleHook(id: string) {
		void persist(
			hooks.map((h) => (h.id === id ? { ...h, enabled: h.enabled === false } : h))
		);
	}

	function updateCommand(id: string, command: string) {
		const trimmed = command.trim();
		if (!trimmed) return;
		void persist(hooks.map((h) => (h.id === id ? { ...h, command: trimmed } : h)));
	}

	function updateOutput(id: string, output: string) {
		const trimmed = output.trim();
		void persist(
			hooks.map((h) =>
				h.id === id ? { ...h, ...(trimmed ? { output: trimmed } : { output: undefined }) } : h
			)
		);
	}

	let running = $state<Record<string, boolean>>({});

	let currentTabPath: string | null = null;
	activeTab.subscribe((v) => (currentTabPath = v));

	/** Manually run a hook from the UI (outside any agent turn). The active
	 * tab's path is passed as `file` so commands using `{{file}}` (e.g.
	 * `pdflatex {{file}}`) resolve to the file the user is looking at right
	 * now. The captured stdout/stderr/exit-code is surfaced in the history
	 * pane via `pushHistory`, matching what auto-fired hooks emit. */
	/** Upsert a hook_run entry: terminal events (done/failed) replace the
	 * matching `running` entry in place by hookId+command, mirroring the
	 * auto-fired-hook path in +page.svelte so manual runs render as one
	 * card that transitions running → done/failed (not two stacked cards). */
	function upsertHookRun(parsed: {
		hookId: string;
		event: string;
		command: string;
		status: 'running' | 'done' | 'failed';
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		durationMs?: number;
	}) {
		agentHistory.update((h) => {
			if (parsed.status === 'running') {
				return [
					...h,
					{
						type: 'hook_run',
						timestamp: Date.now(),
						hookId: parsed.hookId,
						event: parsed.event,
						command: parsed.command,
						status: 'running'
					}
				];
			}
			for (let i = h.length - 1; i >= 0; i--) {
				const e = h[i];
				if (
					e.type === 'hook_run' &&
					e.hookId === parsed.hookId &&
					e.command === parsed.command &&
					e.status === 'running'
				) {
					const next = [...h];
					next[i] = {
						...e,
						status: parsed.status,
						exitCode: parsed.exitCode,
						stdout: parsed.stdout,
						stderr: parsed.stderr,
						durationMs: parsed.durationMs
					};
					return next;
				}
			}
			return [
				...h,
				{
					type: 'hook_run',
					timestamp: Date.now(),
					hookId: parsed.hookId,
					event: parsed.event,
					command: parsed.command,
					status: parsed.status,
					exitCode: parsed.exitCode,
					stdout: parsed.stdout,
					stderr: parsed.stderr,
					durationMs: parsed.durationMs
				}
			];
		});
	}

	async function runNow(hook: Hook) {
		if (running[hook.id]) return;
		running = { ...running, [hook.id]: true };
		const startedAt = Date.now();
		// Optimistic running card so the user sees immediate feedback. The
		// terminal upsert below replaces this in place.
		upsertHookRun({
			hookId: hook.id,
			event: hook.event,
			command: hook.command,
			status: 'running'
		});
		try {
			const res = await fetch('/api/hooks/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: hook.id, file: currentTabPath ?? undefined })
			});
			const data = await res.json().catch(() => null);
			if (!res.ok || !data?.ok || !data.entry) {
				throw new Error(data?.error || `HTTP ${res.status}`);
			}
			// The server-resolved command (after {{file}}/{{tool}} substitution)
			// may differ from hook.command, so match the upsert against the
			// running entry's original command (which is what we just pushed).
			upsertHookRun({
				hookId: hook.id,
				event: hook.event,
				command: hook.command,
				status: data.entry.status,
				exitCode: data.entry.exitCode,
				stdout: data.entry.stdout,
				stderr: data.entry.stderr,
				durationMs: data.entry.durationMs
			});
		} catch (e) {
			upsertHookRun({
				hookId: hook.id,
				event: hook.event,
				command: hook.command,
				status: 'failed',
				stderr: (e as Error).message,
				durationMs: Date.now() - startedAt
			});
		} finally {
			running = { ...running, [hook.id]: false };
		}
	}

	onMount(() => {
		void load();
	});
</script>

<div class="hooks-panel">
	<div class="panel-header">
		<span class="panel-title">Hooks</span>
		<span class="panel-subtitle">shell commands fired on agent events</span>
	</div>

	{#if loading}
		<div class="empty">Loading…</div>
	{:else if hooks.length === 0}
		<div class="empty">No hooks yet. Add one below.</div>
	{:else}
		<div class="hook-list">
			{#each hooks as hook (hook.id)}
				<div class="hook-row" class:disabled={hook.enabled === false}>
					<div class="hook-meta">
						<span class="hook-event">{hook.event}</span>
						{#if hook.matcher}
							<span class="hook-matcher">/{hook.matcher}/</span>
						{/if}
					</div>
					<div class="hook-fields">
						<input
							class="hook-command-input"
							type="text"
							value={hook.command}
							title={hook.command}
							disabled={hook.enabled === false}
							onblur={(e) => updateCommand(hook.id, (e.currentTarget as HTMLInputElement).value)}
							onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
						/>
						<input
							class="hook-output-input"
							class:set={!!hook.output}
							type="text"
							value={hook.output ?? ''}
							placeholder="output file (optional) → reveals the Preview button"
							title={hook.output
								? `Output: ${hook.output} — Preview button is enabled for any matching tab`
								: 'Add an output path (e.g. main.pdf) to enable the Preview button for matching tabs'}
							disabled={hook.enabled === false}
							onblur={(e) => updateOutput(hook.id, (e.currentTarget as HTMLInputElement).value)}
							onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
						/>
					</div>
					<div class="hook-actions">
						<button
							class="run-btn"
							onclick={() => runNow(hook)}
							disabled={running[hook.id] || hook.enabled === false}
							title={hook.enabled === false
								? 'Hook is disabled — enable it first'
								: running[hook.id]
									? 'Running…'
									: 'Run this hook now (uses the active tab as {{file}})'}
						>
							<Play size={11} />
						</button>
						<label class="toggle">
							<input
								type="checkbox"
								checked={hook.enabled !== false}
								onchange={() => toggleHook(hook.id)}
							/>
						</label>
						<button class="remove-btn" onclick={() => removeHook(hook.id)} title="Remove">
							<X size={12} />
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="add-form">
		<div class="templates-row" role="group" aria-label="Add from template">
			<span class="templates-label">
				<Sparkles size={11} />
				Templates
			</span>
			<div class="templates-chips">
				{#each HOOK_TEMPLATES as t (t.id)}
					<button
						type="button"
						class="template-chip"
						onclick={() => applyTemplate(t)}
						title={t.description}
					>{t.label}</button>
				{/each}
			</div>
		</div>
		<div class="form-row">
			<select class="event-select" bind:value={newEvent}>
				{#each EVENT_OPTIONS as ev}
					<option value={ev}>{ev}</option>
				{/each}
			</select>
			<input
				class="matcher-input"
				bind:value={newMatcher}
				placeholder="matcher (optional, e.g. Edit|Write)"
			/>
		</div>
		<div class="form-row">
			<input
				class="command-input"
				bind:value={newCommand}
				placeholder="command (e.g. pdflatex main.tex)"
				onkeydown={(e) => e.key === 'Enter' && addHook()}
			/>
			<button
				class="add-btn"
				onclick={addHook}
				disabled={!newCommand.trim()}
				aria-label="Add hook"
			>
				<Plus size={13} />
			</button>
		</div>
		<div class="form-row">
			<input
				class="command-input"
				bind:value={newOutput}
				placeholder="output file (optional) — fill this to reveal the Preview button"
				onkeydown={(e) => e.key === 'Enter' && addHook()}
			/>
		</div>
		<div class="form-hint">
			Templating: <code>{'{{file}}'}</code> = edited file path, <code>{'{{stem}}'}</code> = file without extension, <code>{'{{tool}}'}</code> = tool name. <strong>Filling the output field</strong> (PDF / HTML / image) reveals a Preview button in the editor that opens a popup window — it auto-reloads with scroll preserved each time the hook finishes.
		</div>
	</div>
</div>

<style>
	.hooks-panel {
		width: 480px;
		padding: 14px 14px 12px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.panel-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.panel-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.panel-subtitle {
		font-size: 11px;
		color: var(--text-faint);
	}
	.empty {
		font-size: 12px;
		color: var(--text-faint);
		padding: 8px 2px;
	}
	.hook-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}
	.hook-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		min-width: 0;
	}
	.hook-meta {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex-shrink: 0;
		min-width: 72px;
	}
	.hook-event {
		font-size: 10px;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.hook-matcher {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 10px;
		color: var(--text-faint);
	}
	/* Two stacked inputs per hook row: command on top, output below.
	 * Sharing the same chrome (transparent border until hover/focus)
	 * so they read as a tight pair, not two unrelated fields. */
	.hook-fields {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hook-command-input,
	.hook-output-input {
		width: 100%;
		min-width: 0;
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 11.5px;
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		padding: 2px 5px;
		outline: none;
		cursor: text;
		box-sizing: border-box;
		transition: border-color 0.12s, background 0.12s;
	}
	.hook-output-input {
		font-size: 11px;
		color: var(--text-faint);
	}
	/* Subtle accent when the output is set — signals "preview button is
	 * available for matching tabs" at a glance, without being loud. */
	.hook-output-input.set {
		color: var(--accent);
	}
	.hook-output-input::placeholder {
		color: var(--text-faint);
		font-style: italic;
		opacity: 0.7;
	}
	.hook-command-input:hover:not(:disabled),
	.hook-output-input:hover:not(:disabled) {
		border-color: var(--border-light);
		background: var(--bg);
	}
	.hook-command-input:focus,
	.hook-output-input:focus {
		border-color: var(--accent);
		background: var(--bg);
		box-shadow: 0 0 0 3px var(--accent-bg);
		color: var(--text);
	}
	.hook-command-input:disabled,
	.hook-output-input:disabled {
		opacity: 0.5;
		text-decoration: line-through;
		cursor: default;
	}
	.hook-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}
	.toggle input[type='checkbox'] {
		cursor: pointer;
	}
	.remove-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		padding: 3px;
		border-radius: 3px;
		color: var(--text-faint);
		cursor: pointer;
	}
	.remove-btn:hover {
		color: var(--diff-removed-color);
		background: var(--bg-hover);
	}
	.run-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		padding: 3px;
		border-radius: 3px;
		color: var(--text-faint);
		cursor: pointer;
	}
	.run-btn:hover:not(:disabled) {
		color: var(--accent);
		background: var(--accent-bg);
	}
	.run-btn:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.add-form {
		border-top: 1px solid var(--border-light);
		padding-top: 10px;
	}
	/* Templates row: click a chip to populate the form fields from a
	 * curated preset (latexmk, pandoc, etc.). User can tweak before
	 * saving. Keeps build-and-preview hooks discoverable without
	 * forcing memorization of the exact CLI flags. */
	.templates-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 8px;
	}
	.templates-label {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding-top: 4px;
		flex-shrink: 0;
	}
	.templates-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.template-chip {
		font: inherit;
		font-size: 11px;
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 999px;
		padding: 3px 9px;
		cursor: pointer;
		white-space: nowrap;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.template-chip:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.form-row {
		display: flex;
		gap: 6px;
		margin-bottom: 6px;
	}
	.event-select,
	.matcher-input,
	.command-input {
		font-family: inherit;
		font-size: 12px;
		padding: 5px 8px;
		border: 1px solid var(--border-light);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		outline: none;
		box-sizing: border-box;
	}
	.event-select {
		flex-shrink: 0;
		width: 128px;
	}
	.matcher-input {
		flex: 1;
		min-width: 0;
	}
	.command-input {
		flex: 1;
		min-width: 0;
		font-family: 'SF Mono', 'Menlo', monospace;
	}
	.event-select:focus,
	.matcher-input:focus,
	.command-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.add-btn {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 4px;
		color: var(--text-faint);
		cursor: pointer;
	}
	.add-btn:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent-light);
		background: var(--accent-bg);
	}
	.add-btn:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.form-hint {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.4;
		cursor: default;
		user-select: text;
	}
	.form-hint code {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 10.5px;
		background: var(--bg-surface);
		padding: 1px 4px;
		border-radius: 3px;
		color: var(--text-muted);
	}
</style>
