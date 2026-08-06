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
		ExternalLink,
		FileStack,
		FileText,
		Link2,
		LoaderCircle,
		Paperclip,
		Plus,
		RefreshCw,
		Sparkles,
		Trash2,
		TriangleAlert,
		X
	} from 'lucide-svelte';
	import type {
		CalibrationChoice,
		CalibrationTrial,
		SpecialistRunState,
		StyleAnalysisRun,
		StyleProfileSummary,
		StyleProposition,
		StyleReferenceRole
	} from '$lib/style-profile';

	type ReferenceType = 'workspace-file' | 'stored-sample' | 'url';
	interface ReferenceItem {
		id: string;
		label: string;
		type: ReferenceType;
		target: string;
		role: StyleReferenceRole;
		format?: string;
		contentHash?: string;
		materializationStatus: 'pending' | 'ready' | 'stale' | 'error';
		extractedAt?: number;
		error?: string;
		selected?: boolean;
	}

	type ActivityStatus = SpecialistRunState['status'];
	interface AnalysisActivity {
		id: string;
		title: string;
		description: string;
		status: ActivityStatus;
		icon: 'sources' | 'measurements' | 'specialist' | 'skill';
	}

	interface Props {
		open: boolean;
		provider: string;
		model?: string;
		onClose: () => void;
		onChanged?: () => void;
	}

	let { open, provider, model, onClose, onChanged }: Props = $props();
	let step = $state<'sources' | 'review' | 'active'>('sources');
	let references = $state<ReferenceItem[]>([]);
	let summary = $state<StyleProfileSummary | null>(null);
	let loading = $state(false);
	let errorMessage = $state('');
	let composerText = $state('');
	let pendingFiles = $state<File[]>([]);
	let dragActive = $state(false);
	let submitting = $state(false);
	/** A chronological transcript. Text and thinking stream as deltas, so an
	 *  in-flight entry is updated in place until a tool call closes it. */
	type AgentLogEntry =
		| { kind: 'text'; text: string }
		| { kind: 'thinking'; text: string }
		| { kind: 'tool'; toolName: string; input: Record<string, unknown> };
	let agentLog = $state<AgentLogEntry[]>([]);
	let logEl = $state<HTMLDivElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let previewId = $state<string | null>(null);
	let previewText = $state('');
	let previewLoading = $state(false);
	let run = $state<StyleAnalysisRun | null>(null);
	/** Working traces per specialist, accumulated from the run's SSE stream. */
	type TraceEntry = { kind: 'text' | 'thinking' | 'tool'; text?: string; toolName?: string };
	let specialistTraces = $state<Record<string, TraceEntry[]>>({});
	let selectedStep = $state<string | null>(null);
	let measurements = $state<Array<{ id: string; family: string; label: string; value: number; count: number; sourceCount: number }>>([]);
	let measurementsLoading = $state(false);
	let eventSource: EventSource | null = null;
	let busyId = $state<string | null>(null);
	let neitherEdits = $state<Record<string, string>>({});
	let propositionEdits = $state<Record<string, string>>({});
	let calibrationSessionIds = $state<string[]>([]);

	const pendingTrials = $derived((summary?.profile?.calibrations ?? [])
		.filter((trial) => calibrationSessionIds.includes(trial.id) && ['pending', 'generated', 'error'].includes(trial.status)));
	const activePropositions = $derived((summary?.profile?.propositions ?? [])
		.filter((proposition) => ['active', 'confirmed'].includes(proposition.status)));
	const allPropositions = $derived(summary?.profile?.propositions ?? []);
	const analysisRunning = $derived(Boolean(run && ['queued', 'running'].includes(run.status)));

	const analysisActivities = $derived.by((): AnalysisActivity[] => {
		const currentRun = run;
		if (!currentRun) return [];
		const terminal = ['completed', 'error', 'cancelled'].includes(currentRun.status);
		const thresholdStatus = (completeAt: number, startAt: number): ActivityStatus => {
			if (currentRun.progress >= completeAt) return 'completed';
			if (currentRun.status === 'error' && currentRun.progress >= startAt) return 'error';
			if (currentRun.status === 'cancelled' && currentRun.progress >= startAt) return 'cancelled';
			return currentRun.progress >= startAt || ['queued', 'running'].includes(currentRun.status) ? 'running' : 'pending';
		};
		const items: AnalysisActivity[] = [{
			id: 'sources',
			title: 'Sources prepared',
			description: `Reading and normalizing ${selectedCount} kept source${selectedCount === 1 ? '' : 's'}.`,
			status: thresholdStatus(20, 0),
			icon: 'sources'
		}];
		if (currentRun.progress >= 12 || terminal) {
			items.push({
				id: 'measurements',
				title: 'Measurements computed',
				description: 'Measuring structure, rhythm, voice, punctuation, citations, and formatting.',
				status: thresholdStatus(35, 12),
				icon: 'measurements'
			});
		}

		const specialistCopy: Record<SpecialistRunState['id'], { title: string; description: string }> = {
			organization: {
				title: 'Organization specialist',
				description: 'Reviewing document, section, paragraph, and formatting measurements.'
			},
			language: {
				title: 'Language specialist',
				description: 'Reviewing sentences, voice, vocabulary, and punctuation.'
			},
			discourse: {
				title: 'Discourse specialist',
				description: 'Reviewing rhetoric, evidence, citations, and context.'
			},
			synthesis: {
				title: 'Guidance combined',
				description: 'Combining grounded propositions and removing duplicates.'
			}
		};
		for (const specialist of currentRun.specialists.filter((item) => item.id !== 'synthesis')) {
			if (currentRun.progress >= 35 || specialist.status !== 'pending' || terminal) {
				items.push({
					id: specialist.id,
					...specialistCopy[specialist.id],
					status: specialist.status,
					icon: 'specialist'
				});
			}
		}
		const synthesis = currentRun.specialists.find((specialist) => specialist.id === 'synthesis');
		if (synthesis && (currentRun.progress >= 70 || synthesis.status !== 'pending' || terminal)) {
			items.push({ id: synthesis.id, ...specialistCopy.synthesis, status: synthesis.status, icon: 'specialist' });
		}
		if (currentRun.progress >= 88 || terminal) {
			items.push({
				id: 'skill',
				title: 'Author skill updated',
				description: 'Saving active guidance for the writing agent.',
				status: currentRun.status === 'completed' ? 'completed' : currentRun.status === 'error' ? 'error' : currentRun.status === 'cancelled' ? 'cancelled' : 'running',
				icon: 'skill'
			});
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

	$effect(() => {
		if (open) {
			calibrationSessionIds = [];
			void loadAll();
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

	const canSubmitContext = $derived(
		!submitting && (composerText.trim().length > 0 || pendingFiles.length > 0)
	);
	/** A style is learned from a handful of pieces; more just averages it out. */
	const IDEAL_SOURCES = { min: 3, max: 5 };
	const selectedCount = $derived(references.filter((item) => item.selected === true).length);

	async function setSelected(reference: ReferenceItem, selected: boolean) {
		busyId = reference.id;
		// Reflect the choice straight away; the reload confirms it.
		references = references.map((item) =>
			item.id === reference.id ? { ...item, selected } : item
		);
		try {
			await requestJson(`/api/references/${encodeURIComponent(reference.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ selected })
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not update the source.';
			await loadAll();
		} finally {
			busyId = null;
		}
	}

	/** Everything the user hands over in one go — text, links, files. An agent on
	 *  the selected provider sorts it into sources, which stream back and appear
	 *  in the list as they are created. */
	async function submitContext() {
		if (!canSubmitContext) return;
		submitting = true;
		errorMessage = '';
		agentLog = [];
		// Index of the entry currently being streamed into, per kind. A tool call
		// ends the current message, so the next delta starts a new entry.
		let openText = -1;
		let openThinking = -1;
		try {
			const form = new FormData();
			form.set('note', composerText);
			form.set('provider', provider);
			if (model) form.set('model', model);
			for (const file of pendingFiles) form.append('files', file);

			const response = await fetch('/api/references/ingest', { method: 'POST', body: form });
			if (!response.ok || !response.body) {
				const data = await response.json().catch(() => ({}));
				throw new Error(messageFromResponse(data, `HTTP ${response.status}`));
			}
			composerText = '';
			pendingFiles = [];

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const chunks = buffer.split('\n\n');
				buffer = chunks.pop() ?? '';
				for (const chunk of chunks) {
					let name = '';
					let payload = '';
					for (const line of chunk.split('\n')) {
						if (line.startsWith('event: ')) name = line.slice(7);
						else if (line.startsWith('data: ')) payload = line.slice(6);
					}
					if (!name || !payload) continue;
					const data = JSON.parse(payload);
					if (name === 'source' && data.reference) {
						// Append as it lands rather than waiting for the run to finish.
						references = [
							data.reference,
							...references.filter((item) => item.id !== data.reference.id)
						];
					} else if (name === 'status' && data.text) {
						if (openText >= 0) agentLog[openText] = { kind: 'text', text: data.text };
						else openText = agentLog.push({ kind: 'text', text: data.text }) - 1;
					} else if (name === 'thinking' && data.text) {
						if (openThinking >= 0) agentLog[openThinking] = { kind: 'thinking', text: data.text };
						else openThinking = agentLog.push({ kind: 'thinking', text: data.text }) - 1;
					} else if (name === 'tool' && data.tool_name) {
						agentLog.push({ kind: 'tool', toolName: data.tool_name, input: data.input ?? {} });
						openText = -1;
						openThinking = -1;
					} else if (name === 'error' && data.message) {
						errorMessage = data.message;
					}
				}
			}
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not add that context.';
		} finally {
			submitting = false;
			// The log stays up after the run so the writer can see what the agent
			// actually looked at; the next submission clears it.
		}
	}

	// Follow the run as it streams, but stop fighting the user the moment they
	// scroll up to read something.
	$effect(() => {
		agentLog.length;
		if (!submitting || !logEl) return;
		const distanceFromBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
		if (distanceFromBottom < 120) logEl.scrollTop = logEl.scrollHeight;
	});

	function formatToolInput(input: Record<string, unknown>): string {
		return Object.entries(input)
			.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
			.join('\n');
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragActive = false;
		pendingFiles = [...pendingFiles, ...Array.from(event.dataTransfer?.files ?? [])];
	}

	function onFilePicked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		pendingFiles = [...pendingFiles, ...Array.from(input.files ?? [])];
		input.value = '';
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void submitContext();
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

	/** Throw away every learned proposition so the next run starts clean. */
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

	function isPropositionDirty(proposition: StyleProposition): boolean {
		const edited = propositionEdits[proposition.id];
		return edited !== undefined && edited.trim() !== proposition.instruction.trim();
	}

	/** Trials whose generation has been kicked off, so a failure doesn't retry
	 *  forever. Plain Set: this drives nothing that needs to re-render. */
	const attemptedTrials = new SvelteSet<string>();

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

	async function updateProposition(proposition: StyleProposition, status?: 'active' | 'confirmed' | 'disabled') {
		busyId = proposition.id;
		try {
			await requestJson(`/api/style-profile/propositions/${encodeURIComponent(proposition.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					instruction: propositionEdits[proposition.id] || proposition.instruction,
					...(status ? { status } : {})
				})
			});
			await loadAll();
			onChanged?.();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : 'Could not update the proposition.';
		} finally {
			busyId = null;
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
		const kind = reference.type === 'workspace-file' ? 'Workspace file'
			: reference.type === 'stored-sample' ? 'Pasted sample'
			: 'Link';
		return reference.format ? `${kind} · ${reference.format}` : kind;
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
				<span id="reference-dialog-title">Writing references</span>
				<button class="icon-btn" onclick={onClose} aria-label="Close writing references"><X size={14} /></button>
			</div>

			<nav class="steps" aria-label="Reference setup steps">
				<button class:current={step === 'sources'} onclick={() => (step = 'sources')}>
					Sources
					{#if references.length > 0}<span class="count-chip">{references.length}</span>{/if}
				</button>
				<button class:current={step === 'review'} onclick={() => (step = 'review')}>
					Analyze
					{#if pendingTrials.length > 0}<span class="count-chip">{pendingTrials.length}</span>{/if}
				</button>
				<button class:current={step === 'active'} onclick={() => (step = 'active')}>
					Active skill
					{#if activePropositions.length > 0}<span class="count-chip">{activePropositions.length}</span>{/if}
				</button>
			</nav>

			{#if errorMessage}
				<div class="error-box"><TriangleAlert size={13} /><span>{errorMessage}</span></div>
			{/if}

			<div class="dialog-body">
				{#if step === 'sources'}
					<div class="step step-sources">
						<section
							class="source-column"
							class:centered={references.length === 0 && agentLog.length === 0 && !loading}
						>
							<div
								class="composer"
								class:drag-active={dragActive}
								role="presentation"
								ondragover={(event) => { event.preventDefault(); dragActive = true; }}
								ondragleave={() => (dragActive = false)}
								ondrop={onDrop}
							>
								<input
									class="file-input"
									type="file"
									multiple
									bind:this={fileInput}
									onchange={onFilePicked}
									tabindex="-1"
									aria-hidden="true"
								/>
								<textarea
									class="composer-text"
									bind:value={composerText}
									onkeydown={onComposerKeydown}
									placeholder="Paste writing, drop files, or add links…"
									aria-label="Context to learn your style from"
								></textarea>
								{#if pendingFiles.length > 0}
									<div class="attachments">
										{#each pendingFiles as file, index (`${file.name}-${index}`)}
											<span class="attachment">
												<Paperclip size={11} />
												{file.name}
												<button
													class="attachment-remove"
													aria-label={`Remove ${file.name}`}
													onclick={() => (pendingFiles = pendingFiles.filter((_, i) => i !== index))}
												><X size={10} /></button>
											</span>
										{/each}
									</div>
								{/if}
								<div class="composer-actions">
									<button class="icon-btn" onclick={() => fileInput?.click()} aria-label="Attach files">
										<Paperclip size={15} />
									</button>
									<button class="btn primary" disabled={!canSubmitContext} onclick={submitContext}>
										{#if submitting}<LoaderCircle size={13} class="spinner" />{/if}
										Submit context
									</button>
								</div>
							</div>

							<div class="source-scroll" bind:this={logEl}>
								{#if agentLog.length > 0}
									<div class="agent-log" aria-live="polite">
										<div class="log-head">
											<span class="mascot-face" class:running={submitting} aria-hidden="true">
												<Cat size={15} strokeWidth={1.8} />
											</span>
											{#if submitting}
												<span class="bounce-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
											{/if}
										</div>
										{#each agentLog as entry, index (index)}
											{#if entry.kind === 'text'}
												<p class="agent-say">{entry.text}</p>
											{:else if entry.kind === 'thinking'}
												<p class="agent-think">{entry.text}</p>
											{:else}
												<details class="tool-call">
													<summary><span class="tool-name">{entry.toolName}</span></summary>
													<pre class="tool-detail">{formatToolInput(entry.input)}</pre>
												</details>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						</section>

						<aside class="picks-column">
							<div class="picks-head">
								<span class="eyebrow">Sources</span>
								{#if references.length > 0}
									<span
										class="picks-count"
										class:good={selectedCount >= IDEAL_SOURCES.min && selectedCount <= IDEAL_SOURCES.max}
										class:over={selectedCount > IDEAL_SOURCES.max}
									>{selectedCount} kept</span>
								{/if}
							</div>
							<p class="picks-hint">
								{#if references.length === 0}
									Anything the agent finds shows up here to keep or drop.
								{:else if selectedCount > IDEAL_SOURCES.max}
									That's a lot — drop to {IDEAL_SOURCES.max} or fewer so your voice stays sharp.
								{:else if selectedCount < IDEAL_SOURCES.min}
									Keep {IDEAL_SOURCES.min}–{IDEAL_SOURCES.max} pieces that sound most like you.
								{:else}
									Good range. Only kept sources shape the style.
								{/if}
							</p>

							<div class="picks-scroll">
								{#if loading && references.length === 0}
									<div class="empty"><LoaderCircle size={14} class="spinner" /> Loading</div>
								{:else}
									{#each references as reference (reference.id)}
										{@const kept = reference.selected === true}
										<div class="pick-row" class:busy={busyId === reference.id} class:kept>
											<button
												class="keep-box"
												class:on={kept}
												onclick={() => setSelected(reference, !kept)}
												disabled={busyId === reference.id}
												aria-pressed={kept}
												aria-label={kept ? `Drop ${reference.label}` : `Keep ${reference.label}`}
											>{#if kept}<Check size={11} strokeWidth={3.2} />{/if}</button>
											<div class="source-main">
												<strong>{reference.label}</strong>
												<span class="source-meta">
													{sourceKindLabel(reference)} · {titleCase(reference.materializationStatus)}
												</span>
												{#if reference.error}<span class="source-error">{reference.error}</span>{/if}
											</div>
											<div class="source-controls">
												<button
													class="icon-btn"
													onclick={() => materialize(reference, reference.materializationStatus === 'ready')}
													disabled={previewLoading}
													aria-label={`Read ${reference.label}`}
												><BookOpen size={13} /></button>
												<button
													class="icon-btn"
													onclick={() => removeReference(reference)}
													disabled={busyId === reference.id}
													aria-label={`Remove ${reference.label}`}
												><Trash2 size={13} /></button>
											</div>
										</div>
									{/each}
								{/if}
							</div>
							{#if previewId}
								<div class="preview-panel">
									<div class="column-head">
										<span class="eyebrow">Extracted text</span>
										<div class="head-actions">
											<button class="btn" onclick={() => materialize(references.find((item) => item.id === previewId)!, true)}>
												<RefreshCw size={12} /> Refresh source
											</button>
											<button class="btn" onclick={() => (previewId = null)} aria-label="Close extracted text"><X size={12} /></button>
										</div>
									</div>
									{#if previewLoading}
										<div class="empty"><LoaderCircle size={14} class="spinner" /> Reading source</div>
									{:else}
										<textarea class="preview-text" bind:value={previewText}></textarea>
										<div class="preview-actions">
											<span class="hint">Correct anything the extractor got wrong before it is measured.</span>
											<button class="btn primary" onclick={savePreview}>Save reviewed text</button>
										</div>
									{/if}
								</div>
							{/if}
						</aside>
					</div>
				{:else if step === 'review'}
					<div class="step step-review">
						<aside class="analysis-column">
							<div class="column-head">
								<div class="head-copy">
									<span class="eyebrow">Style analysis</span>
									<h3>Measure first, then interpret</h3>
								</div>
								{#if analysisRunning}
									<button class="btn" onclick={cancelAnalysis}>Cancel</button>
								{:else}
									{#if run}
										<button class="btn" onclick={resetAnalysis}>Start over</button>
									{/if}
									<button class="btn primary" disabled={selectedCount === 0} onclick={startAnalysis}>
										{run ? 'Run again' : 'Run analysis'}
									</button>
								{/if}
							</div>
							<p class="column-note">
								DocWriter measures the references, then three specialist agents turn the measurements into
								style guidance.
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
												{:else if activity.icon === 'skill'}<Sparkles size={15} />
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
											<p class="column-note">{measurements.length} metrics fired. Metrics that measured zero are left out.</p>
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
										{#if trace.length === 0}
											<div class="empty large-empty">
												<p>
													Nothing recorded yet. Traces stream while a specialist works — run the analysis
													with this panel open to watch it think.
												</p>
											</div>
										{:else}
											<div class="agent-log">
												{#each trace as entry, index (index)}
													{#if entry.kind === 'text'}
														<p class="agent-say">{entry.text}</p>
													{:else if entry.kind === 'thinking'}
														<p class="agent-think">{entry.text}</p>
													{:else}
														<span class="tool-name">{entry.toolName}</span>
													{/if}
												{/each}
											</div>
										{/if}
									{/if}
								</div>
							</section>
						{/if}

						<section class="calibration-column">
							<div class="column-head">
								<div class="head-copy">
									<span class="eyebrow">Your choices</span>
									<h3>Pick your poison</h3>
								</div>
								{#if pendingTrials.length > 0}
									<span class="count-chip">{pendingTrials.length} left</span>
								{/if}
							</div>
							<p class="column-note">
								One of these is a passage you actually wrote. The other is the same passage with one habit
								changed. Pick whichever you would rather have written.
							</p>

							<div class="calibration-scroll">
								{#if pendingTrials.length === 0}
									<div class="empty large-empty">
										<Check size={22} />
										<p>
											{#if analysisRunning}Analysis is running. Choices will appear here as soon as they are ready.
											{:else if !run}Run the analysis to get some choices.
											{:else if summary?.unresolvedCount}Nothing left for now. Come back later for more.
											{:else}Nothing left to choose.{/if}
										</p>
									</div>
								{/if}
								{#each pendingTrials as trial (trial.id)}
									{@const proposition = propositionFor(trial)}
									<div class="calibration-card">
										<div class="proposition-top">
											<span class="family-chip">{proposition?.family.replace(/-/g, ' ')}</span>
											<span class="confidence">{Math.round((proposition?.confidence ?? 0) * 100)}% confidence</span>
										</div>
										<h4>{proposition?.statement}</h4>
										<p class="instruction">{proposition?.instruction}</p>

										{#if !trial.candidateA || !trial.candidateB}
											<div class="comparison-pending">
												{#if attemptedTrials.has(trial.id) && busyId !== trial.id}
													<span>Could not build a comparison from your sources.</span>
													<button class="btn" onclick={() => generateComparison(trial)}>Try again</button>
												{:else}
													<LoaderCircle size={13} class="spinner" />
													<span>Rewriting one of your passages without this pattern…</span>
												{/if}
											</div>
										{:else}
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
							</div>
						</section>
					</div>
				{:else}
					<div class="step step-active">
						<div class="active-inner">
							<div class="column-head">
								<div class="head-copy">
									<span class="eyebrow">Active skill</span>
									<h3>Active author skill</h3>
								</div>
								<div class="head-actions">
									{#if summary?.profile?.skillPath}
										<a class="btn" href="/api/style-profile/bundle"><Download size={13} /> Download skill</a>
									{/if}
									<a class="btn" href="/api/style-study/export"><Download size={13} /> Export study data</a>
								</div>
							</div>
							<p class="column-note">
								{activePropositions.length} proposition{activePropositions.length === 1 ? ' is' : 's are'} available
								to the writing agent. All measured propositions remain listed below.
							</p>

							{#if allPropositions.length === 0}
								<div class="empty large-empty">
									<Sparkles size={22} />
									<strong>No guidance yet</strong>
									<p>Analyze your references to create style guidance.</p>
								</div>
							{/if}

							<div class="proposition-list">
								{#each allPropositions as proposition (proposition.id)}
									<div class="proposition-card" class:muted={proposition.status === 'disabled'}>
										<div class="proposition-top">
											<span class="family-chip">{proposition.family.replace(/-/g, ' ')}</span>
											<span class="status-chip {proposition.status}"><span class="chip-dot" aria-hidden="true"></span>{titleCase(proposition.status)}</span>
											<span class="confidence">{Math.round(proposition.confidence * 100)}%</span>
										</div>
										<h4>{proposition.statement}</h4>
										<textarea
											aria-label={`Instruction for ${proposition.statement}`}
											value={propositionEdits[proposition.id] ?? proposition.instruction}
											oninput={(event) => (propositionEdits[proposition.id] = (event.currentTarget as HTMLTextAreaElement).value)}
										></textarea>
										<div class="proposition-actions">
											{#if ['active', 'confirmed'].includes(proposition.status)}
												<button class="btn" disabled={busyId === proposition.id} onclick={() => updateProposition(proposition, 'disabled')}>Disable</button>
											{:else if proposition.status === 'disabled'}
												<button class="btn" disabled={busyId === proposition.id} onclick={() => updateProposition(proposition, 'active')}>Enable</button>
											{/if}
											{#if isPropositionDirty(proposition)}
												<button class="btn primary" disabled={busyId === proposition.id} onclick={() => updateProposition(proposition)}>Save wording</button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
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
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
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
	.file-input {
		display: none;
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

	/* One composer for everything the user wants the style learned from:
	 * typed prose, pasted links, dropped files. The server sorts out what
	 * each thing is. */
	.composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border-light);
		border-radius: 10px;
		background: var(--bg-surface);
		transition: border-color 0.15s ease, background 0.15s ease;
	}
	.composer:focus-within {
		border-color: var(--accent);
	}
	.composer.drag-active {
		border-color: var(--accent);
		border-style: dashed;
		background: var(--accent-bg);
	}
	.composer-text {
		min-height: 92px;
		border: 0;
		background: transparent;
		padding: 2px 2px 0;
		resize: none;
	}
	.composer-text:focus {
		outline: none;
	}
	.composer-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.composer-actions .btn.primary {
		margin-left: auto;
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
	/* The same cat as the agent dock, running while the ingest agent works. */
	.log-head {
		display: flex;
		align-items: center;
		gap: 6px;
		position: sticky;
		top: 0;
		z-index: 1;
		padding: 2px 0 6px;
		background: var(--bg-elevated);
	}
	.mascot-face {
		display: inline-flex;
		align-items: center;
		color: var(--text-faint);
		transform-origin: center bottom;
		animation: mascot-sleep-bob 3.2s ease-in-out infinite;
		transition: color 0.3s;
	}
	.mascot-face.running {
		color: var(--accent);
		animation: mascot-run 0.6s ease-in-out infinite;
	}
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
	.bounce-dots {
		display: inline-flex;
		gap: 1px;
		color: var(--accent);
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 11px;
		font-weight: 700;
	}
	.bounce-dots span {
		animation: bounce-dot 1.2s ease-in-out infinite;
	}
	.bounce-dots span:nth-child(2) { animation-delay: 0.15s; }
	.bounce-dots span:nth-child(3) { animation-delay: 0.3s; }
	@keyframes bounce-dot {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
		30% { transform: translateY(-3px); opacity: 1; }
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
	.tool-call summary {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		color: var(--text-faint);
		cursor: pointer;
		list-style: none;
	}
	.tool-call summary::-webkit-details-marker {
		display: none;
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
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.attachment {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 4px 3px 8px;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 11.5px;
	}
	.attachment-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.attachment-remove:hover {
		background: var(--bg-hover);
		color: var(--text);
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
	.confidence {
		font-size: 11px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
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

	/* ---- step 1: sources ---------------------------------------------- */
	/* Left: what you hand over and what the agent does with it. Right: the
	 * sources it found, to keep or drop. */
	.step-sources {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(420px, 520px);
		height: 100%;
		overflow: hidden;
	}
	.source-column {
		display: flex;
		min-width: 0;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
	}
	.source-column > .composer {
		flex: none;
	}
	/* With nothing submitted yet the composer is the whole pane, so it sits in
	 * the middle rather than clinging to the top of an empty column. */
	.source-column.centered {
		justify-content: center;
		padding-bottom: 6vh;
	}
	.source-column.centered .source-scroll {
		flex: 0 0 auto;
	}
	.composer {
		margin: 20px 18px 0;
	}
	.source-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 6px 18px 16px;
	}

	.picks-column {
		display: flex;
		min-width: 0;
		/* Without min-height the flex child grows past the grid row instead of
		 * handing its overflow to .picks-scroll, and the list cannot scroll. */
		min-height: 0;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		border-left: 1px solid var(--border-light);
		background: var(--bg-surface);
	}
	.picks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 18px 16px 0;
	}
	.picks-count {
		padding: 2px 8px;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		background: var(--bg-elevated);
		color: var(--text-faint);
		font-size: 11px;
		font-weight: 600;
	}
	.picks-count.good {
		border-color: color-mix(in srgb, var(--diff-added-color) 40%, var(--border-light));
		color: var(--diff-added-color);
	}
	.picks-count.over {
		border-color: color-mix(in srgb, var(--feedback-border) 50%, var(--border-light));
		color: color-mix(in srgb, var(--feedback-border) 65%, var(--text));
	}
	.picks-hint {
		padding: 7px 16px 0;
		color: var(--text-faint);
		font-size: 11.5px;
		line-height: 1.5;
	}
	.picks-scroll {
		flex: 1;
		min-height: 0;
		margin-top: 10px;
		overflow: auto;
		padding: 0 16px 16px;
	}
	/* Keeping is the loud state: an unkept row is just a normal row, a kept one
	 * is tinted and ticked. Fading the unkept ones made a mostly-unkept list
	 * look broken. */
	.pick-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 9px 10px;
		border: 1px solid transparent;
		border-radius: 8px;
	}
	.pick-row + .pick-row {
		margin-top: 2px;
	}
	.pick-row:hover {
		background: var(--bg-hover);
	}
	.pick-row.kept {
		border-color: color-mix(in srgb, var(--diff-added-color) 35%, var(--border-light));
		background: color-mix(in srgb, var(--diff-added-color) 9%, var(--bg-elevated));
	}
	.pick-row.busy {
		opacity: 0.6;
	}
	.keep-box {
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		border: 1.5px solid var(--border);
		border-radius: 5px;
		background: var(--bg);
		color: #fff;
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease;
	}
	.keep-box:hover:not(:disabled) {
		border-color: var(--diff-added-color);
	}
	.keep-box.on {
		border-color: var(--diff-added-color);
		background: var(--diff-added-color);
	}
	.keep-box:disabled {
		cursor: default;
	}
	.source-list {
		display: flex;
		flex-direction: column;
	}
	.source-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border-light);
	}
	.source-row.busy {
		opacity: 0.6;
	}
	.source-icon {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 7px;
		background: var(--bg-hover);
		color: var(--text-faint);
	}
	.source-main {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
	}
	/* Article titles, so two lines rather than one truncated one. */
	.source-main strong {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: 12.5px;
		font-weight: 600;
		line-height: 1.35;
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

	.preview-panel {
		display: flex;
		max-height: 46%;
		flex-direction: column;
		gap: 10px;
		padding: 14px 18px 16px;
		border-top: 1px solid var(--border-light);
		background: var(--bg-surface);
	}
	.preview-text {
		flex: 1;
		min-height: 120px;
	}
	.preview-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
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
	.calibration-card + .calibration-card {
		margin-top: 12px;
	}
	.proposition-top {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.proposition-top .confidence {
		margin-left: auto;
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
	.proposition-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 16px;
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
	.proposition-card textarea {
		margin-top: 9px;
		min-height: 54px;
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
		.analysis-column {
			border-right: 0;
			border-bottom: 1px solid var(--border-light);
			overflow: visible;
		}
		.picks-column {
			border-left: 0;
			border-top: 1px solid var(--border-light);
		}
		.source-column,
		.picks-column {
			height: auto;
			overflow: visible;
		}
		.source-scroll,
		.picks-scroll,
		.calibration-scroll {
			overflow: visible;
		}
		.preview-panel {
			max-height: none;
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
		.source-row {
			flex-wrap: wrap;
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
