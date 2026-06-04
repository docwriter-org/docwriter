<script lang="ts">
	import { X, FileCode } from 'lucide-svelte';
	import { tabs, activeTab } from '$lib/stores';
	import { showConfirm } from '$lib/dialogs';

	interface Props {
		onSwitch: (id: string) => void | Promise<void>;
		/** Close: remove the tab from the list but LEAVE the file on disk.
		 * This is what the × button does. */
		onClose: (id: string) => Promise<void>;
		/** Delete: close the tab AND unlink the file. This is destructive
		 * — reached via the right-click menu or FileTree only. */
		onDelete: (id: string) => Promise<void>;
		onRename: (oldId: string, newId: string) => Promise<void>;
		/** Map tabId → number of pending agent-edit rounds. Absent or 0 means
		 * no pending reviews on that tab; >0 renders as a numbered badge. */
		pendingTabs?: Map<string, number>;
		/** Called when the user drops files from Finder / the filesystem onto
		 * the tab bar. Parent is responsible for copying and registering. */
		onDropFile?: (files: File[]) => Promise<void>;
	}
	let { onSwitch, onClose, onDelete, onRename, pendingTabs, onDropFile }: Props = $props();

	let isDragOver = $state(false);

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'copy';
		isDragOver = true;
	}
	function handleDragLeave(e: DragEvent) {
		const related = e.relatedTarget as Node | null;
		const bar = (e.currentTarget as HTMLElement);
		if (related && bar.contains(related)) return;
		isDragOver = false;
	}
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		isDragOver = false;
		if (!onDropFile || !e.dataTransfer?.files.length) return;
		void onDropFile([...e.dataTransfer.files]);
	}

	let tabList: string[] = $state([]);
	tabs.subscribe((v) => (tabList = v));

	let active = $state<string | null>(null);
	activeTab.subscribe((v) => (active = v));

	/** Tabs keep their natural (creation) order — switching tabs only changes
	 * which one is active, it doesn't reshuffle positions. A pending tab is
	 * surfaced by its dot in place, not by floating it to the front. */
	let displayList = $derived(tabList);

	// Inline rename
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let renameInput: HTMLInputElement | null = $state(null);

	function beginRename(id: string) {
		renamingId = id;
		// Show only the basename in the input. On commit we rejoin with the
		// parent path so renaming "a/b/foo.md" to "bar.md" becomes
		// "a/b/bar.md", not a bare "bar.md" at the workspace root.
		renameValue = basenameOf(id);
		setTimeout(() => {
			renameInput?.focus();
			renameInput?.select();
		}, 0);
	}

	async function commitRename() {
		if (renamingId === null) return;
		const nextBase = renameValue.trim();
		const old = renamingId;
		renamingId = null;
		if (!nextBase || nextBase === basenameOf(old)) return;
		const parent = parentOf(old);
		const next = parent ? `${parent}/${nextBase}` : nextBase;
		if (next === old) return;
		try {
			await onRename(old, next);
		} catch (e) {
			console.error('Rename failed:', e);
		}
	}

	function basenameOf(id: string): string {
		const idx = id.lastIndexOf('/');
		return idx < 0 ? id : id.slice(idx + 1);
	}
	function parentOf(id: string): string {
		const idx = id.lastIndexOf('/');
		return idx < 0 ? '' : id.slice(0, idx);
	}

	/** × button: close the tab (leaves the file on disk). */
	function requestClose(id: string, e: Event) {
		e.stopPropagation();
		void onClose(id);
	}

	/** Confirm-then-delete via right-click menu. Destructive, so we gate
	 * behind a native confirm. */
	async function requestDelete(id: string) {
		closeMenu();
		const ok = await showConfirm(
			`Delete "${id}"?\n\nThis permanently removes the file from disk. You won't be able to recover it.`,
			{ title: 'Delete', confirmLabel: 'Delete', danger: true }
		);
		if (ok) void onDelete(id);
	}

	// ── Right-click context menu ─────────────────────────────────────
	let menu = $state<{ id: string; x: number; y: number } | null>(null);
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

	function openMenu(e: MouseEvent, id: string) {
		e.preventDefault();
		e.stopPropagation();
		menu = { id, x: e.clientX, y: e.clientY };
	}
	function closeMenu() {
		menu = null;
	}
	$effect(() => {
		if (!menu) return;
		function onDown(e: MouseEvent) {
			const t = e.target as Element | null;
			if (!t?.closest('.tab-menu')) closeMenu();
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
	async function doCopyPath(id: string) {
		closeMenu();
		try {
			await navigator.clipboard.writeText(id);
		} catch {
			// Clipboard denied or non-secure context — do nothing.
		}
	}
	function doRenameFromMenu(id: string) {
		closeMenu();
		beginRename(id);
	}

	function handleSwitch(id: string, e: Event) {
		// If the user is currently renaming this tab, don't switch.
		if (renamingId === id) return;
		e.stopPropagation();
		void onSwitch(id);
	}

	/** Compact label for a viewing tab's path. Shows just the basename
	 * unless the parent directory is distinctive (not the workspace root).
	 * Full path is in the `title` attribute on the tab for hover. */
	function shortPath(path: string): string {
		const parts = path.split('/');
		const base = parts[parts.length - 1];
		if (parts.length > 1) {
			const parent = parts[parts.length - 2];
			return `${parent}/${base}`;
		}
		return base;
	}
</script>

<div
	class="tab-bar"
	class:drag-over={isDragOver}
	role="tablist"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	{#each displayList as id}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="tab"
			class:active={id === active}
			class:pending={(pendingTabs?.get(id) ?? 0) > 0}
			role="tab"
			tabindex={id === active ? 0 : -1}
			aria-selected={id === active}
			onclick={(e) => handleSwitch(id, e)}
			ondblclick={(e) => { e.stopPropagation(); beginRename(id); }}
			oncontextmenu={(e) => openMenu(e, id)}
			title={id}
		>
			<FileCode size={11} />
			{#if renamingId === id}
				<input
					class="tab-rename"
					bind:this={renameInput}
					bind:value={renameValue}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
						if (e.key === 'Escape') { e.preventDefault(); renamingId = null; }
					}}
				/>
			{:else}
				<span class="tab-name">{shortPath(id)}</span>
				{#if (pendingTabs?.get(id) ?? 0) > 0}
					{@const count = pendingTabs!.get(id)!}
					<span
						class="pending-dot"
						class:with-count={count > 1}
						aria-label="{count} pending agent edit{count === 1 ? '' : 's'}"
						title="Agent edited this tab {count} time{count === 1 ? '' : 's'} — switch to it to review"
					>{#if count > 1}{count}{/if}</span>
				{/if}
			{/if}
			<button
				class="tab-close"
				aria-label="Close tab (file stays on disk)"
				title="Close tab"
				onclick={(e) => requestClose(id, e)}
			>
				<X size={11} />
			</button>
		</div>
	{/each}
</div>

{#if menu}
	<div
		bind:this={menuEl}
		class="tab-menu"
		role="menu"
		style:left="{menu.x}px"
		style:top="{menu.y}px"
	>
		<button class="tab-menu-item" onclick={() => doRenameFromMenu(menu!.id)}>
			Rename…
		</button>
		<button class="tab-menu-item" onclick={() => doCopyPath(menu!.id)}>
			Copy path
		</button>
		<div class="tab-menu-divider"></div>
		<button class="tab-menu-item danger" onclick={() => requestDelete(menu!.id)}>
			Delete file
		</button>
	</div>
{/if}

<style>
	/* Browser-style tabs: each tab sits on top of the bottom edge, the
	 * active tab "rises" into the content area by hiding the border-bottom
	 * and matching its background to the editor. */
	.tab-bar {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 2px;
		padding: 0;
		/* Sits on the app canvas; the active tab is a white page-tab that
		 * connects to the document sheet directly below it. */
		background: transparent;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		min-height: 30px;
		flex-shrink: 0;
	}
	.tab {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px 7px;
		background: transparent;
		border: 1px solid transparent;
		border-top-left-radius: 7px;
		border-top-right-radius: 7px;
		margin-bottom: -1px; /* overlap the bar's bottom border */
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
		font-family: inherit;
		white-space: nowrap;
		max-width: 200px;
		transition: background 0.12s, color 0.12s, border-color 0.12s;
	}
	.tab:hover {
		background: color-mix(in srgb, var(--bg) 60%, var(--pane-bg));
		color: var(--text-secondary);
	}
	.tab.active {
		background: var(--bg);
		color: var(--text);
		border-color: var(--border-light);
		border-bottom-color: var(--bg); /* connects into the page sheet below */
		font-weight: 500;
		box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.04);
	}
	.tab-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tab-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		border-radius: 3px;
		cursor: pointer;
		padding: 0;
		opacity: 0;
		transition: opacity 0.12s, background 0.12s, color 0.12s;
	}
	.tab:hover .tab-close {
		opacity: 1;
	}
	.tab-close:hover {
		background: var(--bg-surface);
		color: var(--text-secondary);
	}
	.pending-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 6px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		margin-left: 2px;
		flex-shrink: 0;
		color: white;
		font-size: 9px;
		font-weight: 600;
		line-height: 1;
	}
	.pending-dot.with-count {
		/* Numbered pill for 2+ pending rounds. */
		width: auto;
		min-width: 14px;
		height: 14px;
		padding: 0 4px;
		border-radius: 7px;
	}
	.tab.pending .pending-dot {
		/* Slow pulse on every pending tab so the user notices */
		animation: pending-pulse 1.8s ease-in-out infinite;
	}
	@keyframes pending-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50%      { opacity: 0.5; transform: scale(1.25); }
	}
	.tab-rename {
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		outline: none;
		padding: 0;
		min-width: 80px;
		width: 100px;
	}
	.tab-rename:focus {
		outline: 1px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	/* Right-click context menu. Fixed position at cursor, mirrors MenuBar
	 * + FileTree menu styling for consistency. */
	.tab-menu {
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
	.tab-menu-item {
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
	.tab-menu-item:hover {
		background: var(--bg-hover);
	}
	.tab-menu-item.danger {
		color: var(--diff-removed-color);
	}
	.tab-menu-divider {
		height: 1px;
		background: var(--border-light);
		margin: 4px 0;
	}
	.tab-bar.drag-over {
		background: color-mix(in srgb, var(--accent) 8%, var(--pane-bg));
		border-bottom-color: var(--accent);
		outline: 1.5px dashed var(--accent);
		outline-offset: -2px;
	}
</style>
