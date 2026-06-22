<script lang="ts">
	import { onMount } from 'svelte';
	import { Play, Plus, RefreshCw, Trash2 } from 'lucide-svelte';

	interface Props {
		onSubmit?: (trigger: string) => void;
	}

	let { onSubmit }: Props = $props();

	interface SkillSummary {
		id: string;
		name: string;
		description: string;
		enabled: boolean;
		origin: 'bundled' | 'custom';
		path: string;
		source?: string;
		missing?: boolean;
	}

	let skills = $state<SkillSummary[]>([]);
	let nativeDirs = $state<string[]>([]);
	let source = $state('');
	let loading = $state(true);
	let savingId = $state<string | null>(null);
	let adding = $state(false);
	let errorText = $state('');
	let directSource = $derived(normalizeDirectSource(source));

	async function load() {
		loading = true;
		errorText = '';
		try {
			const res = await fetch('/api/skills');
			const data = await res.json();
			if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
			skills = Array.isArray(data?.skills) ? data.skills : [];
			nativeDirs = Array.isArray(data?.nativeDirs) ? data.nativeDirs : [];
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	function applyData(data: { skills?: SkillSummary[]; nativeDirs?: string[] }) {
		if (Array.isArray(data.skills)) skills = data.skills;
		if (Array.isArray(data.nativeDirs)) nativeDirs = data.nativeDirs;
	}

	async function toggle(skill: SkillSummary) {
		savingId = skill.id;
		errorText = '';
		try {
			const res = await fetch('/api/skills', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: skill.id, enabled: !skill.enabled })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
			applyData(data);
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			savingId = null;
		}
	}

	function normalizeDirectSource(raw: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?\/?$/.test(trimmed)) {
			return trimmed;
		}
		if (/^github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?\/?$/.test(trimmed)) {
			return `https://${trimmed}`;
		}
		if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(trimmed)) {
			return `https://github.com/${trimmed}`;
		}
		if (
			trimmed.startsWith('/') ||
			trimmed.startsWith('./') ||
			trimmed.startsWith('../') ||
			trimmed.startsWith('~/') ||
			trimmed.includes('/') ||
			/SKILL\.md$/i.test(trimmed)
		) {
			return trimmed;
		}
		return null;
	}

	function submitSkillRequest() {
		const text = source.trim();
		if (!text || !onSubmit) return;
		onSubmit([
			`The user typed this into the DocWriter Settings > Skills add box: "${text}".`,
			'Treat it as a request to add or create an Agent Skill.',
			'If it is a GitHub URL, GitHub owner/repo shorthand, local skill directory, or SKILL.md path, call `add_skill` with the resolved source.',
			'If it is just a name or vague description, ask the user for the GitHub URL or local path, or identify a likely public skill source before calling `add_skill`.',
			'Do not edit `.docwriter/skills.json`, `.claude/skills`, or `.agents/skills` directly.'
		].join('\n'));
		source = '';
		errorText = '';
	}

	function runSkill(skill: SkillSummary) {
		if (!onSubmit || !skill.enabled || skill.missing) return;
		onSubmit(`/${skill.id}`);
	}

	async function addSkill() {
		const trimmed = source.trim();
		if (!trimmed || adding) return;
		const resolved = normalizeDirectSource(trimmed);
		if (!resolved) {
			submitSkillRequest();
			return;
		}
		adding = true;
		errorText = '';
		try {
			const res = await fetch('/api/skills', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ source: resolved })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
			source = '';
			applyData(data);
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			adding = false;
		}
	}

	async function removeSkill(skill: SkillSummary) {
		if (skill.origin !== 'custom') return;
		savingId = skill.id;
		errorText = '';
		try {
			const res = await fetch(`/api/skills?id=${encodeURIComponent(skill.id)}`, {
				method: 'DELETE'
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
			applyData(data);
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			savingId = null;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<div class="skills-panel" role="dialog">
	<div class="panel-header">
		<div>
			<span class="panel-title">Skills</span>
			<span class="panel-subtitle">reusable agent workflows</span>
		</div>
		<button class="icon-btn" type="button" onclick={() => void load()} title="Refresh skills">
			<RefreshCw size={14} />
		</button>
	</div>

	{#if errorText}
		<div class="error">{errorText}</div>
	{/if}

	<div class="skill-list" class:loading>
		{#if loading}
			<div class="empty">Loading skills…</div>
		{:else if skills.length === 0}
			<div class="empty">No skills found.</div>
		{:else}
			{#each skills as skill (skill.id)}
				<div class="skill-row" class:disabled={!skill.enabled || skill.missing}>
					<div class="skill-main">
						<div class="skill-topline">
							<button
								class="switch"
								class:on={skill.enabled && !skill.missing}
								type="button"
								aria-pressed={skill.enabled && !skill.missing}
								disabled={savingId === skill.id || skill.missing}
								onclick={() => void toggle(skill)}
								title={skill.enabled ? 'Disable skill' : 'Enable skill'}
							>
								<span></span>
							</button>
							<div class="skill-name">{skill.name}</div>
							<span class="badge">{skill.origin === 'bundled' ? 'Preset' : 'Custom'}</span>
						</div>
						<div class="skill-description">{skill.description}</div>
						<div class="skill-path">{skill.source || skill.path}</div>
					</div>
					<button
						class="icon-btn run"
						type="button"
						disabled={!onSubmit || !skill.enabled || skill.missing}
						onclick={() => runSkill(skill)}
						title={skill.enabled && !skill.missing ? `Run /${skill.id}` : 'Enable skill before running'}
						aria-label={`Run ${skill.name}`}
					>
						<Play size={13} />
					</button>
					{#if skill.origin === 'custom'}
						<button
							class="icon-btn danger"
							type="button"
							disabled={savingId === skill.id}
							onclick={() => void removeSkill(skill)}
							title="Remove skill"
						>
							<Trash2 size={14} />
						</button>
					{/if}
				</div>
			{/each}
		{/if}
	</div>

	<div class="add-section">
		<div class="add-title">Add skill</div>
		<div class="add-row">
			<input
				bind:value={source}
				placeholder="GitHub URL or local path"
				onkeydown={(e) => {
					if (e.key === 'Enter') void addSkill();
				}}
			/>
			<button
				class="add-btn"
				type="button"
				disabled={!source.trim() || adding || (!directSource && !onSubmit)}
				onclick={() => void addSkill()}
				title={directSource ? 'Add skill' : 'Ask agent to add skill'}
			>
				<Plus size={14} />
				<span>{adding ? 'Adding' : directSource ? 'Add' : 'Ask agent'}</span>
			</button>
		</div>
	</div>

	{#if nativeDirs.length > 0}
		<div class="sync-note">
			Synced to {nativeDirs.length} native folder{nativeDirs.length === 1 ? '' : 's'}.
		</div>
	{/if}
</div>

<style>
	.skills-panel {
		width: 390px;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		padding: 14px 16px 16px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.panel-title {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.panel-subtitle {
		display: block;
		margin-top: 3px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.skill-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: min(54vh, 420px);
		overflow: auto;
		padding-right: 2px;
	}
	.skill-row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 10px;
	}
	.skill-row.disabled {
		opacity: 0.62;
	}
	.skill-main {
		min-width: 0;
		flex: 1;
	}
	.skill-topline {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.skill-name {
		font-size: 13px;
		font-weight: 650;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		flex: 0 0 auto;
		font-size: 10px;
		font-weight: 600;
		color: var(--text-faint);
		border: 1px solid var(--border-light);
		border-radius: 999px;
		padding: 1px 6px;
	}
	.skill-description {
		margin-top: 6px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.skill-path {
		margin-top: 6px;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 10.5px;
		line-height: 1.35;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.switch {
		width: 30px;
		height: 17px;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		background: var(--bg-surface);
		padding: 2px;
		cursor: pointer;
		flex: 0 0 auto;
		transition: background 120ms ease, border-color 120ms ease;
	}
	.switch span {
		display: block;
		width: 11px;
		height: 11px;
		border-radius: 999px;
		background: var(--text-faint);
		transition: transform 120ms ease, background 120ms ease;
	}
	.switch.on {
		background: color-mix(in srgb, var(--accent) 18%, var(--bg-elevated));
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-light));
	}
	.switch.on span {
		transform: translateX(12px);
		background: var(--accent);
	}
	.icon-btn {
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text-muted);
		cursor: pointer;
		flex: 0 0 auto;
	}
	.icon-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--border);
	}
	.icon-btn.run {
		color: var(--accent);
	}
	.icon-btn.run:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-light));
		background: color-mix(in srgb, var(--accent) 9%, var(--bg-elevated));
	}
	.icon-btn.danger:hover:not(:disabled) {
		color: #dc2626;
		border-color: color-mix(in srgb, #dc2626 40%, var(--border-light));
	}
	.icon-btn:disabled,
	.add-btn:disabled,
	.switch:disabled {
		cursor: default;
		opacity: 0.5;
	}
	.add-section {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--border-light);
	}
	.add-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 7px;
	}
	.add-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
	}
	input {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text);
		font: inherit;
		font-size: 12px;
		padding: 7px 8px;
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.add-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-light));
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated));
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		padding: 0 10px;
		cursor: pointer;
	}
	.error {
		margin-bottom: 10px;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, #dc2626 9%, var(--bg-elevated));
		color: #b91c1c;
		font-size: 12px;
		line-height: 1.4;
	}
	.empty {
		padding: 16px 10px;
		text-align: center;
		color: var(--text-muted);
		font-size: 12px;
	}
	.sync-note {
		margin-top: 10px;
		font-size: 11px;
		color: var(--text-faint);
	}
</style>
