<script lang="ts" module>
	export interface FileEntry {
		name: string;
		kind: 'file' | 'folder';
		path: string;
		watched: boolean;
		internal: boolean;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Folder,
		FolderOpen,
		FileText,
		FileCode,
		FileJson,
		FileCog,
		ChevronRight,
		FilePlus2,
		FolderPlus
	} from 'lucide-svelte';
	import { authFetch } from '$lib/auth-recovery';
	import { showAlert, showConfirm } from '$lib/dialogs';

	interface Props {
		/** Fires when the user clicks a file (not a folder). */
		onOpenFile?: (entry: FileEntry) => void;
		/** Path of the currently-active file — styled highlighted in the tree. */
		activePath?: string | null;
		/** Called after a successful rename (old path → new path). Lets the
		 * host update any open tabs that pointed at the renamed file. */
		onRenamed?: (fromPath: string, toPath: string) => void;
		/** Called after a successful delete. Host can close any open tab. */
		onDeleted?: (path: string) => void;
		/** Called when the user drops files from Finder / the filesystem onto
		 * a folder (or the workspace root). `targetFolder` is the workspace-
		 * relative folder path, or '' for the root. */
		onDropExternalFiles?: (files: File[], targetFolder: string) => Promise<void>;
	}
	let { onOpenFile, activePath, onRenamed, onDeleted, onDropExternalFiles }: Props = $props();

	/** Per-path state: expanded flag + lazily-loaded child entries. */
	const nodeState = $state<
		Record<string, { expanded: boolean; children?: FileEntry[]; loading: boolean }>
	>({
		'': { expanded: true, loading: false }
	});
	let rootEntries = $state<FileEntry[] | null>(null);
	let selectedPath = $state<string | null>(null);
	let createDraft = $state<{ parentPath: string; kind: 'file' | 'folder'; value: string } | null>(
		null
	);
	let treeEl: HTMLDivElement | null = $state(null);
	let createInput: HTMLInputElement | null = $state(null);
	let treeError = $state('');

	async function fetchEntries(path: string): Promise<FileEntry[]> {
		const res = await authFetch(`/api/files?path=${encodeURIComponent(path)}`, {
			credentials: 'same-origin'
		});
		if (!res.ok) {
			throw new Error(`Failed to load files (${res.status})`);
		}
		const data = await res.json();
		return Array.isArray(data.entries) ? data.entries : [];
	}

	async function loadRoot() {
		try {
			rootEntries = await fetchEntries('');
			treeError = '';
		} catch (e) {
			treeError = e instanceof Error ? e.message : String(e);
			if (rootEntries === null) rootEntries = [];
		}
	}

	function entryMetaFor(path: string) {
		return {
			watched: path === 'notes' || path.startsWith('notes/'),
			internal: path === '.docwriter' || path.startsWith('.docwriter/')
		};
	}

	async function toggleFolder(entry: FileEntry) {
		const cur = nodeState[entry.path] ?? { expanded: false, loading: false };
		if (cur.expanded) {
			nodeState[entry.path] = { ...cur, expanded: false };
			return;
		}
		// Opening: re-fetch so transient auth failures or provider-side
		// migrations cannot leave a folder cached as empty forever.
		nodeState[entry.path] = { ...cur, expanded: true, loading: true };
		try {
			const kids = await fetchEntries(entry.path);
			nodeState[entry.path] = { expanded: true, loading: false, children: kids };
			treeError = '';
		} catch (e) {
			treeError = e instanceof Error ? e.message : String(e);
			nodeState[entry.path] = { ...cur, expanded: true, loading: false };
		}
	}

	/** Pick a lucide icon based on filename. */
	function iconFor(name: string, internal: boolean) {
		if (internal && name.endsWith('.json')) return FileCog;
		if (name.endsWith('.json')) return FileJson;
		if (/\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|html|css|sh|sql|xml)$/.test(name))
			return FileCode;
		return FileText;
	}

	onMount(() => void loadRoot());

	/** Re-fetch the root list and every currently-expanded folder. Called
	 * from the parent when something outside the FileTree (typically the
	 * agent creating a file) might have changed the workspace contents.
	 * Cheap because we only re-fetch what's visible. */
	export async function refresh(): Promise<void> {
		const expandedPaths = Object.keys(nodeState).filter(
			(p) => p !== '' && nodeState[p]?.expanded
		);
		try {
			rootEntries = await fetchEntries('');
			treeError = '';
		} catch (e) {
			treeError = e instanceof Error ? e.message : String(e);
		}
		await Promise.all(
			expandedPaths.map(async (p) => {
				const cur = nodeState[p];
				if (!cur) return;
				try {
					const kids = await fetchEntries(p);
					nodeState[p] = { ...cur, children: kids, loading: false };
					treeError = '';
				} catch (e) {
					treeError = e instanceof Error ? e.message : String(e);
					nodeState[p] = { ...cur, loading: false };
				}
			})
		);
	}

	$effect(() => {
		if (!createDraft) return;
		setTimeout(() => {
			createInput?.focus();
			createInput?.select();
		}, 0);
	});

	// ── Context menu ──────────────────────────────────────────────────
	/** Active right-click menu target + its screen coords. */
	let menu = $state<{ entry: FileEntry; x: number; y: number } | null>(null);
	let menuEl = $state<HTMLElement | null>(null);

	$effect(() => {
		const el = menuEl;
		if (!el) return;
		requestAnimationFrame(() => {
			const r = el.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			if (r.right > vw - 4) el.style.left = `${Math.max(4, vw - r.width - 4)}px`;
			if (r.bottom > vh - 4) el.style.top = `${Math.max(4, vh - r.height - 4)}px`;
		});
	});

	function openMenu(e: MouseEvent, entry: FileEntry) {
		e.preventDefault();
		e.stopPropagation();
		selectedPath = entry.path;
		menu = { entry, x: e.clientX, y: e.clientY };
	}

	function closeMenu() {
		menu = null;
	}

	$effect(() => {
		if (!menu) return;
		function onDown(e: MouseEvent) {
			// Close if click lands outside the menu.
			const t = e.target as Element | null;
			if (!t?.closest('.file-tree-menu')) closeMenu();
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') closeMenu();
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	$effect(() => {
		function onDocumentMouseDown(e: MouseEvent) {
			const target = e.target as Element | null;
			if (!target) return;
			if (treeEl?.contains(target)) return;
			if (target.closest('.file-tree-menu')) return;
			selectedPath = null;
		}
		document.addEventListener('mousedown', onDocumentMouseDown);
		return () => document.removeEventListener('mousedown', onDocumentMouseDown);
	});

	/** Reload the children of a folder that's already expanded. Used after
	 * create/rename/delete inside that folder. Finds the deepest cached
	 * ancestor of `path` and re-fetches its children. */
	async function refreshFolder(folderPath: string) {
		if (folderPath === '') {
			try {
				rootEntries = await fetchEntries('');
				treeError = '';
			} catch (e) {
				treeError = e instanceof Error ? e.message : String(e);
			}
			return;
		}
		const state = nodeState[folderPath];
		if (state?.expanded) {
			nodeState[folderPath] = { ...state, loading: true };
			try {
				const kids = await fetchEntries(folderPath);
				nodeState[folderPath] = { expanded: true, loading: false, children: kids };
				treeError = '';
			} catch (e) {
				treeError = e instanceof Error ? e.message : String(e);
				nodeState[folderPath] = { ...state, loading: false };
			}
		}
	}

	function parentOf(path: string): string {
		const idx = path.lastIndexOf('/');
		return idx < 0 ? '' : path.slice(0, idx);
	}

	async function doRename(entry: FileEntry) {
		closeMenu();
		const oldBase = entry.name;
		const next = window.prompt(`Rename "${entry.path}" to:`, oldBase);
		if (!next || next.trim() === '' || next.trim() === oldBase) return;
		const parent = parentOf(entry.path);
		const toPath = parent ? `${parent}/${next.trim()}` : next.trim();
		try {
			const res = await authFetch('/api/files', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: entry.path, to: toPath })
			});
			if (!res.ok) throw new Error(await res.text());
			await refreshFolder(parent);
			onRenamed?.(entry.path, toPath);
		} catch (e) {
			await showAlert(e instanceof Error ? e.message : String(e), { title: 'Rename failed' });
		}
	}

	async function doDelete(entry: FileEntry) {
		closeMenu();
		const ok = await showConfirm(
			`Delete "${entry.path}"?\n\nThis permanently removes ${
				entry.kind === 'folder' ? 'the folder and all its contents' : 'the file'
			} from disk. You won't be able to recover it.`,
			{ title: 'Delete', confirmLabel: 'Delete', danger: true }
		);
		if (!ok) return;
		try {
			const res = await authFetch(
				`/api/files?path=${encodeURIComponent(entry.path)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error(await res.text());
			await refreshFolder(parentOf(entry.path));
			onDeleted?.(entry.path);
		} catch (e) {
			await showAlert(e instanceof Error ? e.message : String(e), { title: 'Delete failed' });
		}
	}

	async function doNewChild(entry: FileEntry, kind: 'file' | 'folder') {
		closeMenu();
		beginCreate(kind, entry.path);
	}

	function parentPathForSelection() {
		if (!selectedPath) return '';
		const selectedState = entryStateFor(selectedPath);
		if (selectedState?.kind === 'folder') return selectedPath;
		return parentOf(selectedPath);
	}

	function entryStateFor(path: string): { kind: 'file' | 'folder' } | null {
		const search = (entries: FileEntry[] | undefined | null): FileEntry | null => {
			if (!entries) return null;
			for (const entry of entries) {
				if (entry.path === path) return entry;
				const found = search(nodeState[entry.path]?.children);
				if (found) return found;
			}
			return null;
		};
		const found = search(rootEntries);
		return found ? { kind: found.kind } : null;
	}

	// ── Drag-and-drop move ──────────────────────────────────────────────
	/** Path of the entry currently being dragged. */
	let dragPath = $state<string | null>(null);
	/** Path of the folder currently being hovered as a drop target.
	 *  Empty string '' = the workspace root. null = no active target. */
	let dragOverPath = $state<string | null>(null);

	function onDragStart(e: DragEvent, entry: FileEntry) {
		dragPath = entry.path;
		e.dataTransfer?.setData('text/plain', entry.path);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onDragEnd() {
		dragPath = null;
		dragOverPath = null;
	}

	function resolveDropFolder(entry: FileEntry): string {
		return entry.kind === 'folder' ? entry.path : parentOf(entry.path);
	}

	function isValidDrop(targetFolder: string): boolean {
		if (dragPath === null) return false;
		if (dragPath === targetFolder) return false;
		if (targetFolder.startsWith(dragPath + '/')) return false;
		if (parentOf(dragPath) === targetFolder) return false;
		return true;
	}

	/** True when the event carries files from outside the browser (Finder
	 * / filesystem) and no internal drag is in progress. */
	function isExternalFileDrop(e: DragEvent): boolean {
		return dragPath === null && (e.dataTransfer?.types.includes('Files') ?? false);
	}

	function onDragOverEntry(e: DragEvent, entry: FileEntry) {
		const target = resolveDropFolder(entry);
		if (isExternalFileDrop(e)) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			dragOverPath = entry.kind === 'folder' ? entry.path : null;
			return;
		}
		if (!isValidDrop(target)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverPath = target;
	}

	function onDragOverRoot(e: DragEvent) {
		if (isExternalFileDrop(e)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			if (dragOverPath === null) dragOverPath = '';
			return;
		}
		if (!isValidDrop('')) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverPath = '';
	}

	function onDragLeave(e: DragEvent) {
		const related = e.relatedTarget as Element | null;
		if (!related?.closest?.('.file-tree')) dragOverPath = null;
	}

	function onDropEntry(e: DragEvent, entry: FileEntry) {
		e.preventDefault();
		e.stopPropagation();
		const target = resolveDropFolder(entry);
		dragOverPath = null;
		if (isExternalFileDrop(e) && e.dataTransfer?.files.length) {
			const files = [...e.dataTransfer.files];
			const folder = entry.kind === 'folder' ? entry.path : parentOf(entry.path);
			dragPath = null;
			void onDropExternalFiles?.(files, folder);
			return;
		}
		if (!isValidDrop(target)) return;
		const src = dragPath!;
		dragPath = null;
		void doMove(src, target);
	}

	function onDropRoot(e: DragEvent) {
		e.preventDefault();
		dragOverPath = null;
		if (isExternalFileDrop(e) && e.dataTransfer?.files.length) {
			const files = [...e.dataTransfer.files];
			dragPath = null;
			void onDropExternalFiles?.(files, '');
			return;
		}
		if (!isValidDrop('')) return;
		const src = dragPath!;
		dragPath = null;
		void doMove(src, '');
	}

	async function doMove(from: string, toFolder: string) {
		const name = from.split('/').pop()!;
		const to = toFolder ? `${toFolder}/${name}` : name;
		try {
			const res = await authFetch('/api/files', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from, to })
			});
			if (!res.ok) throw new Error(await res.text());
			await refreshFolder(parentOf(from));
			if (toFolder !== parentOf(from)) await refreshFolder(toFolder);
			if (selectedPath === from) selectedPath = to;
			onRenamed?.(from, to);
		} catch (e) {
			await showAlert(e instanceof Error ? e.message : String(e), { title: 'Move failed' });
		}
	}

	// ── Deselect on background click ────────────────────────────────────
	function onTreePointerDown(e: MouseEvent) {
		const target = e.target as Element | null;
		if (!target?.closest('.tree-row')) selectedPath = null;
	}

	function beginCreate(kind: 'file' | 'folder', forcedParentPath: string | null = null) {
		const parentPath = forcedParentPath ?? parentPathForSelection();
		if (parentPath) {
			const cur = nodeState[parentPath] ?? { expanded: false, loading: false };
			nodeState[parentPath] = { ...cur, expanded: true };
		}
		createDraft = { parentPath, kind, value: '' };
	}

	function cancelCreate() {
		createDraft = null;
	}

	async function commitCreate() {
		if (!createDraft) return;
		const { parentPath, kind } = createDraft;
		const name = createDraft.value.trim();
		if (!name) {
			cancelCreate();
			return;
		}
		const newPath = parentPath ? `${parentPath}/${name}` : name;
		try {
			const res = await authFetch('/api/files', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: newPath, kind })
			});
			if (!res.ok) throw new Error(await res.text());
			createDraft = null;
			if (parentPath) {
				// Force the folder to be expanded and reload its children.
				const cur = nodeState[parentPath] ?? { expanded: false, loading: false };
				nodeState[parentPath] = { ...cur, expanded: true };
				await refreshFolder(parentPath);
			} else {
				await loadRoot();
			}
			if (kind === 'file') {
				const meta = entryMetaFor(newPath);
				selectedPath = newPath;
				onOpenFile?.({
					name,
					kind: 'file',
					path: newPath,
					...meta
				});
			}
		} catch (e) {
			await showAlert(e instanceof Error ? e.message : String(e), { title: 'Create failed' });
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={treeEl}
	class="file-tree"
	onmousedown={onTreePointerDown}
	ondragover={onDragOverRoot}
	ondragleave={onDragLeave}
	ondrop={onDropRoot}
>
	<div class="tree-header-row">
		<div class="tree-header">Files</div>
		<div class="tree-actions">
			<button class="tree-action-btn" title="New file" onclick={() => beginCreate('file')}>
				<FilePlus2 size={13} />
			</button>
			<button
				class="tree-action-btn"
				title="New folder"
				onclick={() => beginCreate('folder')}
			>
				<FolderPlus size={13} />
			</button>
		</div>
	</div>
	{#if treeError}
		<div class="tree-error">{treeError}</div>
	{/if}
	{#if rootEntries === null}
		<div class="tree-empty">Loading…</div>
	{:else if rootEntries.length === 0}
		<div class="tree-empty-block">
			<div class="tree-empty">Empty workspace.</div>
			<div class="tree-empty-actions">
				<button class="tree-empty-btn" onclick={() => beginCreate('file')}>New file</button>
				<button class="tree-empty-btn" onclick={() => beginCreate('folder')}>New folder</button>
			</div>
			{#if createDraft && createDraft.parentPath === ''}
				<ul class="tree-list">
					{@render draftNode(0)}
				</ul>
			{/if}
		</div>
	{:else}
		<ul class="tree-list" class:drag-over-root={dragOverPath === ''}>
			{#if createDraft && createDraft.parentPath === ''}
				{@render draftNode(0)}
			{/if}
			{#each rootEntries as entry (entry.path)}
				{@render node(entry, 0)}
			{/each}
		</ul>
	{/if}
</div>

{#if menu}
	<!-- Position: fixed so the menu floats above everything and doesn't
	     care about parent overflow. -->
	<div
		bind:this={menuEl}
		class="file-tree-menu"
		role="menu"
		style:left="{menu.x}px"
		style:top="{menu.y}px"
	>
		{#if menu.entry.kind === 'folder'}
			<button class="file-tree-menu-item" onclick={() => doNewChild(menu!.entry, 'file')}>
				New file…
			</button>
			<button class="file-tree-menu-item" onclick={() => doNewChild(menu!.entry, 'folder')}>
				New folder…
			</button>
			<div class="file-tree-menu-divider"></div>
		{/if}
		<button class="file-tree-menu-item" onclick={() => doRename(menu!.entry)}>
			Rename…
		</button>
		<button class="file-tree-menu-item danger" onclick={() => doDelete(menu!.entry)}>
			Delete
		</button>
	</div>
{/if}

{#snippet node(entry: FileEntry, depth: number)}
	{@const st = nodeState[entry.path]}
	{@const isActive = activePath === entry.path}
	{@const isSelected = selectedPath === entry.path}
	{@const isDragOver = dragOverPath === (entry.kind === 'folder' ? entry.path : parentOf(entry.path)) && dragOverPath !== null}
	{@const Icon = entry.kind === 'folder' ? (st?.expanded ? FolderOpen : Folder) : iconFor(entry.name, entry.internal)}
	<li>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="tree-row"
			class:active={isActive}
			class:selected={isSelected}
			class:watched={entry.watched}
			class:internal={entry.internal}
			class:drag-over={isDragOver && entry.kind === 'folder'}
			draggable="true"
			style:padding-left="{4 + depth * 14}px"
			onclick={() => {
				selectedPath = entry.path;
				if (entry.kind === 'folder') void toggleFolder(entry);
				else onOpenFile?.(entry);
			}}
			oncontextmenu={(e) => openMenu(e, entry)}
			ondragstart={(e) => onDragStart(e, entry)}
			ondragend={onDragEnd}
			ondragover={(e) => onDragOverEntry(e, entry)}
			ondragleave={onDragLeave}
			ondrop={(e) => onDropEntry(e, entry)}
			title={entry.path}
		>
			{#if entry.kind === 'folder'}
				<span class="chev" class:open={st?.expanded}><ChevronRight size={11} /></span>
			{:else}
				<span class="chev" aria-hidden="true"></span>
			{/if}
			<Icon size={13} />
			<span class="tree-name">{entry.name}</span>
		</div>
		{#if entry.kind === 'folder' && st?.expanded}
			{#if st.loading}
				<div class="tree-empty indented" style:padding-left="{18 + depth * 14}px">Loading…</div>
			{:else if st.children && st.children.length > 0}
				<ul class="tree-list">
					{#if createDraft && createDraft.parentPath === entry.path}
						{@render draftNode(depth + 1)}
					{/if}
					{#each st.children as child (child.path)}
						{@render node(child, depth + 1)}
					{/each}
				</ul>
			{:else}
				{#if createDraft && createDraft.parentPath === entry.path}
					<ul class="tree-list">
						{@render draftNode(depth + 1)}
					</ul>
				{:else}
					<div class="tree-empty indented" style:padding-left="{18 + depth * 14}px">
						(empty)
					</div>
				{/if}
			{/if}
		{/if}
	</li>
{/snippet}

{#snippet draftNode(depth: number)}
	{@const DraftIcon = createDraft?.kind === 'folder' ? Folder : FileText}
	<li>
		<div class="tree-row draft" style:padding-left="{4 + depth * 14}px">
			<span class="chev" aria-hidden="true"></span>
			<DraftIcon size={13} />
			<input
				class="tree-inline-input"
				bind:this={createInput}
				bind:value={createDraft!.value}
				placeholder={createDraft?.kind === 'folder' ? 'New folder' : 'New file'}
				onblur={commitCreate}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void commitCreate();
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						cancelCreate();
					}
				}}
			/>
		</div>
	</li>
{/snippet}

<style>
	.file-tree {
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.tree-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.tree-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
	}
	.tree-actions {
		display: flex;
		gap: 4px;
	}
	.tree-action-btn,
	.tree-empty-btn {
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-secondary);
		border-radius: 5px;
		cursor: pointer;
		font: inherit;
	}
	.tree-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
	}
	.tree-action-btn:hover,
	.tree-empty-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tree-empty-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.tree-empty-actions {
		display: flex;
		gap: 6px;
	}
	.tree-empty-btn {
		padding: 5px 8px;
	}
	.tree-empty {
		color: var(--text-faint);
		font-size: 12px;
		padding: 2px 4px;
	}
	.tree-error {
		margin: 2px 0 6px;
		padding: 6px 8px;
		border: 1px solid #f0c9c1;
		border-radius: 6px;
		background: #fff7f5;
		color: #9d2d20;
		font-size: 12px;
		line-height: 1.35;
	}
	.tree-empty.indented {
		padding-top: 2px;
		padding-bottom: 4px;
	}
	.tree-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.tree-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text-secondary);
		line-height: 1.3;
		font-size: 13px;
	}
	.tree-row:hover {
		background: var(--bg-hover);
	}
	.tree-row.internal:not(.active):not(:hover) {
		color: var(--text-faint);
		opacity: 0.72;
	}
	.tree-row.selected:not(.internal) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tree-row.selected.internal:hover {
		background: var(--bg-hover);
		color: var(--text);
		opacity: 1;
	}
	.tree-row.active {
		background: var(--accent-bg);
		color: var(--accent);
	}
	.tree-row.draft {
		background: var(--bg-surface);
		color: var(--text);
	}
	.tree-row[draggable='true'] {
		cursor: grab;
	}
	.tree-row[draggable='true']:active {
		cursor: grabbing;
	}
	.tree-row.drag-over {
		background: var(--accent-bg);
		outline: 1px solid var(--accent-light);
		outline-offset: -1px;
	}
	.tree-list.drag-over-root {
		outline: 1px dashed var(--accent-light);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.chev {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		color: var(--text-faint);
		transition: transform 0.15s;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.tree-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.tree-inline-input {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--accent);
		background: var(--bg);
		color: var(--text);
		border-radius: 4px;
		padding: 2px 6px;
		font: inherit;
		outline: none;
	}
	.tree-inline-input::placeholder {
		color: var(--text-faint);
	}

	/* Right-click menu — fixed-position, floats above everything. Mirrors
	 * the MenuBar's submenu styling for consistency. */
	.file-tree-menu {
		position: fixed;
		z-index: 300;
		min-width: 160px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 4px rgba(0, 0, 0, 0.04);
		padding: 4px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
	}
	.file-tree-menu-item {
		display: block;
		width: 100%;
		padding: 6px 10px;
		border: none;
		background: none;
		font: inherit;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		white-space: nowrap;
	}
	.file-tree-menu-item:hover {
		background: var(--bg-hover);
	}
	.file-tree-menu-item.danger {
		color: var(--diff-removed-color);
	}
	.file-tree-menu-divider {
		height: 1px;
		background: var(--border-light);
		margin: 4px 0;
	}
</style>
