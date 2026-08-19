<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
			BarChart3,
		BookOpen,
		Cat,
		Check,
		CheckCircle2,
		Circle,
		Download,
		FileStack,
		LoaderCircle,
		Sparkles,
			TriangleAlert,
		Upload,
		X
	} from 'lucide-svelte';
	import type {
		CalibrationChoice,
		CalibrationTrial,
		MaterializationStatus,
		PropositionStatus,
		SpecialistRunState,
		StyleAnalysisRun,
		StyleProfileSummary,
		StyleProposition,
		StyleReferenceRole
	} from '$lib/style-profile';
	import { isActiveProposition } from '$lib/style-profile';

	interface ReferenceItem {
		id: string;
		label: string;
		type: 'stored-sample';
		target: string;
		role: StyleReferenceRole;
		format?: string;
		contentHash?: string;
		materializationStatus: MaterializationStatus;
		extractedAt?: number;
		error?: string;
		description?: string;
		selected?: boolean;
	}

	type ActivityStatus = SpecialistRunState['status'];
	interface AnalysisActivity {
		id: string;
		title: string;
		description: string;
		status: ActivityStatus;
		icon: 'sources' | 'measurements' | 'specialist';
	}

	interface Props {
		open: boolean;
		provider: string;
		model?: string;
		onClose: () => void;
		onChanged?: () => void;
		onFinalized?: (skillId: string) => void;
	}

	let { open, provider, model, onClose, onChanged, onFinalized }: Props = $props();
	let step = $state<'welcome' | 'sources' | 'review' | 'active'>('sources');
	let references = $state<ReferenceItem[]>([]);
	let summary = $state<StyleProfileSummary | null>(null);
	let loading = $state(false);
	let errorMessage = $state('');
	let sampleDescription = $state('');
	let sampleText = $state('');
	let addingSample = $state(false);
	let previewId = $state<string | null>(null);
	let previewText = $state('');
	let previewLoading = $state(false);
	let run = $state<StyleAnalysisRun | null>(null);
	/** Working traces per specialist, accumulated from the run's SSE stream. */
	type TraceEntry = { kind: 'text' | 'thinking' | 'tool' | 'result' | 'prompt'; text?: string; toolName?: string };
	let specialistTraces = $state<Record<string, TraceEntry[]>>({});
	let selectedStep = $state<string | null>(null);
	let measurements = $state<Array<{ id: string; family: string; label: string; value: number; count: number; sourceCount: number }>>([]);
	let measurementsLoading = $state(false);
	let eventSource: EventSource | null = null;
	let busyId = $state<string | null>(null);
	let neitherEdits = $state<Record<string, string>>({});
	let calibrationSessionIds = $state<string[]>([]);
	let uploadingSkill = $state(false);
	let finalizing = $state(false);

	const pendingTrials = $derived((summary?.profile?.calibrations ?? [])
		.filter((trial) => calibrationSessionIds.includes(trial.id) && ['pending', 'generated', 'error'].includes(trial.status)));
	const activePropositions = $derived((summary?.profile?.propositions ?? []).filter(isActiveProposition));
	const allPropositions = $derived(summary?.profile?.propositions ?? []);
	const inactivePropositions = $derived(allPropositions.filter((proposition) => !isActiveProposition(proposition)));
	const analysisRunning = $derived(Boolean(run && ['queued', 'running'].includes(run.status)));
	const canFinalize = $derived(Boolean(
		summary?.hasUnpublishedChanges
		&& !analysisRunning
		&& summary?.unresolvedCount === 0
		&& activePropositions.length > 0
	));

	/** Why a proposition is not in the skill, in the reader's terms rather than
	 *  the status name stored on it. */
	function inactiveReason(status: PropositionStatus): string {
		if (status === 'pending') return 'Waiting on your pick';
		if (status === 'disabled') return 'You removed it';
		if (status === 'not-actionable') return 'Too vague to act on';
		if (status === 'skipped') return 'You skipped it';
		return titleCase(status);
	}
	const analysisActivities = $derived.by((): AnalysisActivity[] => {
		const currentRun = run;
		if (!currentRun) return [];
		const thresholdStatus = (completeAt: number, startAt: number): ActivityStatus => {
			if (currentRun.progress >= completeAt) return 'completed';
			if (currentRun.status === 'error' && currentRun.progress >= startAt) return 'error';
			if (currentRun.status === 'cancelled' && currentRun.progress >= startAt) return 'cancelled';
			return currentRun.progress >= startAt || ['queued', 'running'].includes(currentRun.status) ? 'running' : 'pending';
		};
		// Every stage is listed from the start, so the reader can see what is
		// coming and what is left. Stages that have not begun sit as pending
		// rather than appearing out of nowhere partway through the run.
		const items: AnalysisActivity[] = [
			{
				id: 'sources',
				title: 'Sources prepared',
				description: `Reading and normalizing ${selectedCount} kept source${selectedCount === 1 ? '' : 's'}.`,
				status: thresholdStatus(20, 0),
				icon: 'sources'
			},
			{
				id: 'measurements',
				title: 'Measurements computed',
				description: 'Measuring words, sentences, figures, cohesion, context, and document conventions.',
				status: thresholdStatus(35, 12),
				icon: 'measurements'
			}
		];

		const specialistCopy: Record<SpecialistRunState['id'], { title: string; description: string }> = {
			lexis: {
				title: 'Lexis specialist',
				description: 'Reviewing word choice, register, vocabulary texture, and signature phrasing.'
			},
			grammar: {
				title: 'Grammar specialist',
				description: 'Reviewing sentences, clauses, phrase structure, voice, and punctuation.'
			},
			discourse: {
				title: 'Discourse specialist',
				description: 'Reviewing figures, cohesion, reader relationship, evidence, and other voices.'
			},
			synthesis: {
				title: 'Guidance combined',
				description: 'Combining grounded propositions and removing duplicates.'
			}
		};
		for (const specialist of currentRun.specialists.filter((item) => item.id !== 'synthesis')) {
			items.push({
				id: specialist.id,
				...specialistCopy[specialist.id],
				status: specialist.status,
				icon: 'specialist'
			});
		}
		const synthesis = currentRun.specialists.find((specialist) => specialist.id === 'synthesis');
		if (synthesis) {
			items.push({ id: synthesis.id, ...specialistCopy.synthesis, status: synthesis.status, icon: 'specialist' });
		}

		return items;
	});

	function messageFromResponse(data: unknown, fallback: string): string {
		if (data && typeof data === 'object') {
			const value = data as Record<string, unknown>;
			if (typeof value.message === 'string') return value.message;
		}
		return fallback;
	}

	async function loadAll() {
		loading = true;
		errorMessage = '';
		try {
			const [referencesResponse, profileResponse] = await Promise.all([
				fetch('/api/references'),
				fetch('/api/style-profile')
			]);
			const referenceData = await referencesResponse.json();
			const profileData = await profileResponse.json();
			references = Array.isArray(referenceData.references) ? referenceData.references : [];
			summary = profileData;
			if (calibrationSessionIds.length === 0) {
				calibrationSessionIds = (summary?.profile?.calibrations ?? [])
					.filter((trial) => ['pending', 'generated', 'error'].includes(trial.status))
					.slice(0, 8)
					.map((trial) => trial.id);
			}
			run = summary?.profile?.lastRun ?? run;
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not load writing references.';
		} finally {
			loading = false;
		}
	}

	/** Traces are stored per run, so a finished run still has a trace to read.
	 *  Fetched once per run rather than from loadAll, which fires on every
	 *  mutation and would replace live SSE lines mid-stream. */
	let tracesLoadedFor = $state<string | null>(null);
	async function loadStoredTraces(runId: string) {
		if (tracesLoadedFor === runId) return;
		tracesLoadedFor = runId;
		try {
			const data = await requestJson(`/api/style-profile/runs/${encodeURIComponent(runId)}/logs`);
			if (data?.traces && typeof data.traces === 'object') {
				specialistTraces = { ...(data.traces as Record<string, TraceEntry[]>) };
			}
		} catch {
			// A missing trace is not worth an error banner.
		}
	}

	$effect(() => {
		if (open) {
			calibrationSessionIds = [];
			tracesLoadedFor = null;
			void loadAll().then(() => {
				if (references.length === 0 && (!summary || summary.status === 'empty') && !summary?.profile?.publishedAt) {
					step = 'welcome';
				}
				if (run?.id) void loadStoredTraces(run.id);
				if (run?.id && ['queued', 'running'].includes(run.status)) connectRun(run.id);
			});
		}
		else eventSource?.close();
	});

	onDestroy(() => eventSource?.close());

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	async function requestJson(path: string, options?: RequestInit) {
		const response = await fetch(path, options);
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(messageFromResponse(data, `HTTP ${response.status}`));
		return data;
	}

	const sampleWordCount = $derived(sampleText.trim().split(/\s+/).filter(Boolean).length);
	const canAddSample = $derived(
		!addingSample && sampleDescription.trim().length > 0 && sampleText.trim().length > 0
	);
	const selectedCount = $derived(references.filter((reference) => reference.selected !== false).length);
	const previewReference = $derived(references.find((item) => item.id === previewId) ?? null);

	/** One pasted passage plus the writer's description of what it is. */
	async function addSample() {
		if (!canAddSample) return;
		addingSample = true;
		errorMessage = '';
		try {
			await requestJson('/api/references', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					mode: 'add-sample',
					description: sampleDescription.trim(),
					content: sampleText
				})
			});
			sampleDescription = '';
			sampleText = '';
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not add that passage.';
		} finally {
			addingSample = false;
		}
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void addSample();
		}
	}

	async function removeReference(reference: ReferenceItem) {
		busyId = reference.id;
		try {
			await requestJson(`/api/references/${encodeURIComponent(reference.id)}`, { method: 'DELETE' });
			if (previewId === reference.id) previewId = null;
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not remove the reference.';
		} finally {
			busyId = null;
		}
	}

	async function materialize(reference: ReferenceItem, force = false) {
		previewLoading = true;
		previewId = reference.id;
		errorMessage = '';
		try {
			const data = await requestJson(`/api/references/${encodeURIComponent(reference.id)}/materialize`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ force })
			});
			previewText = data.text ?? '';
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not read the reference.';
		} finally {
			previewLoading = false;
		}
	}

	async function savePreview() {
		if (!previewId || !previewText.trim()) return;
		previewLoading = true;
		try {
			await requestJson(`/api/references/${encodeURIComponent(previewId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: previewText })
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not save the extracted text.';
		} finally {
			previewLoading = false;
		}
	}

	/** Traces stream as deltas: an open text or thinking line is replaced in
	 *  place until a tool call closes it, so the log reads in order. */
	function appendTrace(specialistId: string, entry: TraceEntry) {
		const existing = specialistTraces[specialistId] ?? [];
		const last = existing[existing.length - 1];
		const next = last && entry.kind !== 'tool' && last.kind === entry.kind
			? [...existing.slice(0, -1), entry]
			: [...existing, entry];
		specialistTraces = { ...specialistTraces, [specialistId]: next };
	}

	async function loadMeasurements() {
		measurementsLoading = true;
		try {
			const data = await requestJson('/api/style-profile/report');
			measurements = Array.isArray(data.measurements) ? data.measurements : [];
		} catch {
			measurements = [];
		} finally {
			measurementsLoading = false;
		}
	}

	function selectStep(id: string) {
		selectedStep = selectedStep === id ? null : id;
		if (selectedStep === 'measurements' && measurements.length === 0) void loadMeasurements();
	}

	function connectRun(runId: string) {
		eventSource?.close();
		eventSource = new EventSource(`/api/style-profile/runs/${encodeURIComponent(runId)}/events`);
		eventSource.addEventListener('specialist_log', (event) => {
			const data = JSON.parse((event as MessageEvent).data);
			if (data.run) run = data.run;
			if (data.log?.specialistId) appendTrace(data.log.specialistId, data.log);
		});
		for (const eventName of ['snapshot', 'progress', 'specialist', 'completed', 'error', 'cancelled']) {
			eventSource.addEventListener(eventName, (event) => {
				const data = JSON.parse((event as MessageEvent).data);
				run = data.run;
				if (['completed', 'error', 'cancelled'].includes(eventName) || ['completed', 'error', 'cancelled'].includes(data.run?.status)) {
					eventSource?.close();
					void loadAll().then(() => onChanged?.());
				}
			});
		}
	}

	async function startAnalysis() {
		errorMessage = '';
		try {
			const data = await requestJson('/api/style-profile/runs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ provider, model })
			});
			run = data.run;
			connectRun(run!.id);
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not start style analysis.';
		}
	}

	/** Discard the current analysis draft. A finalized skill stays active. */
	async function resetAnalysis() {
		errorMessage = '';
		try {
			await requestJson('/api/style-profile/reset', { method: 'POST' });
			run = null;
			attemptedTrials.clear();
			calibrationSessionIds = [];
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not clear the analysis.';
		}
	}


	async function handleSkillUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingSkill = true;
		errorMessage = '';
		try {
			const formData = new FormData();
			formData.append('file', file);
			const response = await fetch('/api/style-profile/import', {
				method: 'POST',
				body: formData
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(messageFromResponse(data, `HTTP ${response.status}`));
			await loadAll();
			step = 'active';
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not upload the skill.';
		} finally {
			uploadingSkill = false;
			input.value = '';
		}
	}

	async function cancelAnalysis() {
		if (!run) return;
		await requestJson(`/api/style-profile/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
	}

	function propositionFor(trial: CalibrationTrial): StyleProposition | undefined {
		return summary?.profile?.propositions.find((proposition) => proposition.id === trial.propositionId);
	}

	function hasMeaningfulNeitherEdit(trial: CalibrationTrial): boolean {
		const edited = neitherEdits[trial.id]?.trim();
		return Boolean(edited && edited !== trial.candidateA?.trim() && edited !== trial.candidateB?.trim());
	}

	/** Trials whose generation has been kicked off, so a failure doesn't retry
	 *  forever. Plain Set: this drives nothing that needs to re-render. */
	const attemptedTrials = new SvelteSet<string>();

	/**
	 * Trials become answerable one at a time and not in list order, so filtering
	 * the source array alone would slot a late arrival above cards you were
	 * already reading. The server stamps generatedAt when it builds a comparison,
	 * so sorting on it fixes each card where it first appeared and appends new
	 * ones below.
	 */
	const readyTrials = $derived(
		pendingTrials
			.filter((trial) => trial.candidateA && trial.candidateB)
			.sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0))
	);
	const unbuiltTrials = $derived(pendingTrials.filter((trial) => !trial.candidateA));
	/** Tried and came back empty. Shown so a failure is not silent. */
	const failedTrials = $derived(unbuiltTrials.filter(
		(trial) => attemptedTrials.has(trial.id) && busyId !== trial.id
	));
	/** More cards are still on the way: the pass itself is running, or a trial is
	 *  building and has not failed. Drives the bouncing cat. */
	const cardsIncoming = $derived(
		analysisRunning || unbuiltTrials.length > failedTrials.length
	);

	// Comparisons build themselves. Asking the writer to press a button per
	// proposition just puts a chore between them and the choice.
	$effect(() => {
		if (!open || step !== 'review' || busyId) return;
		const next = pendingTrials.find(
			(trial) => !trial.candidateA && !attemptedTrials.has(trial.id)
		);
		if (!next) return;
		attemptedTrials.add(next.id);
		void generateComparison(next);
	});

	async function generateComparison(trial: CalibrationTrial) {
		attemptedTrials.add(trial.id);
		busyId = trial.id;
		errorMessage = '';
		try {
			await requestJson(`/api/style-profile/calibrations/${encodeURIComponent(trial.id)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ provider, model })
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not generate the comparison.';
		} finally {
			busyId = null;
		}
	}

	async function answerComparison(trial: CalibrationTrial, choice: CalibrationChoice) {
		busyId = trial.id;
		errorMessage = '';
		try {
			await requestJson(`/api/style-profile/calibrations/${encodeURIComponent(trial.id)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					provider,
					model,
					choice,
					...(choice === 'neither' ? { editedText: neitherEdits[trial.id] ?? '' } : {})
				})
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not save the comparison.';
		} finally {
			busyId = null;
		}
	}

	async function updateProposition(proposition: StyleProposition, status: 'active' | 'disabled') {
		busyId = proposition.id;
		try {
			await requestJson(`/api/style-profile/propositions/${encodeURIComponent(proposition.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status })
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not update the proposition.';
		} finally {
			busyId = null;
		}
	}

	async function finalizeStyle() {
		if (!canFinalize || finalizing) return;
		finalizing = true;
		errorMessage = '';
		try {
			const data = await requestJson('/api/style-profile/finalize', { method: 'POST' });
			await loadAll();
			step = 'active';
			onChanged?.();
			onFinalized?.(data?.profile?.skillId ?? 'author-style');
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not finalize the style.';
		} finally {
			finalizing = false;
		}
	}

	function activityStatusLabel(status: ActivityStatus): string {
		if (status === 'completed') return 'Done';
		if (status === 'running') return 'Working';
		if (status === 'error') return 'Needs attention';
		if (status === 'cancelled') return 'Stopped';
		return 'Waiting';
	}

	function titleCase(value: string): string {
		return value.charAt(0).toUpperCase() + value.slice(1);
	}

	function sourceKindLabel(reference: ReferenceItem): string {
		return reference.format ? `Pasted sample · ${reference.format}` : 'Pasted sample';
	}

	function closeOnBackdrop(event: MouseEvent) {
		if (event.target === event.currentTarget) onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet statusChip(status: ReferenceItem['materializationStatus'])}
	<span class="status-chip {status}"><span class="chip-dot" aria-hidden="true"></span>{titleCase(status)}</span>
{/snippet}

{#if open}
	<div class="backdrop" role="presentation" onclick={closeOnBackdrop} transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="reference-dialog-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				{#if step === 'welcome'}
					<span id="reference-dialog-title">Get started</span>
					<div class="header-actions">
						<button class="icon-btn" onclick={onClose} aria-label="Close"><X size={14} /></button>
					</div>
				{:else}
					<span id="reference-dialog-title">Calibrate your style</span>
					<div class="header-actions">
						<button class="icon-btn" onclick={onClose} aria-label="Close style calibration"><X size={14} /></button>
					</div>
				{/if}
			</div>

			{#if step !== 'welcome'}
				<nav class="steps" aria-label="Reference setup steps">
					<button class:current={step === 'sources'} onclick={() => (step = 'sources')}>
						<span class="step-num">1</span>
						Sources
						{#if references.length > 0}<span class="count-chip">{references.length}</span>{/if}
					</button>
					<button class:current={step === 'review'} onclick={() => (step = 'review')}>
						<span class="step-num">2</span>
						Analyze
						{#if pendingTrials.length > 0}<span class="count-chip">{pendingTrials.length}</span>{/if}
					</button>
					<button class:current={step === 'active'} onclick={() => (step = 'active')}>
						<span class="step-num">3</span>
						{summary?.hasUnpublishedChanges ? 'Style draft' : 'Active skill'}
						{#if activePropositions.length > 0}<span class="count-chip">{activePropositions.length}</span>{/if}
					</button>
				</nav>
			{/if}

			{#if errorMessage}
				<div class="error-box"><TriangleAlert size={13} /><span>{errorMessage}</span></div>
			{/if}

			<div class="dialog-body">
				{#if step === 'welcome'}
					<div class="step step-welcome">
						<div class="welcome-inner">
							<div class="welcome-hero">
								<h2>Learn your writing style</h2>
								<p>Paste a few samples of your writing and DocWriter will build a skill that matches your voice.</p>
							</div>
							<div class="welcome-cards">
								<button class="welcome-card" onclick={() => (step = 'sources')}>
									<span class="welcome-card-icon"><FileStack size={22} /></span>
									<h3>Add writing samples</h3>
									<p>Paste 3–5 passages from your own writing. DocWriter will analyze your style and generate a skill for you.</p>
									<span class="welcome-card-cta">Get started</span>
								</button>
								<div class="welcome-card">
									<span class="welcome-card-icon"><Upload size={22} /></span>
									<h3>Upload a style skill</h3>
									<p>Have a previously generated style skill? Upload the .zip to skip the analysis.</p>
									<label class="btn primary welcome-upload-btn" class:disabled={uploadingSkill}>
										{#if uploadingSkill}<LoaderCircle size={13} class="spinner" />{/if}
										Upload .zip
										<input type="file" accept=".zip" hidden onchange={handleSkillUpload} disabled={uploadingSkill} />
									</label>
								</div>
							</div>
						</div>
					</div>
				{:else if step === 'sources'}
					<!-- A writing surface, not a form: the canvas is the page you are
					     pasting onto, and the rail on the right holds what you have. -->
					<div class="step step-sources">
						<div class="source-canvas">
							{#if previewId}
								{#if previewLoading}
									<div class="empty"><LoaderCircle size={14} class="spinner" /> Reading</div>
								{:else}
									<h2 class="canvas-title">
										{previewReference?.description || previewReference?.label || 'Stored text'}
									</h2>
									<textarea class="canvas-text" bind:value={previewText} aria-label="Stored text"
									></textarea>
									<div class="canvas-foot">
										<span class="hint">Edit anything that came through wrong.</span>
										<button class="btn primary" onclick={savePreview}>Save</button>
									</div>
								{/if}
							{:else}
								<input
									class="canvas-title-input"
									bind:value={sampleDescription}
									placeholder="What is this? e.g. paper introduction"
									aria-label="What this passage is"
								/>
								<textarea
									class="canvas-text"
									bind:value={sampleText}
									onkeydown={onComposerKeydown}
									placeholder="Paste the writing here"
									aria-label="Passage text"
								></textarea>
								<div class="canvas-foot">
									<span class="hint">
										{#if sampleWordCount > 0}
											{sampleWordCount} words
										{:else}
											Navigation text, dates, URLs and HTML are fine to leave in.
										{/if}
									</span>
									<button class="btn primary" disabled={!canAddSample} onclick={addSample}>
										{#if addingSample}<LoaderCircle size={13} class="spinner" />{/if}
										Add source
									</button>
								</div>
							{/if}
						</div>

						<aside class="source-rail">
							<div class="rail-head">
								<span class="eyebrow">Your sources</span>
								{#if previewId}
									<button class="btn ghost" onclick={() => (previewId = null)}>Add source</button>
								{/if}
							</div>
							<div class="rail-list">
								{#if references.length === 0}
									<p class="panel-empty">Nothing added yet. Aim for 3 - 5 samples.</p>
								{:else}
									{#each references as reference (reference.id)}
										<div
											class="source-card"
											class:selected={previewId === reference.id}
											class:busy={busyId === reference.id}
										>
											<button
												class="source-open"
												onclick={() => materialize(reference, reference.materializationStatus === 'ready')}
												disabled={previewLoading}
											>
												<strong>{reference.description || reference.label}</strong>
												<span class="source-meta">{sourceKindLabel(reference)}</span>
												{#if reference.error}<span class="source-error">{reference.error}</span>{/if}
											</button>
											<button
												class="icon-btn"
												onclick={() => removeReference(reference)}
												disabled={busyId === reference.id}
												aria-label={`Remove ${reference.label}`}
											><X size={13} /></button>
										</div>
									{/each}
								{/if}
							</div>
							{#if references.length > 0 && references.length < 3}
								<span class="hint rail-hint">Three to five sources work best. Add {3 - references.length} more.</span>
							{/if}
						</aside>
					</div>
				{:else if step === 'review'}
					<div class="step step-review">
						<aside class="analysis-column">
							<div class="column-head">
								<div class="head-copy">
									<h3>Style analysis</h3>
								</div>
								{#if analysisRunning}
									<button class="btn" onclick={cancelAnalysis}>Cancel</button>
								{:else}
									{#if run}
										<button class="btn" onclick={resetAnalysis}>Start over</button>
									{/if}
									<button class="btn primary" disabled={selectedCount === 0} onclick={startAnalysis}>
										{run ? 'Do another pass' : 'Run analysis'}
									</button>
								{/if}
							</div>
							<p class="column-note">
								Reading your writing and turning it into style guidance. This may take 10+ minutes,
								so feel free to keep writing or do other things in the meantime.
							</p>

							{#if run}
								<div class="progress-summary">
									<div class="progress-top">
										<strong>{Math.round(run.progress)}% complete</strong>
										<span>
											{run.status === 'error' ? 'A step needs attention'
												: run.status === 'cancelled' ? 'Analysis stopped'
												: run.status === 'completed' ? 'Analysis complete'
												: 'Analysis in progress'}
										</span>
									</div>
									<div class="progress-track" aria-label={`Analysis ${Math.round(run.progress)} percent complete`}>
										<div class="progress-fill {run.status}" style:width={`${run.progress}%`}></div>
									</div>
								</div>
								<div class="activity-feed" role="list" aria-label="Analysis progress" aria-live="polite">
									{#each analysisActivities as activity (activity.id)}
										{@const inspectable = activity.icon === 'specialist' || activity.id === 'measurements'}
										<div
											class="activity-row {activity.status}"
											class:inspectable
											class:selected={selectedStep === activity.id}
											role="listitem"
										>
											{#if inspectable}
												<!-- Covers the row so the whole thing is one hit target while the
												     row itself stays a plain listitem. -->
												<button
													class="row-hit"
													aria-label={`${selectedStep === activity.id ? 'Hide' : 'Show'} details for ${activity.title}`}
													aria-pressed={selectedStep === activity.id}
													onclick={() => selectStep(activity.id)}
												></button>
											{/if}
											<span class="activity-icon">
												{#if activity.status === 'completed'}<CheckCircle2 size={15} />
												{:else if activity.status === 'error'}<TriangleAlert size={15} />
												{:else if activity.status === 'running'}<LoaderCircle size={15} class="spinner" />
												{:else if activity.icon === 'sources'}<FileStack size={15} />
												{:else if activity.icon === 'measurements'}<BarChart3 size={15} />
												{:else}<Circle size={15} />{/if}
											</span>
											<div class="activity-copy">
												<div class="activity-top">
													<strong>{activity.title}</strong>
													<span class="activity-status">{activityStatusLabel(activity.status)}</span>
												</div>
												<p>{activity.description}</p>
												{#if inspectable}
													<span class="inspect-hint">
														{selectedStep === activity.id ? 'Hide' : activity.id === 'measurements' ? 'See the measurements' : 'See what it thought'}
													</span>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<div class="empty large-empty analysis-empty">
									<BookOpen size={22} />
									<strong>No analysis has run yet</strong>
									<p>Keep at least one source, then run the analysis. Your choices will appear beside the progress list.</p>
								</div>
							{/if}
						</aside>

						{#if selectedStep}
							{@const step = analysisActivities.find((activity) => activity.id === selectedStep)}
							<section class="trace-column">
								<div class="column-head">
									<div class="head-copy">
										<span class="eyebrow">{selectedStep === 'measurements' ? 'Measurements' : 'Subagent trace'}</span>
										<h3>{step?.title ?? 'Detail'}</h3>
									</div>
									<button class="icon-btn" onclick={() => (selectedStep = null)} aria-label="Close detail">
										<X size={14} />
									</button>
								</div>

								<div class="trace-scroll">
									{#if selectedStep === 'measurements'}
										{#if measurementsLoading}
											<div class="empty"><LoaderCircle size={14} class="spinner" /> Loading measurements</div>
										{:else if measurements.length === 0}
											<div class="empty">No measurements yet.</div>
										{:else}
											<p class="column-note">{measurements.length} metrics</p>
											{#each measurements as measurement (measurement.id)}
												<div class="measurement-row">
													<div class="measurement-main">
														<strong>{measurement.label}</strong>
														<span class="source-meta">{measurement.id}</span>
													</div>
													<span class="measurement-value">
														{Number.isInteger(measurement.value) ? measurement.value : measurement.value.toFixed(2)}
													</span>
												</div>
											{/each}
										{/if}
									{:else}
										{@const trace = specialistTraces[selectedStep] ?? []}
										{@const stepRunning = step?.status === 'running'}
										{#if trace.length === 0 && !stepRunning}
											<div class="empty large-empty">
												<p>Nothing recorded for this step.</p>
											</div>
										{:else}
											<div class="agent-log">
												{#each trace as entry, index (index)}
													{#if entry.kind === 'text'}
														<p class="agent-say">{entry.text}</p>
													{:else if entry.kind === 'thinking'}
														<p class="agent-think">{entry.text}</p>
													{:else if entry.kind === 'prompt'}
														<details class="trace-block">
															<summary>What it was asked</summary>
															<pre>{entry.text}</pre>
														</details>
													{:else if entry.kind === 'result'}
														<p class="agent-rejection">Submission rejected: {entry.text}</p>
													{:else if entry.text}
														<details class="trace-block" open>
															<summary><span class="tool-name">{entry.toolName}</span></summary>
															<pre>{entry.text}</pre>
														</details>
													{:else}
														<span class="tool-name">{entry.toolName}</span>
													{/if}
												{/each}
												<!-- A specialist reads for minutes before it writes anything.
												     Without this the panel looks stuck rather than busy. -->
												{#if stepRunning}
													<div class="trace-working">
														<LoaderCircle size={13} class="spinner" />
														<span>{trace.length === 0 ? 'Reading your sources' : 'Still working'}</span>
													</div>
												{/if}
											</div>
										{/if}
									{/if}
								</div>
							</section>
						{/if}

						<section class="calibration-column">
							<div class="column-head">
								<div class="head-copy">
									<h3>Which piece of writing sounds more like you?</h3>
								</div>
								{#if readyTrials.length > 0}
									<span class="count-chip">{readyTrials.length} left</span>
								{/if}
							</div>

							<div class="calibration-scroll">
								{#if readyTrials.length === 0 && failedTrials.length === 0 && !cardsIncoming}
									<div class="empty large-empty">
										<Check size={22} />
										<p>
											{#if !run}Run the analysis to get some choices.
											{:else if summary?.unresolvedCount}Nothing left for now. Come back later for more.
											{:else}Nothing left to choose.{/if}
										</p>
										{#if canFinalize}
											<button class="btn primary" disabled={finalizing} onclick={finalizeStyle}>
												{#if finalizing}<LoaderCircle size={13} class="spinner" />{/if}
												{summary?.profile?.publishedAt ? 'Update active skill' : 'Finalize style'}
											</button>
										{:else if summary?.profile?.publishedAt && !summary?.hasUnpublishedChanges}
											<span class="hint">The active skill is up to date.</span>
										{/if}
									</div>
								{/if}

								<!-- Only cards you can actually answer. Ones still building show
								     as the bouncing cat at the bottom instead of a row of
								     placeholder spinners. -->
								{#each readyTrials as trial (trial.id)}
									{@const proposition = propositionFor(trial)}
									<div class="calibration-card">
										<div class="proposition-top">
											<span class="family-chip">{proposition?.family.replace(/-/g, ' ')}</span>
										</div>
										<h4>{proposition?.statement}</h4>
										<p class="instruction">{proposition?.instruction}</p>

										{#if trial.candidateA && trial.candidateB}
											<div class="candidate-grid">
												<button class="candidate" disabled={busyId === trial.id} onclick={() => answerComparison(trial, 'a')}>
													<span class="candidate-badge">A</span>
													<span class="candidate-text">{trial.candidateA}</span>
												</button>
												<button class="candidate" disabled={busyId === trial.id} onclick={() => answerComparison(trial, 'b')}>
													<span class="candidate-badge">B</span>
													<span class="candidate-text">{trial.candidateB}</span>
												</button>
											</div>
											<div class="choice-row">
												<button class="btn" onclick={() => answerComparison(trial, 'same')}>Both are the same to me</button>
												<button class="btn" onclick={() => (neitherEdits[trial.id] = neitherEdits[trial.id] ?? trial.candidateA ?? '')}>Neither is good</button>
												<button class="btn ghost" onclick={() => answerComparison(trial, 'skip')}>Skip proposition</button>
											</div>
											{#if neitherEdits[trial.id] !== undefined}
												<div class="edit-answer">
													<label class="field-label" for={`edit-${trial.id}`}>Edit one passage into an acceptable version</label>
													<textarea id={`edit-${trial.id}`} bind:value={neitherEdits[trial.id]}></textarea>
													<button class="btn primary" disabled={!hasMeaningfulNeitherEdit(trial) || busyId === trial.id} onclick={() => answerComparison(trial, 'neither')}>
														Save edited version
													</button>
												</div>
											{/if}
										{/if}
									</div>
								{/each}

								{#each failedTrials as trial (trial.id)}
									{@const proposition = propositionFor(trial)}
									<div class="calibration-card muted">
										<div class="proposition-top">
											<span class="family-chip">{proposition?.family.replace(/-/g, ' ')}</span>
										</div>
										<h4>{proposition?.statement}</h4>
										<div class="comparison-pending">
											<span>Could not build a comparison from your sources.</span>
											<button class="btn" onclick={() => generateComparison(trial)}>Try again</button>
										</div>
									</div>
								{/each}

								{#if cardsIncoming}
									<div class="incoming">
										<!-- The dock's cat, so the agent looks like the same animal
									     everywhere it appears. -->
									<span class="incoming-cat"><Cat size={22} strokeWidth={1.8} /></span>
										<span class="hint">Reading your writing</span>
									</div>
								{/if}
							</div>
						</section>
					</div>
				{:else}
					<!-- The old list mixed everything together under a count that only
					     described part of it, so there was no way to tell what the
					     writing agent actually follows. Two groups, and the boundary
					     between them is the answer. -->
					<div class="step step-active">
						<div class="active-inner">
							{#if summary?.profile?.skillPath || canFinalize}
								<div class="skill-actions">
									{#if summary?.profile?.skillPath}
										<a class="btn" href="/api/style-profile/bundle"><Download size={13} /> Download skill</a>
									{/if}
									{#if canFinalize}
										<button class="btn primary" disabled={finalizing} onclick={finalizeStyle}>
											{#if finalizing}<LoaderCircle size={13} class="spinner" />{/if}
											{summary?.profile?.publishedAt ? 'Update active skill' : 'Finalize style'}
										</button>
									{/if}
								</div>
							{/if}
							{#if summary?.hasUnpublishedChanges && allPropositions.length > 0}
								<p class="column-note">The writing agent will keep using the current skill until you finalize this draft.</p>
							{/if}

							{#if allPropositions.length === 0}
								<div class="empty large-empty">
									<Sparkles size={22} />
									<strong>No guidance yet</strong>
									<p>Analyze your references to create style guidance.</p>
								</div>
							{:else}
								{#if activePropositions.length === 0}
									<p class="panel-empty">Nothing yet. Answer the picks on the Analyze tab to keep some.</p>
								{:else}
									<div class="proposition-list">
										{#each activePropositions as proposition (proposition.id)}
											<div class="proposition-card">
												<div class="proposition-top">
													<span class="family-chip">{proposition.family.replace(/-/g, ' ')}</span>
												</div>
												<h4>{proposition.statement}</h4>
												<p class="instruction">{proposition.instruction}</p>
												<!-- The passages do more work than the rule: this is what the
												     agent is actually imitating, so it is what you should see. -->
												{#if proposition.examples.length > 0}
													<ul class="example-list">
														{#each proposition.examples.slice(0, 3) as example (example)}
															<li>{example}</li>
														{/each}
													</ul>
												{/if}
												<div class="proposition-actions">
													<button class="btn" disabled={busyId === proposition.id} onclick={() => updateProposition(proposition, 'disabled')}>Remove</button>
												</div>
											</div>
										{/each}
									</div>
								{/if}

								{#if inactivePropositions.length > 0}
									<div class="group-head">
										<h4>Not in the skill</h4>
										<span class="hint">{inactivePropositions.length}</span>
									</div>
									<div class="proposition-list">
										{#each inactivePropositions as proposition (proposition.id)}
											<div class="proposition-card muted">
												<div class="proposition-top">
													<span class="family-chip">{proposition.family.replace(/-/g, ' ')}</span>
													<span class="status-chip {proposition.status}"
														><span class="chip-dot" aria-hidden="true"></span>{inactiveReason(proposition.status)}</span
													>
												</div>
												<h4>{proposition.statement}</h4>
												<div class="proposition-actions">
													<button class="btn" disabled={busyId === proposition.id} onclick={() => updateProposition(proposition, 'active')}>Use it</button>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{/if}
			</div>

		</div>
	</div>
{/if}

<style>
	/* ---- shell -------------------------------------------------------- */
	/* Matches the app's Dialog / ReviewerEditorDialog shell: same backdrop
	 * weight, same elevated surface, same radius and shadow. Only the size
	 * differs — this one is a workspace, not a confirm box. */
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
		width: min(1320px, calc(100vw - 24px));
		height: min(880px, calc(100vh - 24px));
		overflow: hidden;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-elevated);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		color: var(--text);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	/* Title and tabs form one header block with a single rule beneath it —
	 * a bordered title bar stacked on a bordered tab bar read as two stripes. */
	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 22px 20px 0 28px;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}
	.dialog-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.step {
		height: 100%;
	}

	/* ---- step tabs ---------------------------------------------------- */
	.steps {
		display: flex;
		gap: 10px;
		margin-top: 16px;
		padding: 0 24px;
		border-bottom: 1px solid var(--border-light);
	}
	.steps button {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 10px 4px 11px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		font-size: 13.5px;
		cursor: pointer;
	}
	.steps button:hover {
		color: var(--text-secondary);
	}
	.steps button.current {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	/* ---- shared primitives -------------------------------------------- */
	h3,
	h4,
	p {
		margin: 0;
	}
	h3 {
		font-size: 14px;
		font-weight: 600;
	}
	h4 {
		font-size: 13px;
		font-weight: 600;
		line-height: 1.45;
	}
	.eyebrow {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.column-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.head-copy {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.column-note {
		margin-top: 8px;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-muted);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field-label {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.optional {
		font-weight: 400;
		letter-spacing: 0.02em;
		text-transform: none;
	}
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 72px;
		padding: 7px 10px;
		border: 1px solid var(--border-light);
		border-radius: 7px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 13px;
		line-height: 1.55;
		resize: vertical;
	}
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}

	/* Buttons follow ReviewerEditorDialog: same padding, radius and weight. */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 6px 12px;
		border: 1px solid var(--border-light);
		border-radius: 7px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
	}
	.btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.btn.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: #fff;
	}
	.btn.primary:hover {
		filter: brightness(0.94);
		color: #fff;
	}
	.btn.ghost {
		border-color: transparent;
		background: transparent;
		color: var(--text-faint);
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.btn:disabled:hover {
		background: var(--bg-elevated);
		color: var(--text-secondary);
		filter: none;
	}
	.btn.primary:disabled:hover {
		background: var(--accent);
		color: #fff;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 5px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.icon-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* Same shape as the agent log in HistoryPane: raw tool name, input revealed
	 * on demand. No invented prose for calls the SDK already names. */
	.agent-log {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 10px 0 14px;
		font-size: 11.5px;
	}

	.agent-say {
		color: var(--text-secondary);
		line-height: 1.5;
	}
	.agent-think {
		color: var(--text-faint);
		font-style: italic;
		line-height: 1.5;
	}
	.tool-name {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 11px;
		color: var(--tool-accent);
	}
	.tool-detail {
		margin: 2px 0 4px;
		padding: 7px 9px;
		border: 1px solid var(--tool-border);
		border-radius: 6px;
		background: var(--tool-bg);
		color: var(--text-muted);
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 10.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* The tab order is the workflow, so each carries its position. */
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 17px;
		height: 17px;
		border: 1px solid var(--border-light);
		border-radius: 50%;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-faint);
	}
	.steps button.current .step-num {
		border-color: var(--accent);
		color: var(--accent);
	}
	.count-chip {
		flex: none;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--bg-hover);
		color: var(--text-faint);
		font-size: 10.5px;
		font-weight: 600;
	}
	.family-chip {
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--bg-hover);
		color: var(--text-muted);
		font-size: 10.5px;
		text-transform: capitalize;
	}
	/* Status is a dot + word, so it reads at a glance without relying on a
	 * hue the theme may not have contrast for. */
	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.chip-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.status-chip.ready .chip-dot,
	.status-chip.active .chip-dot,
	.status-chip.confirmed .chip-dot {
		background: var(--diff-added-color);
	}
	.status-chip.stale .chip-dot,
	.status-chip.pending .chip-dot {
		background: var(--feedback-border);
	}
	.status-chip.error .chip-dot {
		background: var(--diff-removed-color);
	}

	.error-box {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 10px 16px 0;
		padding: 8px 11px;
		border: 1px solid color-mix(in srgb, var(--diff-removed-color) 32%, var(--border-light));
		border-radius: 7px;
		background: color-mix(in srgb, var(--diff-removed-color) 8%, var(--bg-elevated));
		color: var(--diff-removed-color);
		font-size: 12px;
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		padding: 20px;
		color: var(--text-faint);
		font-size: 12.5px;
	}
	.large-empty {
		flex-direction: column;
		gap: 9px;
		min-height: 180px;
		padding: 32px 24px;
		text-align: center;
	}
	.large-empty strong {
		color: var(--text-secondary);
		font-size: 13px;
	}
	.large-empty p {
		max-width: 320px;
		font-size: 12px;
		line-height: 1.55;
	}

	/* ---- welcome step ------------------------------------------------- */
	.step-welcome {
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: auto;
	}
	.welcome-inner {
		max-width: 640px;
		padding: 40px 24px 48px;
		text-align: center;
	}
	.welcome-hero {
		margin-bottom: 32px;
	}
	.welcome-hero h2 {
		margin: 0 0 8px;
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.015em;
		color: var(--text);
	}
	.welcome-hero p {
		margin: 0 auto;
		max-width: 420px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-muted);
	}
	.welcome-cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}
	.welcome-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding: 24px 22px;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-surface);
		text-align: left;
		font: inherit;
		color: inherit;
		cursor: pointer;
		transition: border-color 0.12s;
	}
	button.welcome-card:hover {
		border-color: var(--accent);
		background: var(--bg-hover);
	}
	.welcome-card h3 {
		margin: 4px 0 0;
		font-size: 14px;
		font-weight: 600;
	}
	.welcome-card p {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-muted);
	}
	.welcome-card-icon {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 9px;
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
	.welcome-card-cta {
		margin-top: auto;
		padding-top: 4px;
		color: var(--accent);
		font-size: 13px;
		font-weight: 500;
	}
	.welcome-upload-btn {
		margin-top: auto;
		cursor: pointer;
	}
	.welcome-upload-btn.disabled {
		opacity: 0.45;
		cursor: default;
	}
	.upload-file-btn {
		cursor: pointer;
	}
	.upload-file-btn.disabled {
		opacity: 0.45;
		cursor: default;
	}
	@media (max-width: 580px) {
		.welcome-cards {
			grid-template-columns: 1fr;
		}
	}

	/* ---- step 1: sources ---------------------------------------------- */
	/* The canvas is the page you paste onto — a document surface with a big
	 * titled heading, not a boxed form. The rail on the right holds the
	 * sources you already added and the button that starts the analysis. */
	.step-sources {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		height: 100%;
		overflow: hidden;
	}
	.source-canvas {
		display: flex;
		box-sizing: border-box;
		width: 100%;
		max-width: 860px;
		height: 100%;
		min-height: 0;
		margin: 0 auto;
		flex-direction: column;
		padding: 30px 44px 20px;
	}
	.canvas-title-input,
	.canvas-title {
		box-sizing: border-box;
		width: 100%;
		margin: 0;
		padding: 4px 0 14px;
		border: none;
		border-bottom: 1px solid var(--border-light);
		border-radius: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 23px;
		font-weight: 700;
		letter-spacing: -0.015em;
		line-height: 1.25;
	}
	.canvas-title-input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.canvas-text {
		flex: 1 1 auto;
		min-height: 0;
		padding: 18px 0;
		border: none;
		border-radius: 0;
		background: transparent;
		font-size: 13.5px;
		line-height: 1.6;
		resize: none;
	}
	.canvas-text:focus {
		outline: none;
	}
	.canvas-foot {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-top: 10px;
	}

	.source-rail {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 12px;
		padding: 20px 16px 16px;
		border-left: 1px solid var(--border-light);
		background: var(--bg-surface);
	}
	.rail-head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 26px;
	}
	.rail-list {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		flex-direction: column;
		gap: 8px;
		overflow-y: auto;
	}
	.source-card {
		display: flex;
		flex: none;
		align-items: flex-start;
		gap: 6px;
		padding: 10px 8px 10px 12px;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg);
	}
	.source-card:hover {
		border-color: var(--border);
	}
	.source-card.selected {
		border-color: var(--accent);
	}
	.source-card.busy {
		opacity: 0.6;
	}
	/* The whole card body opens the source; the × beside it removes it. */
	.source-open {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.source-open strong {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: 12.5px;
		font-weight: 600;
		line-height: 1.35;
	}
	.rail-hint {
		flex: none;
		text-align: center;
	}

	.panel-empty {
		padding: 28px 12px;
		color: var(--text-faint);
		font-size: 12.5px;
		text-align: center;
	}
	.source-meta {
		font-size: 11px;
		color: var(--text-faint);
	}
	.source-error {
		font-size: 11px;
		color: var(--diff-removed-color);
	}
	.source-controls {
		display: flex;
		flex: none;
		align-items: center;
		gap: 10px;
	}

	.hint {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	/* ---- step 2: analyze and review ----------------------------------- */
	/* Passes on the left, the selected pass's trace in the middle, your choices
	 * on the right. The middle column only exists while a pass is selected. */
	.step-review {
		display: grid;
		grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
		height: 100%;
		overflow: hidden;
	}
	.step-review:has(.trace-column) {
		grid-template-columns: minmax(260px, 320px) minmax(320px, 1fr) minmax(340px, 1.1fr);
	}
	.trace-column {
		display: flex;
		min-width: 0;
		min-height: 0;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		padding: 16px 18px 0;
		border-right: 1px solid var(--border-light);
	}
	.trace-scroll {
		flex: 1;
		min-height: 0;
		margin-top: 12px;
		padding-bottom: 16px;
		overflow: auto;
	}
	.measurement-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 0;
		border-bottom: 1px solid var(--border-light);
	}
	.measurement-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 1px;
	}
	.measurement-main strong {
		font-size: 12px;
		font-weight: 500;
	}
	.measurement-value {
		flex: none;
		color: var(--text);
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.inspect-hint {
		display: inline-block;
		margin-top: 4px;
		color: var(--accent);
		font-size: 11px;
	}
	.activity-row.inspectable {
		position: relative;
		margin: 0 -8px;
		padding: 11px 8px;
		border-radius: 7px;
	}
	.row-hit {
		position: absolute;
		inset: 0;
		z-index: 1;
		border: 0;
		border-radius: 7px;
		background: transparent;
		cursor: pointer;
	}
	.row-hit:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.activity-row.inspectable:hover {
		background: var(--bg-hover);
	}
	.activity-row.selected {
		background: var(--accent-bg);
	}
	.analysis-column {
		display: flex;
		min-height: 0;
		height: 100%;
		flex-direction: column;
		padding: 16px 18px;
		overflow: auto;
		border-right: 1px solid var(--border-light);
		background: var(--bg-surface);
	}
	.progress-summary {
		margin-top: 16px;
	}
	.progress-top {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 7px;
		font-size: 11.5px;
	}
	.progress-top span {
		color: var(--text-faint);
	}
	.progress-track {
		width: 100%;
		height: 5px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--bg-hover);
	}
	.progress-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.25s ease;
	}
	.progress-fill.error {
		background: var(--diff-removed-color);
	}
	.progress-fill.completed {
		background: var(--diff-added-color);
	}

	/* Flat rows on a shared surface — the old version nested a shadowed card
	 * inside a shadowed panel inside the dialog, which read as visual noise. */
	.activity-feed {
		display: flex;
		flex-direction: column;
		margin-top: 6px;
	}
	.activity-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 0;
		border-bottom: 1px solid var(--border-light);
	}
	.activity-row:last-child {
		border-bottom: 0;
	}
	.activity-icon {
		flex: none;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 7px;
		background: var(--bg-hover);
		color: var(--text-faint);
	}
	.activity-row.completed .activity-icon {
		color: var(--diff-added-color);
	}
	.activity-row.running .activity-icon {
		color: var(--accent);
	}
	.activity-row.error .activity-icon {
		color: var(--diff-removed-color);
	}
	.activity-row.pending {
		opacity: 0.65;
	}
	.activity-copy {
		min-width: 0;
		flex: 1;
	}
	.activity-top {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}
	.activity-top strong {
		font-size: 12.5px;
		font-weight: 600;
	}
	.activity-status {
		flex: none;
		font-size: 11px;
		color: var(--text-faint);
	}
	.activity-row.error .activity-status {
		color: var(--diff-removed-color);
	}
	.activity-copy p {
		margin-top: 3px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text-faint);
	}
	.analysis-empty {
		margin-top: 16px;
	}

	.calibration-column {
		display: flex;
		min-width: 0;
		/* Same trap as the picks column: without min-height the flex child grows
		 * past the grid row and .calibration-scroll never gets the overflow. */
		min-height: 0;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		padding: 16px 18px 0;
	}
	.calibration-scroll {
		flex: 1;
		min-height: 0;
		margin-top: 14px;
		padding-bottom: 16px;
		overflow: auto;
	}
	.calibration-card {
		padding: 16px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-surface);
	}
	.calibration-card.muted {
		opacity: 0.6;
	}
	.calibration-card + .calibration-card {
		margin-top: 12px;
	}
	.proposition-top {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.instruction {
		margin: 6px 0 12px;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-muted);
	}
	.candidate-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.candidate {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px;
		align-items: start;
		padding: 12px 14px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.candidate:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--bg-hover);
	}
	.candidate:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.candidate-badge {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--bg-hover);
		color: var(--text-faint);
		font-size: 10.5px;
		font-weight: 600;
	}
	.candidate:hover:not(:disabled) .candidate-badge {
		background: var(--accent);
		color: #fff;
	}
	.candidate-text {
		font-size: 12.5px;
		line-height: 1.55;
	}
	.comparison-pending {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-faint);
		font-size: 12px;
	}
	.choice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
		margin-top: 10px;
	}
	.edit-answer {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 7px;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border-light);
	}
	.edit-answer textarea {
		min-height: 96px;
	}

	/* ---- step 3: active skill ----------------------------------------- */
	.step-active {
		overflow: auto;
	}
	/* Instructions are one or two sentences — a reading measure keeps the
	 * editor from stretching to 1300px of empty box. */
	.active-inner {
		max-width: 880px;
		margin: 0 auto;
		padding: 18px 18px 24px;
	}
	.skill-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	/* Prompt and tool-input transcripts: monospace, boxed, own scrollbar. */
	.trace-block {
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-surface);
	}
	.trace-block summary {
		padding: 7px 10px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		user-select: none;
	}
	.trace-block pre {
		max-height: 340px;
		margin: 0;
		padding: 10px 12px;
		border-top: 1px solid var(--border-light);
		overflow: auto;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 11.5px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.agent-rejection {
		padding: 7px 10px;
		border: 1px solid color-mix(in srgb, var(--diff-removed-color) 32%, var(--border-light));
		border-radius: 8px;
		background: color-mix(in srgb, var(--diff-removed-color) 8%, var(--bg-elevated));
		color: var(--diff-removed-color);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.trace-working {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 10px 0 4px;
		color: var(--text-faint);
		font-size: 12.5px;
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.proposition-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 10px;
	}
	/* The line between "the agent follows these" and everything else is the
	 * whole point of the tab, so it gets a rule rather than a heading alone. */
	/* Bounces while cards are still arriving, stops when the passes finish. */
	.incoming {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		padding: 22px 12px;
		color: var(--text-faint);
	}
	.incoming-cat {
		display: inline-flex;
		animation: cat-bounce 1s ease-in-out infinite;
	}
	@keyframes cat-bounce {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.incoming-cat {
			animation: none;
		}
	}
	.group-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-top: 26px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border-light);
	}
	.group-head:first-of-type {
		margin-top: 18px;
	}
	.group-head h4 {
		font-size: 13px;
		font-weight: 600;
	}
	.proposition-card {
		padding: 14px 16px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-surface);
	}
	.proposition-card.muted {
		opacity: 0.6;
	}
	/* Quoted from the author, so it reads as quotation rather than as UI. */
	.example-list {
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
	}
	.example-list li {
		padding: 3px 0 3px 11px;
		border-left: 2px solid var(--border-light);
		color: var(--text-secondary);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.example-list li + li {
		margin-top: 6px;
	}
	.proposition-actions {
		display: flex;
		justify-content: flex-end;
		gap: 7px;
		margin-top: 9px;
	}

	:global(.spinner) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 1080px) {
		.step-sources,
		.step-review {
			grid-template-columns: 1fr;
			overflow: auto;
		}
		/* Too narrow for a sidebar: the canvas stacks above the rail. */
		.source-canvas {
			height: auto;
			min-height: 320px;
		}
		.source-rail {
			border-left: 0;
			border-top: 1px solid var(--border-light);
		}
		.analysis-column {
			border-right: 0;
			border-bottom: 1px solid var(--border-light);
			overflow: visible;
		}
		.calibration-scroll {
			overflow: visible;
		}
	}
	@media (max-width: 780px) {
		.backdrop {
			padding: 0;
		}
		.dialog {
			width: 100vw;
			height: 100vh;
			border: 0;
			border-radius: 0;
		}
		.candidate-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.spinner) {
			animation: none;
		}
		.mascot-face,
		.mascot-face.running,
		.bounce-dots span {
			animation: none;
		}
		.progress-fill {
			transition: none;
		}
	}
</style>
