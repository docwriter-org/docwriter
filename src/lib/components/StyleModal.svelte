<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Plus, Trash2, Download, RefreshCw } from 'lucide-svelte';

	interface RefRow {
		id: string;
		label: string;
		type: string;
		target: string;
		role?: 'authored' | 'inspiration';
		materializationStatus?: string;
		error?: string;
	}

	interface Trial {
		id: string;
		propositionId: string;
		brief: string;
		variantA: string;
		variantB: string;
		status: string;
	}

	interface Proposition {
		id: string;
		family: string;
		type: string;
		instruction: string;
		status: string;
		enabled: boolean;
		confidence: { final: number };
	}

	interface Props {
		open: boolean;
		activeTabId?: string | null;
		provider?: string;
		model?: string;
		onClose: () => void;
		onChanged?: () => void;
	}

	let {
		open = false,
		activeTabId = null,
		provider = '',
		model = '',
		onClose,
		onChanged
	}: Props = $props();

	let step = $state<1 | 2 | 3 | 4>(1);
	let references = $state<RefRow[]>([]);
	let loading = $state(false);
	let analyzing = $state(false);
	let runLog = $state<string[]>([]);
	let profile = $state<{
		hasSkill: boolean;
		activeCount: number;
		unresolvedCalibration: number;
		stale: boolean;
		propositions: Proposition[];
		calibrationTrials: Trial[];
	} | null>(null);

	let sampleName = $state('');
	let sampleContent = $state('');
	let urlValue = $state('');
	let urlLabel = $state('');
	let role = $state<'authored' | 'inspiration'>('authored');
	let previewText = $state('');
	let previewId = $state<string | null>(null);
	let editNeither = $state('');
	let activeTrial = $state<Trial | null>(null);

	async function refresh() {
		loading = true;
		try {
			const [refsRes, profRes] = await Promise.all([
				fetch('/api/references'),
				fetch('/api/style-profile')
			]);
			const refsData = await refsRes.json();
			const profData = await profRes.json();
			references = Array.isArray(refsData.references) ? refsData.references : [];
			profile = profData;
			if (profData.calibrationTrials?.length) {
				activeTrial = profData.calibrationTrials[0];
			}
			if (!references.length) step = 1;
			else if (analyzing) step = 2;
			else if (profData.unresolvedCalibration > 0) step = 3;
			else if (profData.hasSkill) step = 4;
		} finally {
			loading = false;
			onChanged?.();
		}
	}

	onMount(() => {
		if (open) void refresh();
	});

	$effect(() => {
		if (open) void refresh();
	});

	async function addCurrent() {
		if (!activeTabId) return;
		await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'add-current-file', tabId: activeTabId, role })
		});
		await refresh();
	}

	async function addSample() {
		if (!sampleName.trim() || !sampleContent.trim()) return;
		await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'add-sample',
				name: sampleName,
				content: sampleContent,
				role
			})
		});
		sampleName = '';
		sampleContent = '';
		await refresh();
	}

	async function addUrl() {
		if (!urlValue.trim()) return;
		await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'add-url',
				url: urlValue,
				label: urlLabel || undefined,
				role
			})
		});
		urlValue = '';
		urlLabel = '';
		await refresh();
	}

	async function removeRef(id: string) {
		await fetch(`/api/references/${id}`, { method: 'DELETE' });
		await refresh();
	}

	async function setRole(id: string, next: 'authored' | 'inspiration') {
		await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'set-role', id, role: next })
		});
		await refresh();
	}

	async function preview(id: string) {
		const res = await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'materialize', id })
		});
		const data = await res.json();
		previewId = id;
		previewText = data.text ?? data.error ?? '';
	}

	async function savePreview() {
		if (!previewId) return;
		await fetch('/api/references', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'save-extracted', id: previewId, text: previewText })
		});
		await refresh();
	}

	async function startAnalysis() {
		analyzing = true;
		step = 2;
		runLog = ['Starting analysis…'];
		let succeeded = false;
		try {
			const res = await fetch('/api/style-profile/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// Specialist Agent SDK runs are the skill builder. Metrics are
					// inputs to those runs, not a substitute for them.
					provider: provider || undefined,
					model: model || undefined,
					useHeuristicsOnly: false
				})
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.message || 'Failed to start run');
			// Refresh header after the run exists so analyzing=true is visible.
			onChanged?.();
			const es = new EventSource(`/api/style-profile/runs/${data.runId}/events`);
			await new Promise<void>((resolve, reject) => {
				es.onmessage = (ev) => {
					try {
						const msg = JSON.parse(ev.data);
						if (msg.type === 'status') {
							runLog = [...runLog, msg.message];
							if (msg.phase === 'cancelled') {
								es.close();
								reject(new Error('Run cancelled'));
							}
						}
						if (msg.type === 'progress') {
							runLog = [...runLog, `${msg.phase}: ${msg.current}/${msg.total}`];
						}
						if (msg.type === 'error') {
							runLog = [...runLog, `Error: ${msg.message}`];
							es.close();
							reject(new Error(msg.message || 'Analysis failed'));
						}
						if (msg.type === 'done') {
							runLog = [
								...runLog,
								`Done — ${msg.activeCount} active, ${msg.unresolved} to calibrate`
							];
							es.close();
							succeeded = true;
							resolve();
						}
					} catch {
						/* ignore parse errors */
					}
				};
				// Transient connect blips are common; only fail when the stream is closed.
				es.onerror = () => {
					if (es.readyState === EventSource.CLOSED) {
						es.close();
						if (!succeeded) reject(new Error('Lost connection to analysis stream'));
						else resolve();
					}
				};
			});
		} catch (e) {
			runLog = [...runLog, (e as Error).message];
			succeeded = false;
		} finally {
			analyzing = false;
			await refresh();
			if (succeeded) {
				if ((profile?.unresolvedCalibration ?? 0) > 0) step = 3;
				else step = 4;
			} else {
				step = 2;
			}
		}
	}

	async function answerTrial(response: 'a' | 'b' | 'same' | 'edited' | 'skip') {
		if (!activeTrial) return;
		const body: Record<string, string> = { response };
		if (response === 'edited') body.editedText = editNeither;
		await fetch(`/api/style-profile/calibrations/${activeTrial.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		editNeither = '';
		await refresh();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Writing references">
		<header class="head">
			<div>
				<h2>Writing references</h2>
				<p class="sub">Build a portable author-style skill from your writing.</p>
			</div>
			<button class="icon" onclick={onClose} aria-label="Close"><X size={16} /></button>
		</header>

		<nav class="steps">
			<button class:on={step === 1} onclick={() => (step = 1)}>1. Sources</button>
			<button class:on={step === 2} onclick={() => (step = 2)}>2. Analysis</button>
			<button class:on={step === 3} onclick={() => (step = 3)}>3. Calibration</button>
			<button class:on={step === 4} onclick={() => (step = 4)}>4. Active skill</button>
		</nav>

		<div class="body">
			{#if step === 1}
				<div class="role-row">
					<span>Default role</span>
					<select bind:value={role}>
						<option value="authored">My writing</option>
						<option value="inspiration">Style I want</option>
					</select>
				</div>

				<div class="actions">
					<button disabled={!activeTabId} onclick={() => void addCurrent()}>
						<Plus size={14} /> Add current file
					</button>
				</div>

				<details class="block">
					<summary>Paste a sample</summary>
					<input placeholder="Name" bind:value={sampleName} />
					<textarea rows="5" placeholder="Paste writing…" bind:value={sampleContent}></textarea>
					<button onclick={() => void addSample()}>Save sample</button>
				</details>

				<details class="block">
					<summary>Add a URL</summary>
					<input placeholder="https://…" bind:value={urlValue} />
					<input placeholder="Label (optional)" bind:value={urlLabel} />
					<button onclick={() => void addUrl()}>Add URL</button>
				</details>

				{#if loading}
					<p class="muted">Loading…</p>
				{:else if references.length === 0}
					<p class="muted">No references yet.</p>
				{:else}
					<ul class="refs">
						{#each references as ref (ref.id)}
							<li>
								<div class="ref-main">
									<strong>{ref.label}</strong>
									<span class="muted">{ref.type} · {ref.target}</span>
								</div>
								<select
									value={ref.role ?? 'authored'}
									onchange={(e) =>
										void setRole(ref.id, (e.currentTarget as HTMLSelectElement).value as any)}
								>
									<option value="authored">authored</option>
									<option value="inspiration">inspiration</option>
								</select>
								<button class="ghost" onclick={() => void preview(ref.id)}>Preview</button>
								<button class="ghost" onclick={() => void removeRef(ref.id)} aria-label="Remove">
									<Trash2 size={14} />
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				{#if previewId}
					<div class="preview">
						<div class="preview-head">
							<span>Extracted text</span>
							<button onclick={() => void savePreview()}>Save corrections</button>
						</div>
						<textarea rows="10" bind:value={previewText}></textarea>
					</div>
				{/if}

				<footer class="foot">
					<button
						class="primary"
						disabled={!references.length || !provider}
						onclick={() => void startAnalysis()}
						title={provider
							? 'Run specialist agent passes with the selected model'
							: 'Select a provider/model in the header first'}
					>
						Analyze references
					</button>
					{#if !provider}
						<span class="muted">Needs a selected provider/model — analysis is three specialist agent runs.</span>
					{/if}
				</footer>
			{:else if step === 2}
				<div class="log">
					{#each runLog as line}
						<div>{line}</div>
					{/each}
					{#if analyzing}
						<div class="muted">Working…</div>
					{/if}
				</div>
				<footer class="foot">
					<button disabled={analyzing} onclick={() => void startAnalysis()}>
						<RefreshCw size={14} /> Re-run
					</button>
					<button class="primary" disabled={analyzing} onclick={() => (step = 3)}>Continue</button>
				</footer>
			{:else if step === 3}
				{#if !activeTrial}
					<p class="muted">No close calls pending. Re-run analysis with a provider to generate agent A/B pairs, or view the active skill.</p>
					<button class="primary" onclick={() => (step = 4)}>View active skill</button>
				{:else}
					<p class="brief">{activeTrial.brief}</p>
					<div class="ab">
						<div class="card">
							<h3>A</h3>
							<p>{activeTrial.variantA}</p>
							<button class="primary" onclick={() => void answerTrial('a')}>Choose A</button>
						</div>
						<div class="card">
							<h3>B</h3>
							<p>{activeTrial.variantB}</p>
							<button class="primary" onclick={() => void answerTrial('b')}>Choose B</button>
						</div>
					</div>
					<div class="ab-actions">
						<button onclick={() => void answerTrial('same')}>Both are the same to me</button>
						<button onclick={() => void answerTrial('skip')}>Skip</button>
					</div>
					<details class="block">
						<summary>Neither is good — edit one</summary>
						<textarea rows="4" bind:value={editNeither} placeholder="Rewrite a good version…"></textarea>
						<button
							disabled={!editNeither.trim()}
							onclick={() => void answerTrial('edited')}
						>
							Save edited example
						</button>
					</details>
				{/if}
			{:else}
				{#if !profile?.hasSkill}
					<p class="muted">No active skill yet. Run analysis from Sources.</p>
				{:else}
					<p>
						<strong>{profile.activeCount}</strong> active propositions
						{#if profile.stale}<span class="warn"> · stale vs references</span>{/if}
					</p>
					<ul class="props">
						{#each (profile.propositions ?? []).filter((p) => p.status === 'active' && p.enabled) as p (p.id)}
							<li>
								<span class="tag">{p.family}</span>
								{p.instruction}
								<span class="muted">conf {p.confidence.final.toFixed(2)}</span>
							</li>
						{/each}
					</ul>
					<footer class="foot">
						<a class="primary" href="/api/style-profile/bundle">
							<Download size={14} /> Download skill zip
						</a>
						<button onclick={() => void startAnalysis()}>Rerun analysis</button>
					</footer>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(20, 18, 16, 0.35);
		z-index: 80;
	}
	.modal {
		position: fixed;
		top: 8vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(720px, calc(100vw - 2rem));
		max-height: 84vh;
		overflow: auto;
		background: #fffaf3;
		border: 1px solid #e7e0d4;
		border-radius: 12px;
		z-index: 81;
		box-shadow: 0 16px 48px rgba(40, 30, 20, 0.18);
		font-family: Inter, system-ui, sans-serif;
		color: #2a241c;
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.1rem 0.5rem;
	}
	.head h2 {
		margin: 0;
		font-family: Lora, Georgia, serif;
		font-size: 1.25rem;
		font-weight: 600;
	}
	.sub {
		margin: 0.2rem 0 0;
		font-size: 0.85rem;
		color: #6b6358;
	}
	.icon {
		border: none;
		background: transparent;
		cursor: pointer;
		color: #6b6358;
	}
	.steps {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid #ebe4d8;
		flex-wrap: wrap;
	}
	.steps button {
		border: none;
		background: transparent;
		padding: 0.35rem 0.55rem;
		border-radius: 6px;
		font-size: 0.78rem;
		color: #6b6358;
		cursor: pointer;
	}
	.steps button.on {
		background: #efe6d6;
		color: #2a241c;
		font-weight: 600;
	}
	.body {
		padding: 1rem 1.1rem 1.2rem;
	}
	.role-row,
	.actions,
	.foot,
	.ab-actions,
	.preview-head {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
		margin: 0.5rem 0;
	}
	.block {
		margin: 0.75rem 0;
		padding: 0.6rem 0.7rem;
		border: 1px solid #ebe4d8;
		border-radius: 8px;
		background: #fff;
	}
	.block input,
	.block textarea,
	.preview textarea,
	select {
		width: 100%;
		margin: 0.35rem 0;
		font: inherit;
		padding: 0.4rem 0.5rem;
		border: 1px solid #ddd4c6;
		border-radius: 6px;
		background: #fff;
	}
	button,
	a.primary {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: 1px solid #ddd4c6;
		background: #fff;
		border-radius: 6px;
		padding: 0.35rem 0.65rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		text-decoration: none;
		color: inherit;
	}
	button.primary,
	a.primary {
		background: #2f6f4e;
		border-color: #2f6f4e;
		color: #fff;
	}
	button.ghost {
		border: none;
		background: transparent;
		padding: 0.25rem;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.refs,
	.props {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
	}
	.refs li,
	.props li {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.45rem 0;
		border-bottom: 1px solid #f0e9dd;
		font-size: 0.85rem;
	}
	.ref-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.muted {
		color: #8a8072;
		font-size: 0.8rem;
	}
	.warn {
		color: #8a4b1f;
	}
	.log {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		background: #fff;
		border: 1px solid #ebe4d8;
		border-radius: 8px;
		padding: 0.75rem;
		min-height: 8rem;
		white-space: pre-wrap;
	}
	.ab {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	@media (max-width: 640px) {
		.ab {
			grid-template-columns: 1fr;
		}
	}
	.card {
		border: 1px solid #ebe4d8;
		border-radius: 8px;
		padding: 0.75rem;
		background: #fff;
	}
	.card h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
	}
	.card p {
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 0 0 0.75rem;
	}
	.tag {
		display: inline-block;
		font-size: 0.7rem;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
		background: #efe6d6;
		margin-right: 0.35rem;
	}
	.brief {
		font-size: 0.9rem;
		color: #4a4338;
	}
</style>
