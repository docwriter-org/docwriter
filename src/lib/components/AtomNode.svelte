<script lang="ts">
	import AtomNode from './AtomNode.svelte';
	import { GripVertical, Plus, Trash2, Sparkles, Pencil, Pin } from 'lucide-svelte';
	import type { Atom } from '$lib/types';
	import { TRANSITIONS } from '$lib/types';
	import { highlightedFrags, highlightedSents, prose, agentChangedAtomIds } from '$lib/stores';

	const transitionWords = TRANSITIONS.filter(t => t !== '');

	interface Props {
		atom: Atom;
		depth: number;
		parentId: string | null;
		index: number;
		siblingCount: number;
		editingId: string | null;
		editSubject: string;
		editPredicate: string;
		addingChildOf: string | null;
		newSubject: string;
		newPredicate: string;
		alternativesFor: string | null;
		alternatives: Array<{ subject: string; predicate: string }>;
		loadingAlts: boolean;
		onStartEdit: (id: string, predicate: string, subject: string) => void;
		onSaveEdit: (parentId: string | null) => void;
		onCancelEdit: () => void;
		onDelete: (id: string) => void;
		onSetTransition: (id: string, value: string) => void;
		onFetchAlternatives: (atom: Atom) => void;
		onAdoptAlternative: (atomId: string, alt: { subject: string; predicate: string }) => void;
		onStartAddChild: (parentId: string) => void;
		onConfirmAddChild: () => void;
		onCancelAddChild: () => void;
		onReorder: (atomId: string, fromIndex: number, toIndex: number, parentId: string | null) => void;
		onBindNewSubject: (value: string) => void;
		onBindNewPredicate: (value: string) => void;
		onBindEditSubject: (value: string) => void;
		onBindEditPredicate: (value: string) => void;
	}

	let {
		atom, depth, parentId, index, siblingCount,
		editingId, editSubject, editPredicate,
		addingChildOf, newSubject, newPredicate,
		alternativesFor, alternatives, loadingAlts,
		onStartEdit, onSaveEdit, onCancelEdit, onDelete,
		onSetTransition, onFetchAlternatives, onAdoptAlternative,
		onStartAddChild, onConfirmAddChild, onCancelAddChild,
		onReorder, onBindNewSubject, onBindNewPredicate,
		onBindEditSubject, onBindEditPredicate
	}: Props = $props();

	let hlFrags: Set<string> = $state(new Set());
	highlightedFrags.subscribe((v) => (hlFrags = v));

	let currentProse: import('$lib/types').Sentence[] = $state([]);
	prose.subscribe((v) => (currentProse = v));

	let changedAtomIds: Set<string> = $state(new Set());
	agentChangedAtomIds.subscribe((v) => (changedAtomIds = v));

	// Drag state (local to siblings)
	let dragOver = $state(false);

	function getFragIds(atom: Atom): string[] {
		return [atom.id, ...(atom.children || []).flatMap(getFragIds)];
	}

	function handleHover() {
		const ids = new Set(getFragIds(atom));
		highlightedFrags.set(ids);
		const si = new Set<number>();
		currentProse.forEach((s, i) => {
			if (s.frags.some((fid) => ids.has(fid))) si.add(i);
		});
		highlightedSents.set(si);
	}

	function clearHL() {
		highlightedFrags.set(new Set());
		highlightedSents.set(new Set());
	}

	/** Split text into segments, marking pinned phrases */
	function segmentWithPins(text: string, pinnedWords?: string[]): Array<{ text: string; pinned: boolean }> {
		if (!pinnedWords?.length) return [{ text, pinned: false }];
		const sorted = [...pinnedWords].sort((a, b) => b.length - a.length);
		const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
		const parts = text.split(pattern);
		return parts.filter((p) => p.length > 0).map((p) => ({
			text: p,
			pinned: sorted.some((w) => p.toLowerCase() === w.toLowerCase())
		}));
	}

	function handleDragStart(e: DragEvent) {
		e.dataTransfer?.setData('text/plain', JSON.stringify({ atomId: atom.id, fromIndex: index, parentId }));
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		try {
			const data = JSON.parse(e.dataTransfer?.getData('text/plain') || '{}');
			if (data.atomId && data.parentId === parentId && data.fromIndex !== index) {
				onReorder(data.atomId, data.fromIndex, index, parentId);
			}
		} catch {}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="atom-node"
	class:highlighted={hlFrags.has(atom.id)}
	class:drop-target={dragOver}
	class:agent-edited={changedAtomIds.has(atom.id)}
	style="padding-left: {depth * 20}px"
	draggable={editingId !== atom.id}
	ondragstart={handleDragStart}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	ondragend={() => (dragOver = false)}
	onmouseenter={handleHover}
	onmouseleave={clearHL}
>
	{#if editingId === atom.id}
		<div class="atom-edit">
			<input
				class="edit-input subject"
				value={editSubject}
				oninput={(e) => onBindEditSubject(e.currentTarget.value)}
				placeholder="subject"
			/>
			<input
				class="edit-input predicate"
				value={editPredicate}
				oninput={(e) => onBindEditPredicate(e.currentTarget.value)}
				onkeydown={(e) => { if (e.key === 'Enter') onSaveEdit(parentId); if (e.key === 'Escape') onCancelEdit(); }}
				placeholder="claim"
			/>
			<button class="edit-btn save" onclick={() => onSaveEdit(parentId)}>Save</button>
			<button class="edit-btn cancel" onclick={onCancelEdit}>Esc</button>
		</div>
	{:else}
		<div class="atom-row">
			<span class="grip"><GripVertical size={11} /></span>
			<select
				class="transition-select"
				class:has-value={!!atom.transition}
				value={atom.transition || ''}
				onchange={(e) => onSetTransition(atom.id, e.currentTarget.value)}
				onclick={(e) => e.stopPropagation()}
			>
				<option value="">···</option>
				{#each transitionWords as tw}
					<option value={tw}>{tw}</option>
				{/each}
			</select>
			<span class="atom-text">
				<span class="atom-subject">{atom.subject}</span>
				<span class="atom-predicate">{#each segmentWithPins(atom.predicate, atom.pinnedWords) as seg}{#if seg.pinned}<span class="pinned-text"><span class="pin-icon"><Pin size={8} /></span>{seg.text}</span>{:else}{seg.text}{/if}{/each}</span>
			</span>
			<span class="atom-actions">
				<button class="action-btn" title="Add sub-atom" onclick={(e) => { e.stopPropagation(); onStartAddChild(atom.id); }}>
					<Plus size={11} />
				</button>
				<button class="action-btn" title="Edit" onclick={(e) => { e.stopPropagation(); onStartEdit(atom.id, atom.predicate, atom.subject); }}>
					<Pencil size={11} />
				</button>
				<button class="action-btn" title="Alternatives" onclick={(e) => { e.stopPropagation(); onFetchAlternatives(atom); }}>
					<Sparkles size={11} />
				</button>
				<button class="action-btn danger" title="Delete" onclick={(e) => { e.stopPropagation(); onDelete(atom.id); }}>
					<Trash2 size={11} />
				</button>
			</span>
		</div>

		{#if alternativesFor === atom.id}
			<div class="alts-carousel" style="padding-left: {depth * 20 + 20}px">
				{#if loadingAlts}
					<span class="alts-loading">Generating alternatives...</span>
				{:else}
					{#each alternatives as alt}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="alt-card" onclick={() => onAdoptAlternative(atom.id, alt)}>
							<span class="alt-subject">{alt.subject}</span>
							<span class="alt-predicate">{alt.predicate}</span>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Children (recursive) with hover-add zones between them -->
{#each atom.children || [] as child, ci}
	<AtomNode
		atom={child}
		depth={depth + 1}
		parentId={atom.id}
		index={ci}
		siblingCount={(atom.children || []).length}
		{editingId} {editSubject} {editPredicate}
		{addingChildOf} {newSubject} {newPredicate}
		{alternativesFor} {alternatives} {loadingAlts}
		{onStartEdit} {onSaveEdit} {onCancelEdit} {onDelete}
		{onSetTransition} {onFetchAlternatives} {onAdoptAlternative}
		{onStartAddChild} {onConfirmAddChild} {onCancelAddChild}
		{onReorder} {onBindNewSubject} {onBindNewPredicate}
		{onBindEditSubject} {onBindEditPredicate}
	/>
{/each}

<!-- Add child (hover-only +, or form if actively adding) -->
{#if addingChildOf === atom.id}
	<div class="add-form" style="padding-left: {(depth + 1) * 20}px">
		<textarea
			class="add-input subject"
			value={newSubject}
			oninput={(e) => onBindNewSubject(e.currentTarget.value)}
			placeholder="subject"
			rows="1"
		></textarea>
		<textarea
			class="add-input claim"
			value={newPredicate}
			oninput={(e) => onBindNewPredicate(e.currentTarget.value)}
			onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onConfirmAddChild(); } if (e.key === 'Escape') onCancelAddChild(); }}
			placeholder="what do you want to say?"
			rows="1"
		></textarea>
		<button class="add-btn" onclick={onConfirmAddChild}>Add</button>
		<button class="add-btn cancel" onclick={onCancelAddChild}>Esc</button>
	</div>
{/if}


<style>
	.atom-node {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 4px;
		border-radius: 4px;
		min-height: 28px;
		border: 1px solid transparent;
	}
	.atom-node.highlighted {
		background: var(--accent-bg, #f0eeff);
	}
	.atom-node.agent-edited {
		background: color-mix(in srgb, #10b981 12%, transparent);
		box-shadow: 0 0 12px color-mix(in srgb, #10b981 20%, transparent);
		position: relative;
		animation: agent-atom-fade 5s ease-out forwards;
	}
	.atom-node.agent-edited::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		width: 3px;
		height: 100%;
		background: #10b981;
		border-radius: 2px;
		animation: agent-cursor-fade 5s ease-out forwards;
	}
	@keyframes agent-atom-fade {
		0% { background: color-mix(in srgb, #10b981 15%, transparent); box-shadow: 0 0 12px color-mix(in srgb, #10b981 25%, transparent); }
		70% { background: color-mix(in srgb, #10b981 8%, transparent); box-shadow: 0 0 6px color-mix(in srgb, #10b981 12%, transparent); }
		100% { background: transparent; box-shadow: none; }
	}
	@keyframes agent-cursor-fade {
		0% { opacity: 1; }
		70% { opacity: 0.5; }
		100% { opacity: 0; }
	}
	.atom-node.drop-target {
		border-color: var(--accent, #7c3aed);
	}
	.atom-row {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}
	.grip {
		color: var(--text-faint, #ccc);
		cursor: grab;
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}
	.grip:active { cursor: grabbing; }
	.transition-select {
		border: none;
		background: transparent;
		color: var(--text-faint, #999);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		padding: 0;
		outline: none;
		-webkit-appearance: none;
		appearance: none;
		flex-shrink: 0;
		width: 18px;
	}
	.transition-select.has-value {
		width: auto;
		max-width: 56px;
		color: #0891b2;
		font-weight: 600;
	}
	.transition-select:hover { color: var(--text-muted, #666); background: var(--bg-hover, #f5f5f5); border-radius: 3px; }
	.atom-text {
		display: flex;
		align-items: baseline;
		gap: 5px;
		flex: 1;
		min-width: 0;
		user-select: text;
		cursor: default;
		font-size: 13px;
		line-height: 1.4;
	}
	.atom-subject {
		font-weight: 600;
		color: var(--accent, #7c3aed);
		flex-shrink: 0;
	}
	.atom-predicate {
		color: var(--text, #1a1a1a);
	}
	.pinned-text {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		background: color-mix(in srgb, var(--accent, #7c3aed) 12%, transparent);
		border-radius: 3px;
		padding: 1px 3px;
		box-shadow: 0 0 8px color-mix(in srgb, var(--accent, #7c3aed) 25%, transparent);
	}
	.pin-icon {
		display: inline-flex;
		color: var(--accent, #7c3aed);
		opacity: 0.6;
		flex-shrink: 0;
	}
	.atom-actions {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.atom-node:hover .atom-actions { opacity: 1; }
	.action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: var(--text-faint, #999);
		cursor: pointer;
		border-radius: 4px;
		padding: 0;
	}
	.action-btn:hover { background: var(--bg-hover, #f5f5f5); color: var(--text-muted, #666); }
	.action-btn.danger:hover { color: #ef4444; }

	/* Edit mode */
	.atom-edit {
		display: flex;
		gap: 4px;
		flex: 1;
		align-items: center;
	}
	.edit-input {
		border: 1px solid var(--border-light, #e5e7eb);
		border-radius: 4px;
		padding: 3px 6px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
	}
	.edit-input:focus { border-color: var(--accent, #7c3aed); }
	.edit-input.subject { width: 80px; font-weight: 600; flex-shrink: 0; }
	.edit-input.predicate { flex: 1; }
	.edit-btn {
		border: none;
		background: var(--accent, #7c3aed);
		color: white;
		border-radius: 4px;
		padding: 3px 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.edit-btn.cancel { background: transparent; color: var(--text-faint, #999); }

	/* Alternatives carousel */
	.alts-carousel {
		display: flex;
		gap: 6px;
		padding: 4px 0;
		overflow-x: auto;
	}
	.alts-loading { font-size: 12px; color: var(--text-faint, #999); }
	.alt-card {
		border: 1px solid var(--border-light, #e5e7eb);
		border-radius: 6px;
		padding: 6px 10px;
		cursor: pointer;
		flex-shrink: 0;
		font-size: 12px;
	}
	.alt-card:hover { border-color: var(--accent, #7c3aed); }
	.alt-subject { font-weight: 600; color: var(--accent, #7c3aed); margin-right: 4px; }
	.alt-predicate { color: var(--text, #1a1a1a); }

	/* Add child */
	.add-child-trigger {
		border: none;
		background: none;
		color: var(--text-faint, #999);
		font-size: 11px;
		cursor: pointer;
		padding: 2px 4px;
		font-family: inherit;
	}
	.add-child-trigger:hover { color: var(--accent, #7c3aed); }
	.add-form {
		display: flex;
		gap: 6px;
		align-items: stretch;
		background: color-mix(in srgb, var(--accent, #7c3aed) 4%, transparent);
		border-radius: 6px;
		margin: 4px 0;
		padding: 8px;
	}
	.add-input {
		border: 1px solid var(--border-light, #e5e7eb);
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
	.add-input.subject { width: 100px; flex-shrink: 0; }
	.add-input.claim { flex: 1; }
	.add-input:focus { border-color: var(--accent, #7c3aed); }
	.add-btn {
		border: none;
		background: var(--accent, #7c3aed);
		color: white;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 12px;
		cursor: pointer;
		flex-shrink: 0;
		align-self: flex-start;
	}
	.add-btn.cancel { background: transparent; color: var(--text-faint, #999); }
</style>
