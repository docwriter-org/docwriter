<script lang="ts">
	import { X as XIcon } from 'lucide-svelte';
	import AtomNode from './AtomNode.svelte';
	import { reproject } from '$lib/runtime-canonical';
	import type { Fragment, Section } from '$lib/types';
	import { ATOM_CONSTRAINTS, TRANSITIONS } from '$lib/types';
	import { blocks, atoms, fragments, highlightedFrags, highlightedSents, paraBreaks, prose, pushDocumentOp, pushHistory, rules, selectedModel, showHistory, sections } from '$lib/stores';

	let fragList: Fragment[] = $state([]);
	fragments.subscribe((v) => (fragList = v));


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
		if (title) {
			// Find the heading block that corresponds to this section
			const section = sectionList.find((s) => s.beforeAtomIndex === idx);
			if (section) {
				const headingBlock = currentBlocks.find((b) => b.type === 'heading' && (b as import('$lib/atomz').AtomzHeadingBlock).text === section.title);
				if (headingBlock) {
					const nextBlocks = currentBlocks.map((b) =>
						b.id === headingBlock.id ? { ...b, text: title } : b
					);
					blocks.set(nextBlocks);
					reproject();
				}
			}
			pushDocumentOp({
				type: 'update_blocks',
				blocks: currentBlocks,
				source: 'structure'
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

	let currentProse: typeof $prose = $state([]);
	prose.subscribe((v) => (currentProse = v));

	let currentRules = $state<typeof $rules>([]);
	rules.subscribe((v) => (currentRules = v));

	let currentBlocks = $state<import('$lib/atomz').AtomzBlock[]>([]);
	blocks.subscribe((v) => (currentBlocks = v));




	function cloneSections(sectionListToClone: Section[]): Section[] {
		return sectionListToClone.map((section) => ({ ...section }));
	}

	function setTransition(fragId: string, value: string) {
		let subject = '', predicate = '';
		const old = findAtomInTree(fragList, fragId);
		subject = old?.subject || '';
		predicate = old?.predicate || '';
		fragments.update((fs) => updateAtomInTree(fs, fragId, (a) => ({
			...a, transition: value || undefined
		})));
		reproject();
		pushDocumentOp({
			type: 'edit_atom',
			fragId,
			subject,
			predicate
		});
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Set transition on atom ${fragId} to "${value || 'none'}"`
		});
	}

	function startEdit(id: string, predicate: string, subject: string) {
		editingId = id;
		editPredicate = predicate;
		editSubject = subject;
	}

	/** Recursively find an atom by ID in the tree */
	function findAtomInTree(list: Fragment[], id: string): Fragment | null {
		for (const f of list) {
			if (f.id === id) return f;
			const found = findAtomInTree(f.children || [], id);
			if (found) return found;
		}
		return null;
	}

	/** Recursively update an atom by ID */
	function updateAtomInTree(list: Fragment[], id: string, updater: (a: Fragment) => Fragment): Fragment[] {
		return list.map((f) => {
			if (f.id === id) return updater(f);
			return { ...f, children: updateAtomInTree(f.children || [], id, updater) };
		});
	}

	function saveEdit(parentId: string | null) {
		const changedId = editingId!;
		const old = findAtomInTree(fragList, changedId);
		const oldSubject = old?.subject || '';
		const oldPredicate = old?.predicate || '';

		fragments.update((fs) => updateAtomInTree(fs, changedId, (a) => ({
			...a, subject: editSubject, predicate: editPredicate
		})));
		editingId = null;
		reproject();

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

	/** Unified reorder — works at any depth */
	function handleReorder(atomId: string, fromIndex: number, toIndex: number, parentId: string | null) {
		if (parentId) {
			fragments.update((fs) => updateAtomInTree(fs, parentId, (parent) => {
				const kids = [...(parent.children || [])];
				const [moved] = kids.splice(fromIndex, 1);
				kids.splice(toIndex, 0, moved);
				return { ...parent, children: kids };
			}));
		} else {
			fragments.update((fs) => {
				const next = [...fs];
				const [m] = next.splice(fromIndex, 1);
				next.splice(toIndex, 0, m);
				return next;
			});
		}
		reproject();
		pushDocumentOp({
			type: 'reorder_atoms',
			atomId,
			fromIndex,
			toIndex,
			...(parentId ? { parentId } : {})
		});
	}

	function toggleBreak(i: number, add: boolean) {
		// Build a map from atom ID to top-level fragment index
		const atomToTopIdx = new Map<string, number>();
		fragList.forEach((f, idx) => {
			atomToTopIdx.set(f.id, idx);
			for (const c of f.children || []) atomToTopIdx.set(c.id, idx);
		});

		// Work with current blocks
		const nextBlocks = [...currentBlocks];

		if (add) {
			// Split: find the markdown block whose atomIds span across atom index i
			for (let bi = 0; bi < nextBlocks.length; bi++) {
				const block = nextBlocks[bi];
				if (block.type !== 'markdown') continue;
				const atomIndices = block.atomIds.map((aid) => atomToTopIdx.get(aid) ?? -1);
				const hasBeforeBreak = atomIndices.some((idx) => idx < i);
				const hasAtOrAfterBreak = atomIndices.some((idx) => idx >= i);
				if (hasBeforeBreak && hasAtOrAfterBreak) {
					// Split this block's atomIds
					const beforeIds = block.atomIds.filter((aid) => (atomToTopIdx.get(aid) ?? -1) < i);
					const afterIds = block.atomIds.filter((aid) => (atomToTopIdx.get(aid) ?? -1) >= i);
					// Keep the existing block for "before" atoms, create a new block for "after"
					nextBlocks[bi] = { ...block, atomIds: beforeIds, markdown: block.markdown };
					const newBlock: import('$lib/atomz').AtomzMarkdownBlock = {
						id: `block_markdown_split_${Date.now().toString(36)}`,
						type: 'markdown',
						markdown: '', // will be filled by agent render
						atomIds: afterIds
					};
					nextBlocks.splice(bi + 1, 0, newBlock);
					break;
				}
			}
		} else {
			// Merge: find two adjacent markdown blocks where the second starts at atom index i
			for (let bi = 0; bi < nextBlocks.length - 1; bi++) {
				const block = nextBlocks[bi];
				const nextBlock = nextBlocks[bi + 1];
				if (block.type !== 'markdown' || nextBlock.type !== 'markdown') continue;
				const nextAtomIndices = nextBlock.atomIds.map((aid) => atomToTopIdx.get(aid) ?? -1);
				if (nextAtomIndices.some((idx) => idx === i)) {
					// Merge nextBlock into block
					const merged: import('$lib/atomz').AtomzMarkdownBlock = {
						...block,
						atomIds: [...block.atomIds, ...nextBlock.atomIds],
						markdown: [block.markdown, nextBlock.markdown].filter(Boolean).join(' ')
					};
					nextBlocks.splice(bi, 2, merged);
					break;
				}
			}
		}

		blocks.set(nextBlocks);
		reproject();

		pushDocumentOp({
			type: 'update_blocks',
			blocks: nextBlocks,
			source: 'structure'
		});

		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `${add ? 'Added' : 'Removed'} paragraph break at position ${i}` });
	}

	// Add atom
	let addingAtom = $state(false);
	let addingChildOf: string | null = $state(null);
	let addSiblingParentId: string | null = $state(null);
	let newSubject = $state('');
	let newPredicate = $state('');
	let addAtIndex = $state(-1); // -1 = end

	function handleAddSibling(afterIndex: number, parentId: string | null) {
		addAtIndex = afterIndex;
		addSiblingParentId = parentId;
		addingChildOf = null;
		addingAtom = true;
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
		if (!newPredicate.trim()) return; // subject can be blank — agent will pick one
		const id = 'f' + Date.now().toString(36);
		const newFrag: Fragment = { id, subject: newSubject.trim(), predicate: newPredicate.trim(), children: [] };

		const insertIdx = addAtIndex >= 0 ? addAtIndex + 1 : -1;

		if (addingChildOf) {
			// Add as child of any atom at any depth
			fragments.update((fs) => updateAtomInTree(fs, addingChildOf!, (parent) => ({
				...parent, children: [...(parent.children || []), newFrag]
			})));
		} else if (addSiblingParentId) {
			// Add as sibling inside a parent's children
			fragments.update((fs) => updateAtomInTree(fs, addSiblingParentId!, (parent) => {
				const kids = [...(parent.children || [])];
				kids.splice(insertIdx, 0, newFrag);
				return { ...parent, children: kids };
			}));
		} else {
			// Add at top level
			const idx = insertIdx >= 0 ? insertIdx : fragList.length;
			fragments.update((fs) => {
				const next = [...fs];
				next.splice(idx, 0, newFrag);
				return next;
			});
		}
		reproject();

		const effectiveParentId = addingChildOf || addSiblingParentId || undefined;
		pushDocumentOp({
			type: 'add_atom',
			atom: { id, subject: newSubject.trim(), predicate: newPredicate.trim() },
			parentId: addingChildOf || undefined,
			index: addingChildOf ? -1 : insertIdx
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Added atom ${id}: ${newSubject.trim()} | ${newPredicate.trim()}` });
		addingAtom = false;
		addingChildOf = null;
		addSiblingParentId = null;
	}

	function cancelAddAtom() {
		addingAtom = false;
		addingChildOf = null;
	}

	// Delete atom (recursive — works at any depth)
	function removeAtomFromTree(list: Fragment[], id: string): Fragment[] {
		return list.filter((f) => f.id !== id).map((f) => ({
			...f, children: removeAtomFromTree(f.children || [], id)
		}));
	}

	function deleteAtom(id: string) {
		const old = findAtomInTree(fragList, id);
		const subject = old?.subject || '';
		const predicate = old?.predicate || '';
		fragments.update((fs) => removeAtomFromTree(fs, id));
		reproject();
		pushDocumentOp({
			type: 'delete_atom',
			atomId: id,
			subject,
			predicate
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
		fragments.update((fs) => updateAtomInTree(fs, fragId, (a) => ({
			...a, subject: alt.subject, predicate: alt.predicate
		})));
		reproject();
		pushDocumentOp({
			type: 'edit_atom',
			fragId,
			subject: alt.subject,
			predicate: alt.predicate
		});
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Adopted alternative for ${fragId}: ${alt.subject} | ${alt.predicate}` });
		alternativesFor = null;
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

			<AtomNode
				atom={f}
				depth={0}
				parentId={null}
				index={i}
				siblingCount={fragList.length}
				{editingId} {editSubject} {editPredicate}
				addingChildOf={addingChildOf}
				{newSubject} {newPredicate}
				{alternativesFor} {alternatives} {loadingAlts}
				onStartEdit={startEdit}
				onSaveEdit={saveEdit}
				onCancelEdit={() => (editingId = null)}
				onDelete={deleteAtom}
				onSetTransition={setTransition}
				onFetchAlternatives={fetchAlternatives}
				onAdoptAlternative={adoptAlternative}
				onStartAddChild={startAddChild}
				onConfirmAddChild={confirmAddAtom}
				onCancelAddChild={cancelAddAtom}
				onReorder={handleReorder}
				onBindNewSubject={(v) => (newSubject = v)}
				onBindNewPredicate={(v) => (newPredicate = v)}
				onBindEditSubject={(v) => (editSubject = v)}
				onBindEditPredicate={(v) => (editPredicate = v)}
			/>

			<!-- Hover zone to add top-level atom after this one -->
			{#if addingAtom && !addingChildOf && addAtIndex === i}
				<div class="add-inline-form">
					<textarea class="add-inline-input subject" bind:value={newSubject} placeholder="subject" onkeydown={(e) => e.key === 'Escape' && cancelAddAtom()} rows="1"></textarea>
					<textarea class="add-inline-input claim" bind:value={newPredicate} placeholder="what do you want to say?" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmAddAtom(); } if (e.key === 'Escape') cancelAddAtom(); }} rows="1"></textarea>
					<button class="add-inline-btn" onclick={confirmAddAtom}>Add</button>
					<button class="add-inline-btn cancel" onclick={cancelAddAtom}>Esc</button>
				</div>
			{:else}
				<div class="add-sibling-zone">
					<button class="add-sibling-btn" onclick={() => handleAddSibling(i, null)}>+</button>
				</div>
			{/if}
		{/each}

	</div>

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

	/* Top-level add sibling zone */
	.add-sibling-zone {
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.add-sibling-zone:hover { opacity: 1; }
	.add-sibling-btn {
		border: none;
		background: none;
		color: var(--accent);
		font-size: 20px;
		cursor: pointer;
		padding: 2px 12px;
		line-height: 1;
		font-family: inherit;
		opacity: 0.6;
	}
	.add-sibling-btn:hover { opacity: 1; }
	.add-inline-form {
		display: flex;
		gap: 6px;
		padding: 8px;
		align-items: stretch;
		background: var(--bg-hover, #f9fafb);
		border-radius: 6px;
		margin: 4px 0;
	}
	.add-inline-input {
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 14px;
		font-family: inherit;
		outline: none;
		resize: none;
		overflow: hidden;
		min-height: 38px;
		field-sizing: content;
		line-height: 1.4;
	}
	.add-inline-input.subject { width: 100px; flex-shrink: 0; }
	.add-inline-input.claim { flex: 1; }
	.add-inline-input:focus { border-color: var(--accent); }
	.add-inline-btn {
		border: none;
		background: var(--accent);
		color: white;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 12px;
		cursor: pointer;
		flex-shrink: 0;
		align-self: flex-start;
	}
	.add-inline-btn.cancel { background: transparent; color: var(--text-faint); }
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
