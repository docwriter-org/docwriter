<script lang="ts" module>
	import type { Component, Snippet } from 'svelte';

	/** Leaf item — clicking it fires onClick and closes every open menu. */
	export type MenuAction = {
		kind: 'action';
		label: string;
		onClick: () => void | Promise<void>;
		checked?: boolean;
		disabled?: boolean;
		icon?: Component;
		/** Extra props for `icon` — for icon components that need more than
		 * `size` (e.g. ReviewerMascot's `icon` variant key). */
		iconProps?: Record<string, unknown>;
		/** Color for the icon (CSS color). Defaults to the muted item color. */
		iconColor?: string;
	};

	/** Parent item — hovering it opens a side submenu one level deep. */
	export type MenuSubmenu = {
		kind: 'submenu';
		label: string;
		items: Array<MenuAction | MenuDivider>;
	};

	/** Parent item — hovering it opens a side flyout rendering arbitrary
	 * content (a Svelte snippet) instead of a list of menu items. Good for
	 * small editors (rules list, font size slider, etc.) that need richer UI
	 * than `MenuAction` allows.
	 *
	 * `panelKey` is resolved against MenuBar's `panels` prop. Keeping it as a
	 * string (rather than a direct snippet reference) lets callers build the
	 * `menus` spec in the <script> block — snippets declared in markup can't
	 * be referenced from script scope. */
	export type MenuPanel = {
		kind: 'panel';
		label: string;
		panelKey: string;
	};

	export type MenuDivider = { kind: 'divider' };

	export type MenuItem = MenuAction | MenuSubmenu | MenuPanel | MenuDivider;

	export type MenuSpec = { label: string; items: MenuItem[] };
</script>

