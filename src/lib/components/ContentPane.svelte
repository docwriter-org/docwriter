<script lang="ts">
	import { GripVertical, Plus, Trash2, Sparkles, Pin, X as XIcon } from 'lucide-svelte';
	import { commitRuntimeViewToCanonicalStores } from '$lib/runtime-canonical';
	import type { Fragment, Section } from '$lib/types';
	import { ATOM_CONSTRAINTS, TRANSITIONS } from '$lib/types';
	import { editorPins, fragments, highlightedFrags, highlightedSents, paraBreaks, prose, pushDocumentOp, pushHistory, rules, selectedModel, showHistory, sections } from '$lib/stores';

	let fragList: Fragment[] = $state([]);
	fragments.subscribe((v) => (fragList = v));

	let hlFrags: Set<string> = $state(new Set());
	highlightedFrags.subscribe((v) => (hlFrags = v));

	let breaks: Set<number> = $state(new Set());
	paraBreaks.subscribe((v) => (breaks = v));

	let sectionList: Section[] = $state([]);
	sections.subscribe((v) => (sectionList = v));

	let editingSectionIdx: number | null = $state(null);
	let editingSectionTitle = $state('');

	function getSectionForIndex(index: number): Section | undefined {
		return sectionList.find((s) => s.beforeAtomIndex === index);
	}

	function startEditSection(section: Section) {
		editingSectionIdx = section.beforeAtomIndex;
		editingSectionTitle = section.title;
	}

	function saveEditSection() {
		if (editingSectionIdx === null) return;
		const idx = editingSectionIdx;
		const title = editingSectionTitle.trim();
		let nextSections = sectionList;
		if (title) {
			sections.update((ss) => {
				nextSections = ss.map((s) => s.beforeAtomIndex === idx ? { ...s, title } : s);
				return nextSections;
			});
			syncCanonicalStoresFromLocalState({ sections: nextSections });
			pushDocumentOp({
				type: 'replace_sections',
				sections: cloneSections(nextSections)
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Renamed section at atom ${idx} to "${title}"`
			});
		}
		editingSectionIdx = null;
		editingSectionTitle = '';
	}

	let editingId: string | null = $state(null);
	let editPredicate = $state('');
	let editSubject = $state('');

	let dragIdx: number | null = $state(null);
	let overIdx: number | null = $state(null);

	let currentProse: typeof $prose = $state([]);
	prose.subscribe((v) => (currentProse = v));

	let currentEditorPins = $state<import('$lib/types').EditorPin[]>([]);
	editorPins.subscribe((v) => (currentEditorPins = v));

	let currentRules = $state<typeof $rules>([]);
	rules.subscribe((v) => (currentRules = v));

	function getFragIds(f: Fragment): string[] {
		return [f.id, ...(f.children || []).map((c) => c.id)];
	}

	const transitionWords = TRANSITIONS.filter(t => t !== '');

	interface PredicateToken {
		display: string;
		normalized: string;
	}

	function normalizePinnedText(text: string): string {
		const normalized = text.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
		return normalized || text.trim().toLowerCase();
	}

	function getPredicateTokens(predicate: string): PredicateToken[] {
		return predicate
			.split(/\s+/)
			.filter((token) => token.length > 0)
			.map((token) => ({
				display: token,
				normalized: normalizePinnedText(token)
			}));
	}

	function isPinnedWord(pinnedWords: string[] | undefined, word: string): boolean {
		const normalizedWord = normalizePinnedText(word);
		return (pinnedWords || []).some((pinnedWord) => normalizePinnedText(pinnedWord) === normalizedWord);
	}

	function cloneFragments(fragmentList: Fragment[]): Fragment[] {
		return fragmentList.map((fragment) => ({
			...fragment,
			...(fragment.pinnedWords ? { pinnedWords: [...fragment.pinnedWords] } : {}),
			children: cloneFragments(fragment.children || [])
		}));
	}

	function cloneSections(sectionListToClone: Section[]): Section[] {
		return sectionListToClone.map((section) => ({ ...section }));
	}

	function syncCanonicalStoresFromLocalState(input?: {
		fragments?: Fragment[];
		prose?: typeof currentProse;
		sections?: Section[];
		editorPins?: typeof currentEditorPins;
	}) {
		const nextFragments = input?.fragments || fragList;
		const nextProse = input?.prose || currentProse;
		const nextSections = input?.sections || sectionList;
		const nextEditorPins = input?.editorPins || currentEditorPins;
		commitRuntimeViewToCanonicalStores({
			fragments: nextFragments,
			prose: nextProse,
			rules: currentRules,
			paraBreaks: breaks,
			editorPins: nextEditorPins,
			sections: nextSections
		});
	}

	function setTransition(fragId: string, value: string) {
		let nextFragments: Fragment[] = [];
		fragments.update((fs) => {
			nextFragments = fs.map((f) => f.id === fragId ? { ...f, transition: value || undefined } : f);
			return nextFragments;
		});
		syncCanonicalStoresFromLocalState({ fragments: nextFragments });
		pushDocumentOp({
			type: 'replace_fragments',
			fragments: cloneFragments(nextFragments)
		});
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Set transition on atom ${fragId} to "${value || 'none'}"`
		});
	}

	function handleTransitionHover(f: Fragment) {
		// Highlight the transition word in the prose
		const ids = new Set(getFragIds(f));
		highlightedFrags.set(ids);
		const si = new Set<number>();
		currentProse.forEach((s, i) => {
			if (s.frags.some((fid) => ids.has(fid))) si.add(i);
		});
		highlightedSents.set(si);
	}

	function handleFragHover(f: Fragment) {
		const ids = new Set(getFragIds(f));
		highlightedFrags.set(ids);
		const si = new Set<number>();
		currentProse.forEach((s, i) => {
			if (s.frags.some((fid) => ids.has(fid))) si.add(i);
		});
		highlightedSents.set(si);
	}

	function handleChildHover(cid: string) {
		highlightedFrags.set(new Set([cid]));
		const si = new Set<number>();
		currentProse.forEach((s, i) => {
			if (s.frags.includes(cid)) si.add(i);
		});
		highlightedSents.set(si);
	}

	function clearHL() {
		highlightedFrags.set(new Set());
		highlightedSents.set(new Set());
	}

	function startEdit(id: string, predicate: string, subject: string) {
		editingId = id;
		editPredicate = predicate;
		editSubject = subject;
	}

	function saveEdit(parentId: string | null) {
		const changedId = editingId!;

		// Capture old values for history
		let oldSubject = '';
		let oldPredicate = '';
		const findFrag = (id: string) => {
			for (const f of fragList) {
				if (f.id === id) return f;
				for (const c of f.children || []) {
					if (c.id === id) return c;
				}
			}
			return null;
		};
		const old = findFrag(changedId);
		if (old) { oldSubject = old.subject; oldPredicate = old.predicate; }

		if (parentId) {
			fragments.update((fs) =>
				fs.map((f) =>
					f.id === parentId
						? {
								...f,
								children: (f.children || []).map((c) =>
									c.id === editingId ? { ...c, predicate: editPredicate, subject: editSubject } : c
								)
							}
						: f
				)
			);
		} else {
			fragments.update((fs) =>
				fs.map((f) => (f.id === editingId ? { ...f, predicate: editPredicate, subject: editSubject } : f))
			);
		}
		editingId = null;

		// Only trigger if something actually changed
		const changes: string[] = [];
		if (oldSubject !== editSubject) changes.push(`subject "${oldSubject}" → "${editSubject}"`);
		if (oldPredicate !== editPredicate) changes.push(`claim "${oldPredicate.slice(0, 30)}..." → "${editPredicate.slice(0, 30)}..."`);
		if (changes.length > 0) {
			pushDocumentOp({
				type: 'edit_atom',
				fragId: changedId,
				subject: editSubject,
				predicate: editPredicate
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Edited atom ${changedId}: ${changes.join(', ')}`
			});
		}
	}

	function handleDragStart(i: number) {
		dragIdx = i;
	}
	function handleDragOver(e: DragEvent, i: number) {
		e.preventDefault();
		overIdx = i;
	}
	function handleDrop(i: number) {
		if (dragIdx === null || dragIdx === i) {
			dragIdx = null;
			overIdx = null;
			return;
		}
		const movedId = fragList[dragIdx!].id;
		let nextFragments: Fragment[] = [];
		fragments.update((fs) => {
			const next = [...fs];
			const [m] = next.splice(dragIdx!, 1);
			next.splice(i, 0, m);
			nextFragments = next;
			return next;
		});
		syncCanonicalStoresFromLocalState({ fragments: nextFragments });
		dragIdx = null;
		overIdx = null;
		pushDocumentOp({
			type: 'replace_fragments',
			fragments: cloneFragments(nextFragments)
		});
	}

	// Child drag reorder
	let childDragParent: string | null = $state(null);
	let childDragIdx: number | null = $state(null);
	let childOverIdx: number | null = $state(null);

	function handleChildDragStart(parentId: string, idx: number) {
		childDragParent = parentId;
		childDragIdx = idx;
	}
	function handleChildDragOver(e: DragEvent, idx: number) {
		e.preventDefault();
		childOverIdx = idx;
	}
	function handleChildDrop(parentId: string, idx: number) {
		if (childDragParent !== parentId || childDragIdx === null || childDragIdx === idx) {
			childDragIdx = null; childOverIdx = null; childDragParent = null;
			return;
		}
		let nextFragments: Fragment[] = [];
		fragments.update((fs) => {
			nextFragments = fs.map((f) => {
				if (f.id !== parentId) return f;
				const kids = [...(f.children || [])];
				const [moved] = kids.splice(childDragIdx!, 1);
				kids.splice(idx, 0, moved);
				return { ...f, children: kids };
			});
			return nextFragments;
		});
		syncCanonicalStoresFromLocalState({ fragments: nextFragments });
		pushDocumentOp({
			type: 'replace_fragments',
			fragments: cloneFragments(nextFragments)
		});
		childDragIdx = null; childOverIdx = null; childDragParent = null;
	}

	function toggleBreak(i: number, add: boolean) {
		let nextBreaks = new Set<number>();
		paraBreaks.update((pb) => {
			const next = new Set(pb);
			if (add) next.add(i);
			else next.delete(i);
			nextBreaks = next;
			return next;
		});

		// Recompute prose para values to match the new breaks
		let currentBreaks: Set<number>;
		paraBreaks.subscribe((v) => (currentBreaks = v))();
		let curProse: import('$lib/types').Sentence[];
		prose.subscribe((v) => (curProse = v))();

		// Build frag → para mapping from atoms + breaks
		let curFrags: Fragment[] = [];
		fragments.subscribe((v) => (curFrags = v))();
		const fragParaMap: Record<string, number> = {};
		let paraGroup = 0;
		curFrags.forEach((f, idx) => {
			if (idx > 0 && currentBreaks!.has(idx)) paraGroup++;
			const ids = [f.id, ...(f.children || []).map((c) => c.id)];
			ids.forEach((id) => { fragParaMap[id] = paraGroup; });
		});

		// Update prose para values
		const updated = curProse!.map((s) => {
			const newPara = Math.min(...s.frags.map((fid) => fragParaMap[fid] ?? s.para));
			return { ...s, para: isFinite(newPara) ? newPara : s.para };
		});
		prose.set(updated);
		syncCanonicalStoresFromLocalState({ prose: updated });
		pushDocumentOp({
			type: 'replace_paragraph_structure',
			paraBreaks: Array.from(nextBreaks).sort((a, b) => a - b),
			prose: updated
		});

		// Paragraph breaks are structural — no agent needed, just save
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `${add ? 'Added' : 'Removed'} paragraph break at position ${i}` });
	}

	// Add atom
	let addingAtom = $state(false);
	let addingChildOf: string | null = $state(null);
	let newSubject = $state('');
	let newPredicate = $state('');
	let addAtIndex = $state(-1); // -1 = end

	function startAddAtom(afterIndex: number) {
		addAtIndex = afterIndex;
		addingAtom = true;
		addingChildOf = null;
		newSubject = '';
		newPredicate = '';
	}

	function startAddChild(parentId: string) {
		addingChildOf = parentId;
		addingAtom = true;
		newSubject = '';
		newPredicate = '';
	}

	function confirmAddAtom() {
		if (!newSubject.trim() || !newPredicate.trim()) return;
		const id = 'f' + Date.now().toString(36);
		const newFrag: Fragment = { id, subject: newSubject.trim(), predicate: newPredicate.trim(), children: [] };
		let nextFragments: Fragment[] = [];

		if (addingChildOf) {
			fragments.update((fs) => {
				nextFragments = fs.map((f) => f.id === addingChildOf ? { ...f, children: [...(f.children || []), newFrag] } : f);
				return nextFragments;
			});
		} else {
			fragments.update((fs) => {
				const next = [...fs];
				const idx = addAtIndex >= 0 ? addAtIndex + 1 : next.length;
				next.splice(idx, 0, newFrag);
				nextFragments = next;
				return next;
			});
		}
		syncCanonicalStoresFromLocalState({ fragments: nextFragments });

		pushDocumentOp({
			type: 'replace_fragments',
			fragments: cloneFragments(nextFragments)
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Added atom ${id}: ${newSubject.trim()} | ${newPredicate.trim()}` });
		addingAtom = false;
		addingChildOf = null;
	}

	function cancelAddAtom() {
		addingAtom = false;
		addingChildOf = null;
	}

	// Delete atom
	function deleteAtom(id: string) {
		let nextFragments: Fragment[] = [];
		fragments.update((fs) => {
			// Remove from top-level
			const filtered = fs.filter((f) => f.id !== id);
			// Remove from children
			nextFragments = filtered.map((f) => ({
				...f,
				children: (f.children || []).filter((c) => c.id !== id)
			}));
			return nextFragments;
		});
		syncCanonicalStoresFromLocalState({ fragments: nextFragments });
		pushDocumentOp({
			type: 'replace_fragments',
			fragments: cloneFragments(nextFragments)
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Deleted atom ${id}` });
	}

	// Tabs
	let activeTab: 'atoms' | 'refs' = $state('atoms');

	// References
	interface RefEntry { filename: string; source: string; tag: string; atomCount: number; preview: string }
	let refs: RefEntry[] = $state([]);
	let selectedRef: any = $state(null);
	let loadingRefs = $state(false);

	async function loadRefs() {
		loadingRefs = true;
		try {
			const res = await fetch('/api/references');
			refs = await res.json();
		} catch { refs = []; }
		loadingRefs = false;
	}

	async function viewRef(filename: string) {
		try {
			const res = await fetch(`/api/references/${filename}`);
			selectedRef = await res.json();
		} catch { selectedRef = null; }
	}

	async function toggleRefTag(filename: string) {
		// Toggle own/inspo tag — would need a PATCH endpoint, for now just visual
		refs = refs.map((r) => r.filename === filename ? { ...r, tag: r.tag === 'own' ? 'inspo' : 'own' } : r);
	}

	// Alternatives carousel
	let alternativesFor: string | null = $state(null);
	let alternatives: Array<{ subject: string; predicate: string }> = $state([]);
	let loadingAlts = $state(false);

	let model = $state('opus');
	selectedModel.subscribe((v) => (model = v));

	async function fetchAlternatives(frag: Fragment) {
		if (alternativesFor === frag.id) { alternativesFor = null; return; }
		alternativesFor = frag.id;
		loadingAlts = true;
		alternatives = [];
		showHistory.set(true);
		pushHistory({ type: 'render_start', timestamp: Date.now(), trigger: `Alternatives for: ${frag.subject} | ${frag.predicate}` });
		try {
			const context = fragList.filter((f) => f.id !== frag.id).map((f) => ({ subject: f.subject, label: f.predicate }));
			const res = await fetch('/api/alternatives', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ atom: { subject: frag.subject, label: frag.predicate }, context, model: 'haiku' })
			});
			alternatives = await res.json();
			pushHistory({ type: 'assistant_text', timestamp: Date.now(), text: `Generated ${alternatives.length} alternatives for **${frag.subject}**` });
			pushHistory({ type: 'render_end', timestamp: Date.now(), success: true });
		} catch {
			alternatives = [];
			pushHistory({ type: 'render_end', timestamp: Date.now(), success: false });
		}
		loadingAlts = false;
	}

	function adoptAlternative(fragId: string, alt: { subject: string; predicate: string }) {
		fragments.update((fs) =>
			fs.map((f) => f.id === fragId ? { ...f, subject: alt.subject, predicate: alt.predicate } : f)
		);
		pushDocumentOp({
			type: 'edit_atom',
			fragId,
			subject: alt.subject,
			predicate: alt.predicate
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Adopted alternative for ${fragId}: ${alt.subject} | ${alt.predicate}` });
		alternativesFor = null;
	}

	// Pin word
	function hasPinnedText(text: string, pinnedText: string): boolean {
		return text.toLowerCase().includes(pinnedText.toLowerCase());
	}

	function togglePin(fragId: string, word: string) {
		const normalizedWord = normalizePinnedText(word);
		if (!normalizedWord) return;
		let isPinnedAfterToggle = false;
		fragments.update((fs) =>
			fs.map((f) => {
				if (f.id === fragId) {
					const pinned = f.pinnedWords || [];
					const wasPinned = isPinnedWord(pinned, normalizedWord);
					const next = wasPinned
						? pinned.filter((pinnedWord) => normalizePinnedText(pinnedWord) !== normalizedWord)
						: [...pinned, normalizedWord];
					isPinnedAfterToggle = !wasPinned;
					return { ...f, pinnedWords: next };
				}
				return {
					...f,
					children: (f.children || []).map((c) => {
						if (c.id === fragId) {
							const pinned = c.pinnedWords || [];
							const wasPinned = isPinnedWord(pinned, normalizedWord);
							const next = wasPinned
								? pinned.filter((pinnedWord) => normalizePinnedText(pinnedWord) !== normalizedWord)
								: [...pinned, normalizedWord];
							isPinnedAfterToggle = !wasPinned;
							return { ...c, pinnedWords: next };
						}
						return c;
					})
				};
			})
		);
		syncCanonicalStoresFromLocalState();
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `${isPinnedAfterToggle ? 'Pinned' : 'Unpinned'} "${normalizedWord}" on atom ${fragId}`
		});
		pushDocumentOp({
			type: 'pin_atom_word',
			fragId,
			word: normalizedWord,
			pinned: isPinnedAfterToggle
		});
	}
