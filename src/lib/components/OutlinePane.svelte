<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Unsubscriber } from 'svelte/store';
	import * as Y from 'yjs';
	import { activeTab } from '$lib/stores';
	import { getYDocForTab } from '$lib/yjs-doc';
	import { serializeFragment as plainTextFromFragment } from '$lib/shared/ydoc-codec';

	interface Props {
		showOutline?: boolean;
	}
	let { showOutline = true }: Props = $props();

	let md = $state('');
	let observedFragment: Y.XmlFragment | null = null;
	let observedHandler: (() => void) | null = null;

	function detachOutlineObserver() {
		if (observedFragment && observedHandler) observedFragment.unobserve(observedHandler);
		observedFragment = null;
		observedHandler = null;
	}

	function attachOutlineObserver(tabId: string | null) {
		detachOutlineObserver();
		if (!tabId) { md = ''; return; }
		const fragment = getYDocForTab(tabId).getXmlFragment('default');
		const sync = () => { md = plainTextFromFragment(fragment); };
		sync();
		fragment.observe(sync);
		observedFragment = fragment;
		observedHandler = sync;
	}

	interface Heading { level: number; text: string; }
	let toc = $derived.by<Heading[]>(() => {
		const headings: Heading[] = [];
		for (const line of md.split('\n')) {
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) headings.push({ level: match[1].length, text: match[2].trim() });
		}
		return headings;
	});

	let activeTabUnsub: Unsubscriber | null = null;

	onMount(() => {
		activeTabUnsub = activeTab.subscribe((tabId) => {
			attachOutlineObserver(tabId);
		});
	});
	onDestroy(() => {
		activeTabUnsub?.();
		detachOutlineObserver();
	});

	function scrollToHeading(text: string) {
		const editor = document.querySelector('.tiptap-content');
		if (!editor) return;
		for (const h of Array.from(editor.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
			if (h.textContent?.trim() === text) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
		}
	}
</script>

<div class="outline-pane">
	{#if showOutline}
		<div class="section">
			<div class="section-header">Outline</div>
			{#if toc.length === 0}
				<div class="empty">No headings yet.</div>
			{:else}
				<div class="toc">
					{#each toc as h}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="toc-item"
							data-level={h.level}
							style:padding-left={`${Math.max(0, h.level - 1) * 14}px`}
							onclick={() => scrollToHeading(h.text)}
						>
							<span>{h.text}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.outline-pane {
		padding: 20px 16px;
		overflow-y: auto;
		height: 100%;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		color: var(--text);
	}
	.section { margin-bottom: 28px; }
	.section-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 10px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.empty { color: var(--text-faint); font-size: 13px; padding: 4px 0; }
	.toc-item {
		position: relative;
		display: block;
		padding-top: 5px;
		padding-right: 8px;
		padding-bottom: 5px;
		border-radius: 3px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.toc-item:hover { background: var(--bg-hover); }
	.toc-item:hover::before {
		content: '';
		position: absolute;
		left: 0;
		top: 7px;
		bottom: 7px;
		width: 2px;
		border-radius: 2px;
		background: var(--accent);
	}
	.toc-item[data-level='1'] {
		font-weight: 500;
		color: var(--text);
	}
	.toc-item[data-level='2'] {
		font-weight: 450;
		color: var(--text-secondary);
	}
	.toc-item[data-level='3'],
	.toc-item[data-level='4'],
	.toc-item[data-level='5'],
	.toc-item[data-level='6'] {
		font-size: 12.5px;
		color: var(--text-muted);
	}
</style>
