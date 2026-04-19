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
	}
	let { onOpenFile, activePath, onRenamed, onDeleted }: Props = $props();

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
	let createInput: HTMLInputElement | null = $state(null);

	async function fetchEntries(path: string): Promise<FileEntry[]> {
		const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data.entries) ? data.entries : [];
	}

	async function loadRoot() {
		rootEntries = await fetchEntries('');
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
		// Opening: lazy-load if we haven't fetched yet.
		nodeState[entry.path] = { ...cur, expanded: true, loading: !cur.children };
		if (!cur.children) {
			const kids = await fetchEntries(entry.path);
			nodeState[entry.path] = { expanded: true, loading: false, children: kids };
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

	/** Reload the children of a folder that's already expanded. Used after
	 * create/rename/delete inside that folder. Finds the deepest cached
	 * ancestor of `path` and re-fetches its children. */
	async function refreshFolder(folderPath: string) {
		if (folderPath === '') {
			rootEntries = await fetchEntries('');
			return;
		}
		const state = nodeState[folderPath];
		if (state?.expanded) {
			nodeState[folderPath] = { ...state, loading: true };
			const kids = await fetchEntries(folderPath);
			nodeState[folderPath] = { expanded: true, loading: false, children: kids };
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
			const res = await fetch('/api/files', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: entry.path, to: toPath })
			});
			if (!res.ok) throw new Error(await res.text());
			await refreshFolder(parent);
			onRenamed?.(entry.path, toPath);
		} catch (e) {
			window.alert(`Rename failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function doDelete(entry: FileEntry) {
		closeMenu();
		const ok = window.confirm(
			`Delete "${entry.path}"?\n\nThis permanently removes ${
				entry.kind === 'folder' ? 'the folder and all its contents' : 'the file'
			} from disk. You won't be able to recover it.`
		);
		if (!ok) return;
		try {
			const res = await fetch(
				`/api/files?path=${encodeURIComponent(entry.path)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error(await res.text());
			await refreshFolder(parentOf(entry.path));
			onDeleted?.(entry.path);
		} catch (e) {
			window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
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
			const res = await fetch('/api/files', {
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
			window.alert(`Create failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
</script>

<div class="file-tree">
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
		<ul class="tree-list">
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
			style:padding-left="{4 + depth * 14}px"
			onclick={() => {
				selectedPath = entry.path;
				if (entry.kind === 'folder') void toggleFolder(entry);
				else onOpenFile?.(entry);
			}}
			oncontextmenu={(e) => openMenu(e, entry)}
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
	.tree-row.selected {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tree-row.active {
		background: var(--accent-bg);
		color: var(--accent);
	}
	.tree-row.draft {
		background: var(--bg-surface);
		color: var(--text);
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