<script lang="ts">
	import { Check, ChevronRight } from 'lucide-svelte';
	import { logUi } from '$lib/interaction-log-client';

	interface Props {
		menus: MenuSpec[];
		/** Map of panel-key → snippet. Referenced by `MenuPanel.panelKey`. */
		panels?: Record<string, Snippet>;
	}
	let { menus, panels }: Props = $props();

	let openMenu = $state<number | null>(null);
	let openSubmenu = $state<string | null>(null);
	let menuBarEl: HTMLDivElement | null = $state(null);

	function toggleMenu(i: number) {
		if (openMenu !== i) {
			logUi('ui.menu_open', { menu: menus[i]?.label?.toLowerCase() ?? 'menu' });
		}
		openMenu = openMenu === i ? null : i;
		openSubmenu = null;
	}

	function hoverMenu(i: number) {
		// If a menu is already open, switching between top-level triggers by
		// hover feels natural (matches native menu bars).
		if (openMenu !== null && openMenu !== i) {
			openMenu = i;
			openSubmenu = null;
		}
	}

	function closeAll() {
		openMenu = null;
		openSubmenu = null;
	}

	/** Hover-over handler for every item inside the open top-level menu.
	 * Sticky-submenu behavior: once a submenu or panel is opened, it stays
	 * open until the user hovers a DIFFERENT item (which either switches or
	 * clears), clicks an action, clicks outside, or presses Escape. No
	 * auto-hide on mouseleave — that made rich panels (textareas, inputs)
	 * unusable since any mouse movement past a 5px gap flickered them. */
	function hoverItem(item: MenuItem) {
		if (item.kind === 'submenu' || item.kind === 'panel') {
			openSubmenu = item.label;
		} else if (item.kind === 'action') {
			// Plain action rows close any open submenu so the panel disappears
			// before the user clicks (matches native menu bar).
			openSubmenu = null;
		}
	}

	async function runAction(item: MenuAction) {
		if (item.disabled) return;
		closeAll();
		await item.onClick();
	}

	/** Keep an open panel/submenu inside the viewport: cap its height to the
	 * space below its top edge and let the content scroll. Without this a
	 * tall flyout (e.g. Writing references) runs past the bottom of the
	 * window and its lower controls are unreachable. */
	function clampToViewport(node: HTMLElement) {
		const clamp = () => {
			node.style.maxHeight = '';
			const rect = node.getBoundingClientRect();
			const available = window.innerHeight - rect.top - 12;
			node.style.maxHeight = `${Math.max(120, Math.round(available))}px`;
		};
		clamp();
		window.addEventListener('resize', clamp);
		return {
			destroy() {
				window.removeEventListener('resize', clamp);
			}
		};
	}

	// Close on outside click / Escape.
	$effect(() => {
		if (openMenu === null) return;
		function onDown(e: MouseEvent) {
			if (menuBarEl && !menuBarEl.contains(e.target as Node)) closeAll();
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') closeAll();
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="menu-bar" bind:this={menuBarEl}>
	{#each menus as menu, i (menu.label)}
		<div class="menu">
			<button
				class="menu-trigger"
				class:open={openMenu === i}
				onclick={() => toggleMenu(i)}
				onmouseenter={() => hoverMenu(i)}
				aria-haspopup="menu"
				aria-expanded={openMenu === i}
			>
				{menu.label}
			</button>

			{#if openMenu === i}
				<div class="menu-panel" role="menu">
					{#each menu.items as item, idx (idx)}
						{#if item.kind === 'divider'}
							<div
								class="menu-divider"
								role="separator"
								onmouseenter={() => (openSubmenu = null)}
							></div>
						{:else if item.kind === 'action'}
							{@const Icon = item.icon}
							<button
								class="menu-item"
								class:disabled={item.disabled}
								role="menuitem"
								disabled={item.disabled}
								onclick={() => runAction(item)}
								onmouseenter={() => hoverItem(item)}
							>
								<span class="menu-item-check">
									{#if item.checked}<Check size={12} strokeWidth={2.5} />{/if}
								</span>
								{#if Icon}<span class="menu-item-icon" style:color={item.iconColor}><Icon {...(item.iconProps ?? {})} size={13} /></span>{/if}
								<span class="menu-item-label">{item.label}</span>
							</button>
						{:else if item.kind === 'submenu'}
							<div
								class="menu-item submenu-trigger"
								class:open={openSubmenu === item.label}
								role="menuitem"
								tabindex="-1"
								aria-haspopup="menu"
								aria-expanded={openSubmenu === item.label}
								onmouseenter={() => hoverItem(item)}
							>
								<span class="menu-item-check"></span>
								<span class="menu-item-label">{item.label}</span>
								<ChevronRight size={12} class="submenu-arrow" />

								{#if openSubmenu === item.label}
									<div class="submenu-panel" role="menu" tabindex="-1" use:clampToViewport>
										{#each item.items as sub, subIdx (subIdx)}
											{#if sub.kind === 'divider'}
												<div class="menu-divider" role="separator"></div>
											{:else}
												{@const SubIcon = sub.icon}
												<button
													class="menu-item"
													class:disabled={sub.disabled}
													role="menuitem"
													disabled={sub.disabled}
													onclick={() => runAction(sub)}
												>
													<span class="menu-item-check">
														{#if sub.checked}<Check size={12} strokeWidth={2.5} />{/if}
													</span>
													{#if SubIcon}<span class="menu-item-icon" style:color={sub.iconColor}><SubIcon {...(sub.iconProps ?? {})} size={13} /></span>{/if}
													<span class="menu-item-label">{sub.label}</span>
												</button>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{:else}
							<div
								class="menu-item submenu-trigger"
								class:open={openSubmenu === item.label}
								role="menuitem"
								tabindex="-1"
								aria-haspopup="menu"
								aria-expanded={openSubmenu === item.label}
								onmouseenter={() => hoverItem(item)}
							>
								<span class="menu-item-check"></span>
								<span class="menu-item-label">{item.label}</span>
								<ChevronRight size={12} class="submenu-arrow" />

								{#if openSubmenu === item.label}
									{@const panelSnippet = panels?.[item.panelKey]}
									<div
										class="submenu-panel panel-flyout"
										role="menu"
										tabindex="-1"
										use:clampToViewport
									>
										{#if panelSnippet}{@render panelSnippet()}{/if}
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.menu-bar {
		display: flex;
		align-items: stretch;
		gap: 2px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
	}
	.menu {
		position: relative;
	}
	.menu-trigger {
		font: inherit;
		color: var(--text-secondary);
		background: none;
		border: 1px solid transparent;
		padding: 5px 10px;
		border-radius: 5px;
		cursor: pointer;
		line-height: 1.2;
	}
	.menu-trigger:hover,
	.menu-trigger.open {
		background: var(--bg-hover);
		color: var(--text);
	}
	.menu-panel {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 200px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 4px rgba(0, 0, 0, 0.04);
		padding: 4px;
		z-index: 200;
		font-size: 13px;
	}
	.menu-item {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px 6px 6px;
		border: none;
		background: none;
		font: inherit;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		position: relative;
		line-height: 1.35;
		white-space: nowrap;
		box-sizing: border-box;
	}
	.menu-item:hover,
	.menu-item.submenu-trigger.open {
		background: var(--bg-hover);
	}
	.menu-item.disabled {
		color: var(--text-faint);
		cursor: default;
		background: none;
	}
	.menu-item-check {
		width: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		flex-shrink: 0;
	}
	.menu-item-icon {
		display: inline-flex;
		align-items: center;
		color: var(--text-muted);
	}
	.menu-item-label {
		flex: 1;
		line-height: 1.3;
	}
	.submenu-trigger :global(.submenu-arrow) {
		color: var(--text-faint);
		margin-left: auto;
		flex-shrink: 0;
	}
	.menu-divider {
		height: 1px;
		background: var(--border-light);
		margin: 3px 0;
	}
	.submenu-panel {
		position: absolute;
		top: -5px;
		/* Sit flush against the parent menu's outer border. The menu-panel
		 * has 4px of inner padding + 1px border, so we nudge past it with
		 * a negative offset from the submenu-trigger's right edge. */
		left: calc(100% + 5px);
		min-width: 160px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 4px rgba(0, 0, 0, 0.04);
		padding: 4px;
		/* clampToViewport caps max-height to the space below; overflow makes
		 * the capped panel scroll instead of clipping its lower controls. */
		overflow-y: auto;
	}
	/* Panel flyouts embed arbitrary content (e.g. RulesPanel) — let that
	 * content own its own padding and sizing. Reset `white-space` because
	 * the parent .menu-item sets `nowrap` for its own label, which would
	 * otherwise cascade into the panel and truncate multi-line descriptions
	 * (seen on the Agent behavior autonomy text). */
	.submenu-panel.panel-flyout {
		padding: 0;
		min-width: 0;
		white-space: normal;
		cursor: default;
	}
</style>