</script>

<div class="content-pane">
	<div class="pane-header">
		<button class="tab" class:active={activeTab === 'atoms'} onclick={() => (activeTab = 'atoms')}>Atoms</button>
		<button class="tab" class:active={activeTab === 'refs'} onclick={() => { activeTab = 'refs'; loadRefs(); }}>References</button>
	</div>

	{#if activeTab === 'refs'}
		<div class="refs-list">
			{#if loadingRefs}
				<div class="refs-loading">Loading...</div>
			{:else if refs.length === 0}
				<div class="refs-empty">No references yet. Use "+ My Writing" or "+ Inspo" to add some.</div>
			{:else}
				{#each refs as ref}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="ref-item" class:selected={selectedRef?.source === ref.source} onclick={() => viewRef(ref.filename)}>
						<div class="ref-item-header">
							<span class="ref-name">{ref.source}</span>
							<button class="ref-tag-btn" class:own={ref.tag === 'own'} onclick={(e) => { e.stopPropagation(); toggleRefTag(ref.filename); }}>
								{ref.tag === 'own' ? 'mine' : 'inspo'}
							</button>
						</div>
						<div class="ref-preview">{ref.preview}</div>
						<div class="ref-meta">{ref.atomCount} atoms</div>
					</div>
				{/each}
			{/if}

			{#if selectedRef}
				<div class="ref-detail">
					<div class="ref-detail-header">
						<span class="ref-detail-title">{selectedRef.source}</span>
						<button class="ref-close" onclick={() => (selectedRef = null)}><XIcon size={12} /></button>
					</div>
					{#if selectedRef.atoms}
						{#each selectedRef.atoms as a}
							<div class="ref-atom">
								<span class="ref-atom-subject">{a.subject}</span>
								<span class="ref-atom-predicate">{a.predicate}</span>
							</div>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	{:else}
	<div class="fragment-list">
		{#each fragList as f, i}
			{@const section = getSectionForIndex(i)}
			{#if section}
				<div class="section-divider">
					{#if editingSectionIdx === i}
						<input
							class="section-title-input"
							bind:value={editingSectionTitle}
							onkeydown={(e) => { if (e.key === 'Enter') saveEditSection(); if (e.key === 'Escape') { editingSectionIdx = null; } }}
							onblur={saveEditSection}
						/>
					{:else}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="section-title" onclick={() => startEditSection(section)}>
							{section.title}
						</div>
					{/if}
				</div>
			{/if}
			{#if i > 0 && !getSectionForIndex(i)}
				{#if breaks.has(i)}
					<div class="para-break-line">
						<div class="break-rule"></div>
						<button class="break-btn" onclick={() => toggleBreak(i, false)} title="Remove paragraph break">¶</button>
						<div class="break-rule"></div>
					</div>
				{:else}
					<div
						class="break-hover-zone"
						onmouseenter={(e) => (e.currentTarget.style.opacity = '1')}
						onmouseleave={(e) => (e.currentTarget.style.opacity = '0')}
					>
						<button class="break-btn" onclick={() => toggleBreak(i, true)} title="Add paragraph break">¶ break</button>
					</div>
				{/if}
			{/if}

			<!-- Transition word -->
			{#if i > 0}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="transition-row" onmouseenter={() => handleTransitionHover(f)} onmouseleave={clearHL}>
					<select
						class="transition-select"
						class:has-value={!!f.transition}
						value={f.transition || ''}
						onchange={(e) => setTransition(f.id, e.currentTarget.value)}
					>
						<option value="">···</option>
						{#each transitionWords as tw}
							<option value={tw}>{tw}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="fragment-group">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="fragment-row"
					class:highlighted={hlFrags.has(f.id)}
					class:dragging={dragIdx === i}
					class:drop-target={overIdx === i && dragIdx !== null}
					draggable={editingId !== f.id}
					ondragstart={() => handleDragStart(i)}
					ondragover={(e) => handleDragOver(e, i)}
					ondrop={() => handleDrop(i)}
					ondragend={() => { dragIdx = null; overIdx = null; }}
					onmouseenter={() => handleFragHover(f)}
					onmouseleave={clearHL}
				>
					{#if editingId === f.id}
						<div class="edit-form">
							<div class="edit-row">
								<input class="edit-subject" bind:value={editSubject} placeholder="subj" />
								<input
									class="edit-label"
									bind:value={editPredicate}
									onkeydown={(e) => { if (e.key === 'Enter') saveEdit(null); if (e.key === 'Escape') editingId = null; }}
								/>
							</div>
							<div class="edit-actions">
								<button class="save-btn" onclick={() => saveEdit(null)}>Save</button>
								<button class="cancel-btn" onclick={() => (editingId = null)}>Esc</button>
							</div>
						</div>
					{:else}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div class="fragment-content">
							<span class="grip-handle" title="Drag to reorder"><GripVertical size={11} /></span>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span class="frag-clickable" onclick={() => startEdit(f.id, f.predicate, f.subject)}>
								<span class="frag-subject">{f.subject}</span>
								<span class="frag-predicate">
									{#each getPredicateTokens(f.predicate) as token, wi}
										{#if wi > 0}{' '}{/if}
										<span class="predicate-chip" class:pinned={isPinnedWord(f.pinnedWords, token.normalized)}>
											<span class="predicate-word">{token.display}</span>
											<button
												class="pin-word-btn"
												class:active={isPinnedWord(f.pinnedWords, token.normalized)}
												onclick={(e) => { e.stopPropagation(); togglePin(f.id, token.normalized); }}
												title={isPinnedWord(f.pinnedWords, token.normalized) ? `Unpin "${token.normalized}"` : `Pin "${token.normalized}"`}
											>
												<Pin size={9} />
											</button>
										</span>
									{/each}
								</span>
							</span>
							<span class="frag-actions">
								<button class="frag-action-btn" title="Alternatives" onclick={(e) => { e.stopPropagation(); fetchAlternatives(f); }}>
									<Sparkles size={11} />
								</button>
								<button class="frag-action-btn danger" title="Delete" onclick={(e) => { e.stopPropagation(); deleteAtom(f.id); }}>
									<Trash2 size={11} />
								</button>
							</span>
						</div>
						{#if alternativesFor === f.id}
							<div class="alts-carousel">
								{#if loadingAlts}
									<span class="alts-loading">Generating alternatives...</span>
								{:else}
									{#each alternatives as alt}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="alt-card" onclick={() => adoptAlternative(f.id, alt)}>
											<span class="alt-subject">{alt.subject}</span>
											<span class="alt-predicate">{alt.predicate}</span>
										</div>
									{/each}
									<button class="alt-close" onclick={() => (alternativesFor = null)}><XIcon size={10} /></button>
								{/if}
							</div>
						{/if}
					{/if}
				</div>

				{#each f.children || [] as c, ci}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="child-row"
						class:highlighted={hlFrags.has(c.id)}
						class:drop-target={childOverIdx === ci && childDragParent === f.id}
						draggable={editingId !== c.id}
						ondragstart={() => handleChildDragStart(f.id, ci)}
						ondragover={(e) => handleChildDragOver(e, ci)}
						ondrop={() => handleChildDrop(f.id, ci)}
						ondragend={() => { childDragIdx = null; childOverIdx = null; childDragParent = null; }}
						onmouseenter={() => handleChildHover(c.id)}
						onmouseleave={clearHL}
					>
						{#if editingId === c.id}
							<div class="child-edit">
								<input class="edit-subject small" bind:value={editSubject} placeholder="subj" />
								<input
									class="edit-label small"
									bind:value={editPredicate}
									onkeydown={(e) => { if (e.key === 'Enter') saveEdit(f.id); if (e.key === 'Escape') editingId = null; }}
								/>
								<button class="check-btn" onclick={() => saveEdit(f.id)}>✓</button>
							</div>
						{:else}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="child-content" onclick={() => startEdit(c.id, c.predicate, c.subject)}>
								<span class="child-subject">{c.subject}</span>
								<span class="child-predicate">
									{#each getPredicateTokens(c.predicate) as token, wi}
										{#if wi > 0}{' '}{/if}
										<span class="predicate-chip child" class:pinned={isPinnedWord(c.pinnedWords, token.normalized)}>
											<span class="predicate-word">{token.display}</span>
											<button
												class="pin-word-btn"
												class:active={isPinnedWord(c.pinnedWords, token.normalized)}
												onclick={(e) => { e.stopPropagation(); togglePin(c.id, token.normalized); }}
												title={isPinnedWord(c.pinnedWords, token.normalized) ? `Unpin "${token.normalized}"` : `Pin "${token.normalized}"`}
											>
												<Pin size={8} />
											</button>
										</span>
									{/each}
								</span>
								<span class="frag-actions">
									<button class="frag-action-btn" title="Alternatives" onclick={(e) => { e.stopPropagation(); fetchAlternatives(c); }}>
										<Sparkles size={10} />
									</button>
									<button class="frag-action-btn danger" title="Delete" onclick={(e) => { e.stopPropagation(); deleteAtom(c.id); }}>
										<Trash2 size={10} />
									</button>
								</span>
							</div>
						{/if}
					</div>
				{/each}

				<!-- Add child button -->
				{#if addingAtom && addingChildOf === f.id}
					<div class="add-atom-form child-add">
						<input class="add-input" bind:value={newSubject} placeholder="subject subject"  onkeydown={(e) => e.key === 'Escape' && cancelAddAtom()} />
						<input class="add-input" bind:value={newPredicate} placeholder="predicate"  onkeydown={(e) => { if (e.key === 'Enter') confirmAddAtom(); if (e.key === 'Escape') cancelAddAtom(); }} />
						<button class="add-confirm" onclick={confirmAddAtom}>Add</button>
					</div>
				{:else}
					<button class="add-child-btn" onclick={() => startAddChild(f.id)}>
						+ atom
					</button>
				{/if}
			</div>
		{/each}

	</div>

	<!-- Pinned to bottom -->
	{#if addingAtom && !addingChildOf}
		<div class="add-atom-form bottom">
			<input class="add-input" bind:value={newSubject} placeholder="subject subject"  onkeydown={(e) => e.key === 'Escape' && cancelAddAtom()} />
			<input class="add-input" bind:value={newPredicate} placeholder="predicate"  onkeydown={(e) => { if (e.key === 'Enter') confirmAddAtom(); if (e.key === 'Escape') cancelAddAtom(); }} />
			<div class="add-actions">
				<button class="add-confirm" onclick={confirmAddAtom}>Add</button>
				<button class="add-cancel" onclick={cancelAddAtom}>Cancel</button>
			</div>
		</div>
	{:else}
		<button class="add-atom-btn" onclick={() => startAddAtom(fragList.length - 1)}>
			<Plus size={12} /> Add atom
		</button>
	{/if}
{/if}
</div>

<style>
	.content-pane {
		width: 100%;
		height: 100%;
		background: var(--pane-bg);
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-light);
		overflow: hidden;
		user-select: none;
	}
	.pane-header {
		padding: 0;
		border-bottom: 1px solid var(--border-light);
		display: flex;
		flex-shrink: 0;
	}
	.tab {
		flex: 1;
		padding: 10px 12px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		font-family: inherit;
		text-align: center;
	}
	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	.tab:hover:not(.active) {
		color: var(--text-muted);
	}

	/* References */
	.refs-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
	}
	.refs-loading, .refs-empty {
		font-size: 13px;
		color: var(--text-faint);
		padding: 16px 8px;
		line-height: 1.5;
	}
	.ref-item {
		padding: 8px 10px;
		border-radius: 6px;
		cursor: pointer;
		margin-bottom: 4px;
		border: 1px solid transparent;
	}
	.ref-item:hover { background: var(--bg-hover); }
	.ref-item.selected { border-color: var(--accent-light); background: var(--accent-bg); }
	.ref-item-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	.ref-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
	}
	.ref-tag-btn {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-surface);
		color: var(--text-faint);
		cursor: pointer;
		font-family: inherit;
	}
	.ref-tag-btn.own {
		border-color: var(--accent-light);
		color: var(--accent);
		background: var(--accent-bg);
	}
	.ref-preview {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ref-meta {
		font-size: 11px;
		color: var(--text-faint);
		margin-top: 2px;
	}
	.ref-detail {
		border-top: 1px solid var(--border-light);
		padding: 8px;
		margin-top: 8px;
	}
	.ref-detail-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}
	.ref-detail-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.ref-close {
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
	}
	.ref-atom {
		padding: 3px 0;
		font-size: 12px;
	}
	.ref-atom-subject {
		color: var(--accent-subject);
		font-weight: 600;
		margin-right: 4px;
	}
	.ref-atom-predicate {
		color: var(--text-secondary);
	}
	.fragment-list {
		padding: 8px 10px;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
	}

	/* Section dividers */
	.section-divider {
		padding: 8px 6px 4px;
		margin-top: 4px;
		margin-bottom: 2px;
		border-bottom: 1px solid var(--border-light);
	}
	.section-title {
		font-size: 13px;
		font-weight: 700;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		cursor: pointer;
	}
	.section-title:hover {
		color: var(--text);
	}
	.section-title-input {
		width: 100%;
		font-size: 13px;
		font-weight: 700;
		color: var(--text);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border: 1px solid var(--accent-light);
		border-radius: 4px;
		padding: 2px 6px;
		font-family: inherit;
		outline: none;
		background: var(--bg);
	}
	.section-title-input:focus {
		border-color: var(--accent);
	}

	.para-break-line {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		margin: 2px 0;
	}
	.break-rule {
		flex: 1;
		height: 1px;
		background: #e5e7eb;
	}
	.break-btn {
		background: none;
		border: none;
		color: #c7d2fe;
		cursor: pointer;
		padding: 0;
		font-size: 10px;
		font-family: inherit;
	}
	.break-hover-zone {
		height: 10px;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.1s;
	}

	.transition-row {
		text-align: center;
		margin: -2px 0 2px;
	}
	.transition-select {
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 12px;
		font-family: inherit;
		font-variant: small-caps;
		letter-spacing: 0.1em;
		cursor: pointer;
		padding: 2px 4px;
		outline: none;
		text-align: center;
		-webkit-appearance: none;
		appearance: none;
	}
	.transition-select:hover {
		color: var(--text-muted);
		background: var(--bg-hover);
		border-radius: 3px;
	}
	.transition-select.has-value {
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
	}
	.fragment-group {
		margin-bottom: 2px;
	}
	.fragment-row {
		padding: 5px 6px;
		border-radius: 4px;
		border: 1.5px solid transparent;
		cursor: grab;
		transition: background 0.1s;
	}
	.fragment-row.highlighted {
		background: var(--accent-bg);
	}
	.fragment-row.dragging {
		background: #f4f5f7;
	}
	.fragment-row.drop-target {
		border-color: var(--accent);
	}

	.fragment-content {
		display: flex;
		align-items: baseline;
		gap: 5px;
		cursor: pointer;
	}
	.frag-subject {
		font-size: 14px;
		font-weight: 600;
		color: var(--accent-subject);
		flex-shrink: 0;
	}
	.frag-predicate {
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
	}

	.child-row {
		padding: 2px 6px 2px 24px;
		display: flex;
		align-items: baseline;
		gap: 4px;
		border-radius: 3px;
		transition: background 0.1s;
	}
	.child-row.highlighted {
		background: var(--accent-bg);
	}
	.child-content {
		display: flex;
		align-items: baseline;
		gap: 4px;
		flex: 1;
		cursor: pointer;
	}
	.child-subject {
		font-size: 13px;
		color: var(--accent);
		flex-shrink: 0;
	}
	.child-predicate {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.edit-row {
		display: flex;
		gap: 3px;
	}
	.edit-subject {
		width: 55px;
		border: 1px solid #c7d2fe;
		border-radius: 4px;
		padding: 2px 5px;
		font-size: 12px;
		font-family: inherit;
		font-weight: 600;
		outline: none;
		color: var(--accent-subject);
	}
	.edit-label {
		flex: 1;
		border: 1px solid #c7d2fe;
		border-radius: 4px;
		padding: 2px 5px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
		color: var(--text);
	}
	.edit-subject.small {
		width: 45px;
		font-size: 11px;
		padding: 1px 4px;
		color: var(--accent);
	}
	.edit-label.small {
		font-size: 12px;
		padding: 1px 4px;
		color: #374151;
	}
	.edit-actions {
		display: flex;
		gap: 4px;
	}
	.save-btn {
		font-size: 11px;
		padding: 2px 10px;
		border-radius: 4px;
		border: none;
		background: #6366f1;
		color: white;
		cursor: pointer;
		font-family: inherit;
	}
	.cancel-btn {
		font-size: 11px;
		padding: 2px 10px;
		border-radius: 4px;
		border: 1px solid #e5e7eb;
		background: white;
		color: #6b7280;
		cursor: pointer;
		font-family: inherit;
	}
	.check-btn {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		border: none;
		background: #6366f1;
		color: white;
		cursor: pointer;
	}
	.child-edit {
		display: flex;
		gap: 3px;
		align-items: center;
		flex: 1;
	}
	/* Fragment actions */
	.frag-actions {
		display: flex;
		gap: 2px;
		margin-left: auto;
		flex-shrink: 0;
		opacity: 0.5;
		transition: opacity 0.15s;
	}
	.fragment-row:hover .frag-actions,
	.child-row:hover .frag-actions {
		opacity: 1;
	}
	.fragment-content {
		display: flex;
		align-items: baseline;
		gap: 5px;
		flex-wrap: nowrap;
	}
	.grip-handle {
		cursor: grab;
		color: var(--text-faint);
		flex-shrink: 0;
		padding: 2px;
	}
	.grip-handle:active {
		cursor: grabbing;
	}
	.frag-clickable {
		display: flex;
		align-items: baseline;
		gap: 5px;
		flex: 1;
		cursor: pointer;
		min-width: 0;
	}
	.frag-action-btn {
		width: 20px;
		height: 20px;
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		border-radius: 3px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.frag-action-btn:hover {
		background: var(--bg-hover);
		color: var(--accent);
	}
	.frag-action-btn.danger:hover {
		color: var(--diff-removed-color);
	}

	/* Alternatives carousel */
	.alts-carousel {
		display: flex;
		gap: 6px;
		padding: 6px 6px 6px 20px;
		overflow-x: auto;
		align-items: center;
	}
	.alts-loading {
		font-size: 11px;
		color: var(--text-faint);
		padding: 4px;
	}
	.alt-card {
		flex-shrink: 0;
		padding: 5px 8px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		cursor: pointer;
		background: var(--bg);
		transition: border-color 0.1s;
	}
	.alt-card:hover {
		border-color: var(--accent);
		background: var(--accent-bg);
	}
	.alt-subject {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent-subject);
		display: block;
	}
	.alt-predicate {
		font-size: 11px;
		color: var(--text-secondary);
	}
	.alt-close {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Pin words */
	.predicate-chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		border-radius: 4px;
		padding: 0 1px;
	}
	.predicate-chip:hover {
		background: var(--bg-hover);
	}
	.predicate-chip.pinned .predicate-word {
		font-weight: 700;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 2px;
	}
	.predicate-chip.child {
		gap: 1px;
	}
	.predicate-word {
		border-radius: 2px;
		padding: 0 1px;
	}
	.pin-word-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		border-radius: 999px;
		padding: 0;
		opacity: 0.45;
	}
	.predicate-chip:hover .pin-word-btn,
	.pin-word-btn.active {
		opacity: 1;
	}
	.pin-word-btn.active {
		color: var(--accent);
	}
	.pin-word-btn:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
	}

	/* Add atom */
	.add-atom-form.bottom {
		border-top: 1px solid var(--border-light);
	}
	.add-atom-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 10px 12px;
		border-radius: 0;
		border: none;
		border-top: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-faint);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		width: 100%;
		justify-content: center;
		flex-shrink: 0;
	}
	.add-atom-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-bg);
	}
	.add-child-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px 3px 24px;
		background: none;
		border: none;
		color: var(--text-faint);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
	}
	.add-child-btn:hover {
		color: var(--accent);
	}
	.add-atom-form {
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.add-atom-form.child-add {
		padding-left: 24px;
	}
	.add-input {
		border: 1px solid var(--accent-light);
		border-radius: 5px;
		padding: 5px 8px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
		color: var(--text);
		background: var(--bg);
	}
	.add-input:focus {
		border-color: var(--accent);
	}
	.add-actions {
		display: flex;
		gap: 4px;
	}
	.add-confirm {
		font-size: 12px;
		padding: 4px 12px;
		border-radius: 5px;
		border: none;
		background: var(--accent);
		color: white;
		cursor: pointer;
		font-family: inherit;
	}
	.add-cancel {
		font-size: 12px;
		padding: 4px 12px;
		border-radius: 5px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text-muted);
		cursor: pointer;
		font-family: inherit;
	}
</style>
