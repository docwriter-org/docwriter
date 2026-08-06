<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		X,
		Plus,
		Trash2,
		Download,
		RefreshCw,
		FileText,
		Ruler,
		Sparkles,
		Layers,
		GitMerge,
		Scale,
		Package,
		CheckCircle2,
		AlertCircle,
		BookOpen,
		Link2,
		Eye
	} from 'lucide-svelte';

	const NOTICE_ICONS = {
		book: BookOpen,
		file: FileText,
		ruler: Ruler,
		sparkles: Sparkles,
		layers: Layers,
		merge: GitMerge,
		scale: Scale,
		package: Package,
		check: CheckCircle2,
		alert: AlertCircle
	} as const;
	type NoticeIconKey = keyof typeof NOTICE_ICONS;

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

	type NoticeTone = 'info' | 'progress' | 'success' | 'warn' | 'error';

	interface Notice {
		id: string;
		title: string;
		description: string;
		tone: NoticeTone;
		icon: NoticeIconKey;
		timeLabel: string;
		at: number;
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

	/** 1 Sources · 2 Review (analysis + calibration) · 3 Skill */
	let step = $state<1 | 2 | 3>(1);
	let references = $state<RefRow[]>([]);
	let loading = $state(false);
	let analyzing = $state(false);
	let analysisError = $state<string | null>(null);
	let notices = $state<Notice[]>([]);
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
	let noticeListEl = $state<HTMLDivElement | null>(null);

	const remainingTrials = $derived(
		(profile?.calibrationTrials ?? []).filter((t) => t.status === 'pending')
	);
	const trialIndex = $derived.by(() => {
		if (!activeTrial) return 0;
		const idx = remainingTrials.findIndex((t) => t.id === activeTrial!.id);
		return idx >= 0 ? idx + 1 : 1;
	});
	const activeProps = $derived(
		(profile?.propositions ?? []).filter((p) => p.status === 'active' && p.enabled)
	);
	const calibrationProps = $derived(
		(profile?.propositions ?? []).filter((p) => p.status === 'calibration' && p.enabled)
	);
	const hasCompiledSkill = $derived(
		!!profile && ((profile.propositions?.length ?? 0) > 0 || profile.hasSkill)
	);

	let stepInitialized = false;

	function phaseNotice(
		phase: string,
		message: string,
		tone: NoticeTone = 'info'
	): Omit<Notice, 'id' | 'at' | 'timeLabel'> {
		const map: Record<string, { title: string; icon: NoticeIconKey; tone: NoticeTone }> = {
			materialize: { title: 'Reading sources', icon: 'book', tone: 'progress' },
			normalize: { title: 'Normalizing prose', icon: 'file', tone: 'progress' },
			measure: { title: 'Measuring style signals', icon: 'ruler', tone: 'progress' },
			specialists: { title: 'Specialists reviewing voice', icon: 'sparkles', tone: 'progress' },
			synthesis: { title: 'Synthesizing style rules', icon: 'merge', tone: 'progress' },
			calibration: { title: 'Preparing close calls', icon: 'scale', tone: 'progress' },
			compile: { title: 'Compiling author-style skill', icon: 'package', tone: 'progress' },
			cancelled: { title: 'Run cancelled', icon: 'alert', tone: 'warn' }
		};
		const hit = map[phase];
		return {
			title: hit?.title ?? message,
			description: hit && message !== hit.title ? message : friendlyDescription(phase, message),
			tone: hit?.tone ?? tone,
			icon: hit?.icon ?? 'layers'
		};
	}

	function friendlyDescription(phase: string, message: string): string {
		if (phase === 'specialists') return 'Organization, language, and discourse agents are reading your metrics.';
		if (phase === 'synthesis') return 'Merging specialist findings into a coherent style profile.';
		if (phase === 'calibration') return 'The agent is writing A/B pairs for uncertain style choices.';
		if (phase === 'compile') return 'Writing SKILL.md and syncing it into your workspace skills.';
		if (phase === 'measure') return 'Sentence rhythm, lexicon, and punctuation features.';
		if (message && message.length < 120) return message;
		return 'Working…';
	}

	function pushNotice(partial: Omit<Notice, 'id' | 'at' | 'timeLabel'>, timeLabel = 'just now') {
		const at = Date.now();
		notices = [
			{
				...partial,
				id: `n_${at}_${Math.random().toString(36).slice(2, 6)}`,
				at,
				timeLabel
			},
			...notices
		].slice(0, 24);
		void tick().then(() => {
			noticeListEl?.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	/** Reconstruct a short completed-run feed when reopening Review after analyze. */
	function seedCompletedNotices(prof: {
		activeCount: number;
		unresolvedCalibration: number;
		lastRunId?: string | null;
	}) {
		if (notices.length || analyzing) return;
		if (!prof.lastRunId && !prof.unresolvedCalibration && !prof.activeCount) return;
		const seeded: Notice[] = [
			{
				id: 'seed_ready',
				title: 'Ready for your review',
				description: `${prof.activeCount} active rules · ${prof.unresolvedCalibration} close calls to decide`,
				tone: 'success',
				icon: 'check',
				timeLabel: 'last run',
				at: Date.now()
			},
			{
				id: 'seed_compile',
				title: 'Author-style skill compiled',
				description: 'SKILL.md is synced into this workspace.',
				tone: 'info',
				icon: 'package',
				timeLabel: 'last run',
				at: Date.now() - 1
			},
			{
				id: 'seed_calib',
				title: 'Close calls prepared',
				description: 'Agent wrote A/B pairs for uncertain style choices.',
				tone: 'info',
				icon: 'scale',
				timeLabel: 'last run',
				at: Date.now() - 2
			},
			{
				id: 'seed_synth',
				title: 'Style rules synthesized',
				description: 'Specialist findings merged into one profile.',
				tone: 'info',
				icon: 'merge',
				timeLabel: 'last run',
				at: Date.now() - 3
			}
		];
		notices = seeded;
	}

	async function refresh(opts: { initStep?: boolean } = {}) {
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
			const pending = (profData.calibrationTrials ?? []).filter(
				(t: Trial) => t.status === 'pending'
			);
			if (pending.length) {
				activeTrial = pending[0];
			} else {
				activeTrial = null;
			}
			seedCompletedNotices(profData);
			if (opts.initStep || !stepInitialized) {
				stepInitialized = true;
				if (!analyzing) {
					if (!references.length) step = 1;
					else if (pending.length > 0) step = 2;
					else if (profData.hasSkill || (profData.propositions?.length ?? 0) > 0) step = 3;
					else step = 1;
				}
			}
		} finally {
			loading = false;
			onChanged?.();
		}
	}

	onMount(() => {
		if (open) void refresh({ initStep: true });
	});

	$effect(() => {
		if (open) {
			stepInitialized = false;
			void refresh({ initStep: true });
		}
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
		analysisError = null;
		step = 2;
		notices = [];
		pushNotice({
			title: 'Starting analysis',
			description: provider
				? `Using ${provider}${model ? ` · ${model}` : ''}`
				: 'Starting…',
			tone: 'info',
			icon: 'sparkles'
		});
		let succeeded = false;
		try {
			const res = await fetch('/api/style-profile/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: provider || undefined,
					model: model || undefined,
					useHeuristicsOnly: false
				})
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.message || 'Failed to start run');
			onChanged?.();
			const es = new EventSource(`/api/style-profile/runs/${data.runId}/events`);
			await new Promise<void>((resolve, reject) => {
				es.onmessage = (ev) => {
					try {
						const msg = JSON.parse(ev.data);
						if (msg.type === 'status') {
							if (msg.phase === 'cancelled') {
								pushNotice(phaseNotice('cancelled', msg.message, 'warn'));
								es.close();
								reject(new Error('Run cancelled'));
								return;
							}
							pushNotice(phaseNotice(msg.phase, msg.message));
						}
						if (msg.type === 'progress') {
							pushNotice({
								title: `Sources ${msg.current} of ${msg.total}`,
								description: 'Extracting and caching reference text.',
								tone: 'progress',
								icon: 'book'
							});
						}
						if (msg.type === 'error') {
							pushNotice({
								title: 'Analysis failed',
								description: msg.message || 'Something went wrong.',
								tone: 'error',
								icon: 'alert'
							});
							es.close();
							reject(new Error(msg.message || 'Analysis failed'));
						}
						if (msg.type === 'done') {
							pushNotice({
								title: 'Ready for your review',
								description: `${msg.activeCount} active rules · ${msg.unresolved} close calls to decide`,
								tone: 'success',
								icon: 'check'
							});
							es.close();
							succeeded = true;
							resolve();
						}
					} catch {
						/* ignore parse errors */
					}
				};
				es.onerror = () => {
					if (es.readyState === EventSource.CLOSED) {
						es.close();
						if (!succeeded) reject(new Error('Lost connection to analysis stream'));
						else resolve();
					}
				};
			});
		} catch (e) {
			analysisError = (e as Error).message;
			pushNotice({
				title: 'Could not finish',
				description: analysisError,
				tone: 'error',
				icon: 'alert'
			});
			succeeded = false;
		} finally {
			analyzing = false;
			await refresh();
			step = 2;
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
		if (!(profile?.calibrationTrials ?? []).some((t) => t.status === 'pending')) {
			pushNotice({
				title: 'Calibration complete',
				description: 'Your choices are baked into the author-style skill.',
				tone: 'success',
				icon: 'check'
			});
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Writing references">
		<header class="head">
			<div class="head-copy">
				<h2>Writing references</h2>
				<p class="sub">Gather sources, watch the build, and settle close calls in one place.</p>
			</div>
			<button class="icon" onclick={onClose} aria-label="Close"><X size={18} /></button>
		</header>

		<nav class="steps">
			<button class:on={step === 1} onclick={() => (step = 1)}>
				<span class="step-n">1</span> Sources
			</button>
			<button class:on={step === 2} onclick={() => (step = 2)}>
				<span class="step-n">2</span> Review
			</button>
			<button class:on={step === 3} onclick={() => (step = 3)}>
				<span class="step-n">3</span> Skill
			</button>
		</nav>

		<div class="body" class:review={step === 2}>
			{#if step === 1}
				<div class="sources-layout">
					<aside class="sources-rail">
						<div class="role-row">
							<label for="style-role">Default role</label>
							<select id="style-role" bind:value={role}>
								<option value="authored">My writing</option>
								<option value="inspiration">Style I want</option>
							</select>
						</div>

						<button class="rail-btn" disabled={!activeTabId} onclick={() => void addCurrent()}>
							<Plus size={15} /> Add current file
						</button>

						<details class="block" open>
							<summary>Paste a sample</summary>
							<input placeholder="Name" bind:value={sampleName} />
							<textarea rows="7" placeholder="Paste a few paragraphs…" bind:value={sampleContent}
							></textarea>
							<button class="primary" onclick={() => void addSample()}>Save sample</button>
						</details>

						<details class="block">
							<summary><Link2 size={14} /> Add a URL</summary>
							<input placeholder="https://…" bind:value={urlValue} />
							<input placeholder="Label (optional)" bind:value={urlLabel} />
							<button onclick={() => void addUrl()}>Add URL</button>
						</details>
					</aside>

					<section class="sources-main">
						<div class="panel-head">
							<h3>Your references</h3>
							<span class="muted">{references.length} source{references.length === 1 ? '' : 's'}</span>
						</div>

						{#if loading}
							<p class="muted">Loading…</p>
						{:else if references.length === 0}
							<div class="empty">
								<BookOpen size={28} strokeWidth={1.5} />
								<p>Add writing you already sound like — files, pastes, or URLs.</p>
							</div>
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
												void setRole(
													ref.id,
													(e.currentTarget as HTMLSelectElement).value as any
												)}
										>
											<option value="authored">authored</option>
											<option value="inspiration">inspiration</option>
										</select>
										<button class="ghost" onclick={() => void preview(ref.id)} title="Preview">
											<Eye size={15} />
										</button>
										<button
											class="ghost"
											onclick={() => void removeRef(ref.id)}
											aria-label="Remove"
										>
											<Trash2 size={15} />
										</button>
									</li>
								{/each}
							</ul>
						{/if}

						{#if previewId}
							<div class="preview">
								<div class="preview-head">
									<span>Extracted text — edit freely, then save</span>
									<button class="primary" onclick={() => void savePreview()}>Save corrections</button>
								</div>
								<textarea rows="12" bind:value={previewText}></textarea>
							</div>
						{/if}

						<footer class="foot">
							<button
								class="primary large"
								disabled={!references.length || !provider || analyzing}
								onclick={() => void startAnalysis()}
								title={provider
									? 'Run specialist agent passes with the selected model'
									: 'Select a provider/model in the header first'}
							>
								Analyze & review
							</button>
							{#if !provider}
								<span class="muted">Select a provider/model in the header first.</span>
							{/if}
						</footer>
					</section>
				</div>
			{:else if step === 2}
				<div class="review-layout">
					<aside class="notice-rail">
						<div class="panel-head">
							<h3>Build progress</h3>
							{#if analyzing}
								<span class="pulse-dot" aria-hidden="true"></span>
							{/if}
						</div>
						<div class="notice-list" bind:this={noticeListEl}>
							{#if notices.length === 0 && !analyzing}
								<div class="empty compact">
									<p class="muted">
										{#if remainingTrials.length}
											Close calls are ready on the right. Re-run anytime to rebuild.
										{:else}
											Run analysis to see live updates here.
										{/if}
									</p>
									<button
										class="primary"
										disabled={!provider || !references.length}
										onclick={() => void startAnalysis()}
									>
										{remainingTrials.length ? 'Re-run analysis' : 'Start analysis'}
									</button>
								</div>
							{/if}
							{#each notices as n (n.id)}
								{@const NoticeIcon = NOTICE_ICONS[n.icon]}
								<figure class="notice" data-tone={n.tone}>
									<div
										class="notice-icon"
										style:--tone-bg={n.tone === 'success'
											? '#2f6f4e'
											: n.tone === 'error'
												? '#b42318'
												: n.tone === 'warn'
													? '#a15c2d'
													: n.tone === 'progress'
														? '#2563eb'
														: '#5b6472'}
									>
										<NoticeIcon size={18} color="#fff" strokeWidth={2} />
									</div>
									<figcaption class="notice-body">
										<div class="notice-head">
											<span class="notice-title">{n.title}</span>
											<span class="notice-time">{n.timeLabel}</span>
										</div>
										<p>{n.description}</p>
									</figcaption>
								</figure>
							{/each}
						</div>
						<div class="notice-fade" aria-hidden="true"></div>
						<footer class="rail-foot">
							<button disabled={analyzing} onclick={() => void startAnalysis()}>
								<RefreshCw size={14} /> Re-run
							</button>
						</footer>
					</aside>

					<section class="review-main">
						{#if analyzing}
							<div class="hero-status">
								<div class="hero-orb" aria-hidden="true"></div>
								<h3>Building your author-style skill</h3>
								<p>
									Specialists are measuring and interpreting your references. Close-call review
									will appear here when pairs are ready — no need to switch tabs.
								</p>
							</div>
						{:else if activeTrial}
							<div class="calib-head">
								<div>
									<p class="eyebrow">Close call {trialIndex} of {remainingTrials.length}</p>
									<h3>Which sounds more like you?</h3>
									<p class="brief">{activeTrial.brief}</p>
								</div>
							</div>
							<div class="ab">
								<button class="choice" type="button" onclick={() => void answerTrial('a')}>
									<span class="choice-label">A</span>
									<p>{activeTrial.variantA}</p>
									<span class="choice-cta">Choose A</span>
								</button>
								<button class="choice" type="button" onclick={() => void answerTrial('b')}>
									<span class="choice-label">B</span>
									<p>{activeTrial.variantB}</p>
									<span class="choice-cta">Choose B</span>
								</button>
							</div>
							<div class="ab-actions">
								<button onclick={() => void answerTrial('same')}>Both feel the same</button>
								<button onclick={() => void answerTrial('skip')}>Skip</button>
							</div>
							<details class="block">
								<summary>Neither — write a better line</summary>
								<textarea
									rows="4"
									bind:value={editNeither}
									placeholder="Rewrite a version you’d actually publish…"
								></textarea>
								<button
									class="primary"
									disabled={!editNeither.trim()}
									onclick={() => void answerTrial('edited')}
								>
									Save edited example
								</button>
							</details>
						{:else if analysisError}
							<div class="hero-status">
								<AlertCircle size={28} />
								<h3>Analysis didn’t finish</h3>
								<p>{analysisError}</p>
								<button class="primary" onclick={() => void startAnalysis()}>Try again</button>
							</div>
						{:else if profile?.hasSkill}
							<div class="hero-status done">
								<CheckCircle2 size={28} />
								<h3>No close calls left</h3>
								<p>
									{profile.activeCount} active style rules are in the skill.
									{#if profile.stale} References changed — re-run when you’re ready.{/if}
								</p>
								<button class="primary" onclick={() => (step = 3)}>View active skill</button>
							</div>
						{:else}
							<div class="hero-status">
								<Sparkles size={28} />
								<h3>Ready when you are</h3>
								<p>Add sources, then analyze. Progress and calibration stay in this view.</p>
								<button
									class="primary"
									disabled={!provider || !references.length}
									onclick={() => void startAnalysis()}
								>
									Analyze references
								</button>
							</div>
						{/if}
					</section>
				</div>
			{:else}
				{#if !hasCompiledSkill}
					<div class="hero-status">
						<p class="muted">No skill draft yet. Analyze from Sources or Review.</p>
						<button class="primary" onclick={() => (step = 1)}>Back to sources</button>
					</div>
				{:else}
					<div class="skill-layout">
						<div class="panel-head">
							<div>
								<h3>Author-style skill</h3>
								<p class="muted">
									{activeProps.length} active
									{#if calibrationProps.length}
										· {calibrationProps.length} awaiting close calls
									{/if}
									{#if profile?.stale}<span class="warn"> · stale vs references</span>{/if}
								</p>
							</div>
							<div class="foot">
								{#if activeProps.length}
									<a class="primary" href="/api/style-profile/bundle">
										<Download size={14} /> Download zip
									</a>
								{/if}
								{#if remainingTrials.length}
									<button class="primary" onclick={() => (step = 2)}>Continue review</button>
								{/if}
								<button onclick={() => void startAnalysis()}>Rerun analysis</button>
							</div>
						</div>
						{#if activeProps.length}
							<h4 class="skill-section">Active in SKILL.md</h4>
							<ul class="props">
								{#each activeProps as p (p.id)}
									<li>
										<span class="tag">{p.family.replace(/_/g, ' ')}</span>
										<span class="prop-text">{p.instruction}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<div class="skill-banner">
								<p>
									Rules are drafted but not active yet — finish the
									{remainingTrials.length || calibrationProps.length} close calls in Review
									to promote them into SKILL.md.
								</p>
							</div>
						{/if}
						{#if calibrationProps.length}
							<h4 class="skill-section">Awaiting your close calls</h4>
							<ul class="props muted-list">
								{#each calibrationProps as p (p.id)}
									<li>
										<span class="tag warn-tag">{p.family.replace(/_/g, ' ')}</span>
										<span class="prop-text">{p.instruction}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--text, #111) 28%, transparent);
		backdrop-filter: blur(2px);
		z-index: 80;
	}
	.modal {
		position: fixed;
		inset: 2.5vh 2.5vw;
		width: auto;
		height: auto;
		display: flex;
		flex-direction: column;
		background: var(--bg-surface, #fff);
		border: 1px solid var(--border-light, #e5e5e5);
		border-radius: 14px;
		z-index: 81;
		box-shadow: 0 24px 80px color-mix(in srgb, var(--text, #111) 22%, transparent);
		font-family: Inter, system-ui, sans-serif;
		color: var(--text, #222);
		overflow: hidden;
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.15rem 1.35rem 0.65rem;
		flex-shrink: 0;
	}
	.head-copy h2 {
		margin: 0;
		font-family: Lora, Georgia, serif;
		font-size: 1.45rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.sub {
		margin: 0.25rem 0 0;
		font-size: 0.9rem;
		color: var(--text-secondary, #666);
		max-width: 42rem;
	}
	.icon {
		border: none;
		background: transparent;
		cursor: pointer;
		color: var(--text-secondary, #666);
		padding: 0.35rem;
		border-radius: 8px;
	}
	.icon:hover {
		background: var(--bg-hover, #f4f4f4);
	}
	.steps {
		display: flex;
		gap: 0.35rem;
		padding: 0.35rem 1.35rem 0.85rem;
		border-bottom: 1px solid var(--border-light, #e5e5e5);
		flex-shrink: 0;
	}
	.steps button {
		border: none;
		background: transparent;
		padding: 0.45rem 0.75rem;
		border-radius: 999px;
		font-size: 0.84rem;
		color: var(--text-secondary, #666);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.steps button.on {
		background: color-mix(in srgb, var(--accent, #2f6f4e) 14%, transparent);
		color: var(--text, #222);
		font-weight: 600;
	}
	.step-n {
		display: inline-grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		font-size: 0.7rem;
		background: color-mix(in srgb, var(--text, #111) 8%, transparent);
	}
	.steps button.on .step-n {
		background: var(--accent, #2f6f4e);
		color: #fff;
	}
	.body {
		flex: 1;
		min-height: 0;
		padding: 1.1rem 1.35rem 1.25rem;
		overflow: auto;
	}
	.body.review {
		padding: 0;
		overflow: hidden;
	}

	.sources-layout,
	.review-layout {
		display: grid;
		grid-template-columns: minmax(300px, 360px) 1fr;
		gap: 0;
		height: 100%;
		min-height: 0;
	}
	.review-layout {
		grid-template-columns: minmax(280px, 32%) 1fr;
	}
	.sources-layout {
		gap: 1.1rem;
		height: auto;
		min-height: 100%;
	}
	.sources-rail,
	.notice-rail {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		min-height: 0;
		border-right: 1px solid var(--border-light, #e5e5e5);
		padding: 1.1rem 1rem 1rem 1.25rem;
		background: color-mix(in srgb, var(--bg-surface, #fff) 88%, var(--text, #111) 3%);
	}
	.sources-rail {
		border: 1px solid var(--border-light, #e5e5e5);
		border-radius: 12px;
		padding: 1rem;
		background: color-mix(in srgb, var(--bg-surface, #fff) 92%, var(--text, #111) 2%);
	}
	.sources-main,
	.review-main,
	.skill-layout {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.review-main {
		padding: 1.25rem 1.4rem 1.4rem;
		overflow: auto;
	}
	.sources-main {
		padding-top: 0.15rem;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.panel-head h3,
	.calib-head h3,
	.hero-status h3 {
		margin: 0;
		font-size: 1.15rem;
		font-family: Lora, Georgia, serif;
		font-weight: 600;
	}
	.role-row {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--text-secondary, #666);
	}
	.rail-btn {
		width: 100%;
		justify-content: center;
	}

	.block {
		margin: 0;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--border-light, #e5e5e5);
		border-radius: 10px;
		background: var(--bg-surface, #fff);
	}
	.block summary {
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.block input,
	.block textarea,
	.preview textarea,
	select {
		width: 100%;
		margin: 0.4rem 0;
		font: inherit;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border-light, #e5e5e5);
		border-radius: 8px;
		background: var(--bg-surface, #fff);
		color: inherit;
		box-sizing: border-box;
	}
	.block textarea,
	.preview textarea {
		resize: vertical;
		line-height: 1.45;
	}

	button,
	a.primary {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--border-light, #e5e5e5);
		background: var(--bg-surface, #fff);
		border-radius: 8px;
		padding: 0.42rem 0.75rem;
		font: inherit;
		font-size: 0.86rem;
		cursor: pointer;
		text-decoration: none;
		color: inherit;
	}
	button.primary,
	a.primary {
		background: var(--accent, #2f6f4e);
		border-color: var(--accent, #2f6f4e);
		color: #fff;
	}
	button.large {
		padding: 0.65rem 1.1rem;
		font-size: 0.95rem;
	}
	button.ghost {
		border: none;
		background: transparent;
		padding: 0.35rem;
		color: var(--text-secondary, #666);
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.foot,
	.ab-actions,
	.preview-head,
	.rail-foot {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		flex-wrap: wrap;
		margin-top: auto;
	}
	.rail-foot {
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-light, #e5e5e5);
	}

	.refs,
	.props {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.refs li,
	.props li {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		padding: 0.7rem 0.15rem;
		border-bottom: 1px solid var(--border-light, #e5e5e5);
		font-size: 0.9rem;
	}
	.props li {
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.85rem 0;
	}
	.ref-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0.15rem;
	}
	.prop-text {
		flex: 1;
		line-height: 1.45;
	}
	.muted {
		color: var(--text-secondary, #888);
		font-size: 0.82rem;
	}
	.warn {
		color: #8a4b1f;
	}
	.tag {
		display: inline-block;
		font-size: 0.72rem;
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent, #2f6f4e) 12%, transparent);
		color: var(--text-secondary, #555);
		text-transform: capitalize;
		white-space: nowrap;
		margin-top: 0.15rem;
	}
	.empty {
		display: grid;
		place-items: center;
		gap: 0.65rem;
		padding: 2.5rem 1rem;
		text-align: center;
		color: var(--text-secondary, #666);
		border: 1px dashed var(--border-light, #e5e5e5);
		border-radius: 12px;
	}
	.empty.compact {
		border: none;
		padding: 1.5rem 0.5rem;
	}
	.preview {
		border: 1px solid var(--border-light, #e5e5e5);
		border-radius: 12px;
		padding: 0.75rem;
		background: color-mix(in srgb, var(--bg-surface, #fff) 94%, var(--text, #111) 2%);
	}

	/* Animated notice list (Magic UI–style cards) */
	.notice-list {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding-bottom: 2rem;
	}
	.notice-fade {
		pointer-events: none;
		position: absolute;
		left: 0;
		right: 0;
		bottom: 2.75rem;
		height: 3.5rem;
		background: linear-gradient(
			to top,
			color-mix(in srgb, var(--bg-surface, #fff) 92%, var(--text, #111) 3%),
			transparent
		);
	}
	.notice-rail {
		position: relative;
	}
	.notice {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		width: 100%;
		padding: 0.85rem 0.9rem;
		border-radius: 14px;
		background: var(--bg-surface, #fff);
		border: 1px solid color-mix(in srgb, var(--border-light, #e5e5e5) 85%, transparent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--text, #111) 3%, transparent),
			0 2px 4px color-mix(in srgb, var(--text, #111) 4%, transparent),
			0 10px 24px color-mix(in srgb, var(--text, #111) 5%, transparent);
		animation: notice-in 420ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
		margin: 0;
	}
	.notice-icon {
		flex-shrink: 0;
		width: 2.35rem;
		height: 2.35rem;
		border-radius: 12px;
		display: grid;
		place-items: center;
		background: var(--tone-bg, #5b6472);
	}
	.notice-body {
		min-width: 0;
		flex: 1;
		margin: 0;
	}
	.notice-head {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.notice-title {
		font-size: 0.92rem;
		font-weight: 600;
	}
	.notice-time {
		font-size: 0.72rem;
		color: var(--text-secondary, #888);
	}
	.notice-body p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		line-height: 1.4;
		color: var(--text-secondary, #666);
	}
	@keyframes notice-in {
		from {
			opacity: 0;
			transform: scale(0.92) translateY(-10px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}
	.pulse-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: var(--accent, #2f6f4e);
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent, #2f6f4e) 55%, transparent);
		animation: pulse 1.4s ease-out infinite;
	}
	@keyframes pulse {
		70% {
			box-shadow: 0 0 0 8px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}

	.hero-status {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 0.75rem;
		padding: 1.5rem 0.5rem;
		max-width: 36rem;
	}
	.hero-status.done {
		color: var(--text, #222);
	}
	.hero-status p {
		margin: 0;
		color: var(--text-secondary, #666);
		line-height: 1.5;
		font-size: 0.95rem;
	}
	.hero-orb {
		width: 3rem;
		height: 3rem;
		border-radius: 999px;
		background: radial-gradient(
			circle at 30% 30%,
			color-mix(in srgb, var(--accent, #2f6f4e) 55%, #fff),
			var(--accent, #2f6f4e)
		);
		animation: orb 1.8s ease-in-out infinite;
	}
	@keyframes orb {
		0%,
		100% {
			transform: scale(1);
			opacity: 0.9;
		}
		50% {
			transform: scale(1.08);
			opacity: 1;
		}
	}

	.eyebrow {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary, #888);
	}
	.brief {
		margin: 0.45rem 0 0;
		font-size: 0.95rem;
		color: var(--text-secondary, #555);
		line-height: 1.45;
		max-width: 42rem;
	}
	.ab {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.9rem;
		margin-top: 0.35rem;
	}
	.choice {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		text-align: left;
		gap: 0.75rem;
		padding: 1.1rem 1.15rem;
		border-radius: 14px;
		border: 1px solid var(--border-light, #e5e5e5);
		background: var(--bg-surface, #fff);
		min-height: 12rem;
		transition:
			border-color 160ms ease,
			transform 160ms ease,
			box-shadow 160ms ease;
	}
	.choice:hover {
		border-color: color-mix(in srgb, var(--accent, #2f6f4e) 45%, var(--border-light, #e5e5e5));
		transform: translateY(-1px);
		box-shadow: 0 10px 28px color-mix(in srgb, var(--text, #111) 8%, transparent);
	}
	.choice-label {
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		color: var(--text-secondary, #888);
	}
	.choice p {
		margin: 0;
		flex: 1;
		font-family: Lora, Georgia, serif;
		font-size: 1.02rem;
		line-height: 1.55;
		color: var(--text, #222);
	}
	.choice-cta {
		font-size: 0.84rem;
		font-weight: 600;
		color: var(--accent, #2f6f4e);
	}
	.skill-layout {
		height: 100%;
		overflow: auto;
	}
	.skill-layout .props {
		padding-right: 0.25rem;
	}
	.skill-section {
		margin: 1rem 0 0.25rem;
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary, #888);
	}
	.skill-banner {
		padding: 0.9rem 1rem;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, #a15c2d 35%, var(--border-light, #e5e5e5));
		background: color-mix(in srgb, #a15c2d 8%, var(--bg-surface, #fff));
	}
	.skill-banner p {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.45;
		color: var(--text, #333);
	}
	.warn-tag {
		background: color-mix(in srgb, #a15c2d 16%, transparent);
	}
	.muted-list .prop-text {
		color: var(--text-secondary, #555);
	}

	@media (max-width: 860px) {
		.modal {
			inset: 0;
			border-radius: 0;
		}
		.sources-layout,
		.review-layout,
		.ab {
			grid-template-columns: 1fr;
		}
		.sources-rail,
		.notice-rail {
			border-right: none;
			border-bottom: 1px solid var(--border-light, #e5e5e5);
			max-height: 38vh;
		}
		.notice-fade {
			bottom: 2.5rem;
		}
		.body.review {
			overflow: auto;
		}
		.review-layout {
			height: auto;
		}
	}
</style>
