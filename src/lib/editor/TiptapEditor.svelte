<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Editor } from '@tiptap/core';
	import { annotate } from 'rough-notation';
	import type { RoughAnnotation } from 'rough-notation/lib/model';
	import { ySyncPluginKey } from 'y-prosemirror';
	import { DiffOverlay, setDiffState } from './diff-overlay';
	import { collaborativeExtensions } from '$lib/editor-extensions';
	import { getYDoc, whenYDocReady, isYDocEmpty, getCurrentTab } from '$lib/yjs-doc';
	import { seedYDocFromContent } from '$lib/yjs-markdown';
	import { disposeAgentUndo, isAgentApplyInProgress } from '$lib/yjs-agent';
	import {
		userMd,
		reviewBaseline,
		userEditRegions,
		isRendering,
		submitCountdown,
		editorFontScale,
		pinnedActions,
		recentActions,
		trackActionUsage,
		pendingReviewRounds
	} from '$lib/stores';
	import type { UserEditRegion } from '$lib/stores';
	import type { Action } from '$lib/types';

	const IDLE_MS = 3_000;

	interface Props {
		onSubmit?: (trigger?: string) => void;
		/** 'markdown' (default) = full StarterKit + markdown parsing.
		 * 'plain' = minimal schema with no markdown rendering (for .txt,
		 * .json, and other non-markdown text files). */
		kind?: 'markdown' | 'plain';
	}
	let { onSubmit, kind = 'markdown' }: Props = $props();

	let element: HTMLDivElement;
	let editor: Editor | undefined = $state();
	let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let idleDeadline = 0;
	let lastWrittenMd = '';

	let fontScale = $state(1.0);
	editorFontScale.subscribe((v) => (fontScale = v));

	// Feedback popup: floating toolbar when the user selects text. Shows
	// pinned actions + LRU recent actions + an open-ended text input.
	let feedbackPopup = $state<{ text: string; x: number; y: number; flipBelow: boolean } | null>(null);
	let feedbackPopupEl: HTMLDivElement | null = $state(null);
	let feedbackInput = $state('');
	let recent: Action[] = $state([]);
	recentActions.subscribe((v) => (recent = v));

	function updateFeedbackPopup() {
		if (!editor || !editor.isFocused) return;
		const { from, to, empty } = editor.state.selection;
		if (empty || to - from < 2) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			updateDiff();
			void refreshFeedbackOverlay();
			return;
		}
		const selectedText = editor.state.doc.textBetween(from, to, ' ');
		if (!selectedText.trim()) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			updateDiff();
			void refreshFeedbackOverlay();
			return;
		}
		const start = editor.view.coordsAtPos(from);
		const end = editor.view.coordsAtPos(to);
		const x = (start.left + end.right) / 2;
		const POPUP_H_APPROX = 140;
		const flipBelow = start.top < POPUP_H_APPROX + 20;
		const y = flipBelow ? end.bottom + 8 : start.top - 8;
		feedbackPopup = { text: selectedText, x, y, flipBelow };
		feedbackSelectionRange = { from, to };
		updateDiff();
		void refreshFeedbackOverlay();
	}

	function handleSelectionChange() {
		updateFeedbackPopup();
	}

	function sendFeedback(action: Action) {
		if (!feedbackPopup) return;
		const text = feedbackPopup.text;
		trackActionUsage(action.label);
		if (!action.pinned) {
			recentActions.update((prev) => [action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6));
		}
		feedbackPopup = null;
		feedbackInput = '';
		feedbackSelectionRange = null;
		updateDiff();
		void refreshFeedbackOverlay();
		if (onSubmit) onSubmit(`Feedback "${action.label}" on this passage: "${text.slice(0, 300)}"`);
	}

	function sendCustomFeedback() {
		if (!feedbackPopup || !feedbackInput.trim()) return;
		const text = feedbackPopup.text;
		const fb = feedbackInput.trim();
		// Preserve the full label — CSS truncates long text with an ellipsis
		// inside the button, and `title={label}` lets the user see the whole
		// thing on hover. Slicing here used to destroy the original text.
		const customAction: Action = {
			id: 'custom_' + Date.now(),
			label: fb,
			icon: 'message-square',
			pinned: false,
			color: '#7c3aed'
		};
		trackActionUsage(customAction.label);
		recentActions.update((prev) => [customAction, ...prev.filter((x) => x.label !== customAction.label)].slice(0, 6));
		feedbackPopup = null;
		feedbackInput = '';
		feedbackSelectionRange = null;
		updateDiff();
		void refreshFeedbackOverlay();
		if (onSubmit) onSubmit(`Feedback "${fb}" on this passage: "${text.slice(0, 300)}"`);
	}

	/** Serialize editor content for the autosave / render flow.
	 *  - Markdown mode uses tiptap-markdown's serializer (preserves headings,
	 *    bullets, bold, etc.).
	 *  - Plain mode uses Tiptap's `getText({ blockSeparator: '\n' })` which
	 *    renders paragraphs as '\n'-joined lines — a 1:1 round-trip with
	 *    files on disk. */
	function getEditorMarkdown(): string {
		if (!editor) return '';
		if (kind === 'plain') {
			return editor.getText({ blockSeparator: '\n' });
		}
		return (editor.storage as any).markdown?.getMarkdown?.() || '';
	}

	let inFlightWrite: Promise<void> = Promise.resolve();

	function writeToDisk(md: string): Promise<void> {
		if (md === lastWrittenMd) return inFlightWrite;
		lastWrittenMd = md;
		// Include the tab id explicitly so the autosave can never route to
		// the wrong file if the server's "active tab" pointer is momentarily
		// out of sync with what the editor is showing.
		const tabId = getCurrentTab();
		const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
		inFlightWrite = fetch(`/api/document${q}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userMd: md })
		}).then(() => undefined);
		return inFlightWrite;
	}

	/** Synchronously fire any pending debounced write and return the in-flight
	 * Promise. Awaiting this guarantees notes/<tab>.md reflects every keystroke
	 * before the caller proceeds — used by submit() so the agent never sees a
	 * stale file. */
	export function flushAutosave(): Promise<void> {
		if (writeDebounceTimer) {
			clearTimeout(writeDebounceTimer);
			writeDebounceTimer = null;
			const md = getEditorMarkdown();
			return writeToDisk(md);
		}
		return inFlightWrite;
	}

	// Diff overlay state — baseline changes when a review starts/ends.
	let currentBaseline: string | null = null;
	reviewBaseline.subscribe((v) => {
		currentBaseline = v;
		updateDiff();
	});

	let currentRegions: UserEditRegion[] = [];
	userEditRegions.subscribe((v) => {
		currentRegions = v;
		updateDiff();
	});

	/** True when every pending round is a tiny (<THRESHOLD char) edit.
	 * Drives a softer ghost style on the diff overlay so a one-word tweak
	 * doesn't look like a paragraph rewrite. */
	let allRoundsTiny = false;
	pendingReviewRounds.subscribe((v) => {
		allRoundsTiny = v.length > 0 && v.every((r) => r.kind === 'tiny');
		updateDiff();
	});

	/** PM range currently highlighted as "what the user is giving feedback
	 * on". Set when the feedback popup opens, cleared when it closes.
	 * `$state` so the `.feedback-active` class on the wrapper reacts. */
	let feedbackSelectionRange: { from: number; to: number } | null = $state(null);
	/** rough-notation annotations for the overlay spans. Kept around so we
	 * can `.remove()` them when the selection clears. */
	let feedbackAnnotations: RoughAnnotation[] = [];
	/** Overlay element: sibling of the editor, populated by
	 * refreshFeedbackOverlay with absolutely-positioned spans at each client
	 * rect of the current selection. rough-notation annotates those spans;
	 * since they live outside PM's DOM, PM won't wipe them. */
	let feedbackOverlayEl: HTMLDivElement | null = $state(null);

	/** Append an alpha channel to a CSS color string. Handles `rgb(r g b)` /
	 * `rgb(r, g, b)` / `#rrggbb` / `#rgb`. Falls back to the raw string if we
	 * can't parse it (rough-notation will still render, just opaque). */
	function withAlpha(color: string, alpha: number): string {
		const c = color.trim();
		// `rgb(r, g, b)` or `rgb(r g b)` — insert alpha.
		const rgbMatch = c.match(/^rgb\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*\)$/i);
		if (rgbMatch) {
			return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
		}
		// `#rrggbb` → rgba.
		const hex6 = c.match(/^#([0-9a-f]{6})$/i);
		if (hex6) {
			const n = parseInt(hex6[1], 16);
			return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
		}
		const hex3 = c.match(/^#([0-9a-f]{3})$/i);
		if (hex3) {
			const [r, g, b] = hex3[1].split('').map((x) => parseInt(x + x, 16));
			return `rgba(${r}, ${g}, ${b}, ${alpha})`;
		}
		return c;
	}

	async function refreshFeedbackOverlay() {
		// Tear down any prior annotations and clear overlay contents.
		for (const a of feedbackAnnotations) a.remove();
		feedbackAnnotations = [];
		if (feedbackOverlayEl) feedbackOverlayEl.innerHTML = '';
		if (!feedbackSelectionRange || !editor || !feedbackOverlayEl || !element) return;
		await tick();
		await new Promise((r) => requestAnimationFrame(r));
		// Turn the PM range into screen-space client rects (one per line).
		const { from, to } = feedbackSelectionRange;
		const domStart = editor.view.domAtPos(from);
		const domEnd = editor.view.domAtPos(to);
		const range = document.createRange();
		try {
			range.setStart(domStart.node, domStart.offset);
			range.setEnd(domEnd.node, domEnd.offset);
		} catch {
			return;
		}
		const clientRects = Array.from(range.getClientRects()).filter(
			(r) => r.width > 0 && r.height > 0
		);
		if (clientRects.length === 0) return;
		// Overlay is positioned relative to the tiptap-wrapper, so subtract
		// the wrapper's own screen offset from each client rect.
		const wrapperRect = feedbackOverlayEl.getBoundingClientRect();
		const scrollTop = feedbackOverlayEl.parentElement?.scrollTop ?? 0;
		// Resolve --accent and add alpha — rough-notation's `highlight` type
		// draws a near-full-height stroke, so a fully opaque color comes out
		// as a solid block. Translucency gives the proper marker look.
		const rawAccent =
			getComputedStyle(element).getPropertyValue('--accent').trim() || 'rgb(124, 58, 237)';
		const accent = withAlpha(rawAccent, 0.1);
		for (const r of clientRects) {
			const span = document.createElement('span');
			span.className = 'feedback-overlay-rect';
			span.style.position = 'absolute';
			span.style.left = r.left - wrapperRect.left + 'px';
			span.style.top = r.top - wrapperRect.top + scrollTop + 'px';
			span.style.width = r.width + 'px';
			span.style.height = r.height + 'px';
			span.style.pointerEvents = 'none';
			feedbackOverlayEl.appendChild(span);
			try {
				const a = annotate(span, {
					type: 'highlight',
					color: accent,
					strokeWidth: 1.5,
					iterations: 1,
					animationDuration: 0,
					animate: false,
					multiline: false
				});
				a.show();
				feedbackAnnotations.push(a);
			} catch (e) {
				console.error('[roughAnnot] annotate failed', e);
			}
		}
	}

	function updateDiff() {
		if (!editor) return;
		setDiffState({
			baseline: currentBaseline,
			userEditRegions: currentRegions,
			feedbackSelection: feedbackSelectionRange,
			allRoundsTiny
		});
		// Kick the plugin so it re-renders decorations with the new state.
		editor.view.dispatch(editor.state.tr.setMeta('diffOverlay', true));
	}

	function startCountdown() {
		idleDeadline = Date.now() + IDLE_MS;
		submitCountdown.set(Math.ceil(IDLE_MS / 1000));
		if (countdownInterval) clearInterval(countdownInterval);
		countdownInterval = setInterval(() => {
			const remaining = Math.max(0, Math.ceil((idleDeadline - Date.now()) / 1000));
			submitCountdown.set(remaining);
			if (remaining === 0) {
				if (countdownInterval) clearInterval(countdownInterval);
				countdownInterval = null;
			}
		}, 200);
	}

	function clearCountdown() {
		if (countdownInterval) {
			clearInterval(countdownInterval);
			countdownInterval = null;
		}
		submitCountdown.set(0);
	}

	function onEditorUpdate({ transaction }: { transaction: any }) {
		if (!editor) return;

		// Skip ALL side effects for Yjs-sync-originated transactions. These
		// fire during initial Y.Doc hydration (sometimes before state has
		// fully applied, returning an empty markdown) and during remote
		// updates. If we touch userMd or writeToDisk here, we can wipe
		// document.md mid-hydration. The post-mount code handles the initial
		// userMd seed; subsequent sync transactions from the network don't
		// need a write-through since the sending client is already persisting.
		const fromYjsSync = transaction.getMeta(ySyncPluginKey) !== undefined;
		if (fromYjsSync) return;

		const md = getEditorMarkdown();

		// Push current markdown to the store (for Outline, render submission)
		// and debounce a write-through to document.md.
		userMd.set(md);
		if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
		writeDebounceTimer = setTimeout(() => writeToDisk(md), 50);

		// applyAgentMarkdown dispatches via editor.view.dispatch — that's NOT
		// a sync transaction, so it passes the filter above and reaches the
		// autosave path (good — we want to persist agent edits). But it
		// should NOT restart the idle countdown, otherwise every agent
		// render would queue another one ten seconds later in a loop.
		if (isAgentApplyInProgress()) {
			// Agent op (apply or undo) just changed the doc. The plaintext
			// char indices we stored in `userEditRegions` are now stale —
			// their positions have shifted. Clear them so the diff overlay
			// doesn't exclude the wrong spots on the next render. Small
			// cost: user typing that happened BEFORE this agent op is no
			// longer known, but it also no longer needs exclusion because
			// it's either still in the doc (and part of whatever diff we
			// compute) or replaced by the agent.
			userEditRegions.set([]);
			return;
		}

		// Track user-typed ranges in plaintext coordinates so the diff
		// overlay can subtract them from its "agent added" (green)
		// decorations. Without this, the user's own keystrokes during a
		// pending review get painted green alongside the agent's text.
		if (transaction.docChanged) {
			recordUserEdit(transaction);
		}

		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();
		idleTimer = setTimeout(() => {
			clearCountdown();
			if (onSubmit) onSubmit();
		}, IDLE_MS);
	}

	/** Walk a user transaction's ReplaceStep mappings, convert each inserted
	 * range to plaintext indices, and push an entry onto userEditRegions.
	 * We only track INSERTS — deletes don't show up as `diff-added` anyway.
	 *
	 * Plaintext indices are what `diff-overlay.ts` uses (it walks
	 * `state.doc.descendants` and counts characters in text nodes). We do
	 * the same count here on the doc AFTER the transaction. */
	function recordUserEdit(transaction: any) {
		if (!editor) return;
		const doc = editor.state.doc;
		// Build plaintext index from PM position — same walk the overlay does.
		function plainIndexAt(pmPos: number): number {
			let idx = 0;
			let found = -1;
			doc.descendants((node: any, pos: number) => {
				if (found >= 0) return false;
				if (node.isText) {
					const text = node.text || '';
					for (let i = 0; i < text.length; i++) {
						if (pos + i >= pmPos) {
							found = idx;
							return false;
						}
						idx++;
					}
				}
				return true;
			});
			return found >= 0 ? found : idx;
		}
		const newRegions: UserEditRegion[] = [];
		const now = Date.now();
		for (const step of transaction.steps as any[]) {
			// ReplaceStep-ish: has from/to (old range) and slice (new content).
			const from: number = step.from ?? -1;
			const sliceSize: number = step.slice?.content?.size ?? 0;
			if (from < 0 || sliceSize === 0) continue;
			// After the transaction, inserted content occupies [from, from+sliceSize)
			// in the new doc positions.
			const startIdx = plainIndexAt(from);
			const endIdx = plainIndexAt(from + sliceSize);
			if (endIdx > startIdx) {
				newRegions.push({ from: startIdx, to: endIdx, timestamp: now });
			}
		}
		if (newRegions.length === 0) return;
		// Keep only regions from the last 90s to bound memory and stale
		// matches — 90s is well past any realistic "typed during review"
		// window and covers the 3s idle + agent round time.
		const cutoff = now - 90_000;
		userEditRegions.update((prev) =>
			[...prev.filter((r) => r.timestamp >= cutoff), ...newRegions]
		);
	}

	onMount(async () => {
		// Wait for IndexedDB to hydrate the Y.Doc from any previously persisted
		// state. If it's the very first mount (or IndexedDB was cleared), the
		// Y.Doc will be empty and we seed it from the server's document.md.
		const ydoc = getYDoc();
		await whenYDocReady();

		if (isYDocEmpty()) {
			// `userMd` should already have been populated by +page.svelte's
			// loadTab() before we mounted. Seed the Y.Doc from it, using the
			// right parser for the tab kind so plain-text files don't get
			// turned into markdown headings etc.
			let initialMd = '';
			userMd.subscribe((v) => (initialMd = v))();
			if (initialMd) seedYDocFromContent(initialMd, kind);
		}

		editor = new Editor({
			element,
			extensions: [
				...collaborativeExtensions(ydoc, { placeholder: 'Start writing...', kind }),
				DiffOverlay
			],
			// Collaboration provides initial content from the Y.Doc; do NOT
			// pass a string `content` here (doing so would wipe the Y.Doc).
			editorProps: {
				attributes: { class: `tiptap-content ${kind === 'plain' ? 'tiptap-plain' : ''}` },
				// Cmd/Ctrl+Enter wakes the agent immediately, skipping the
				// idle countdown. Plain Enter still inserts a new line.
				handleKeyDown: (_view, event) => {
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
						clearCountdown();
						if (onSubmit) onSubmit();
						return true;
					}
					return false;
				}
			},
			onUpdate: ({ transaction }) => onEditorUpdate({ transaction }),
			onSelectionUpdate: () => handleSelectionChange(),
			onBlur: () => {
				setTimeout(() => {
					if (feedbackPopupEl && feedbackPopupEl.contains(document.activeElement)) return;
					feedbackPopup = null;
					feedbackInput = '';
				}, 150);
			}
		});

		// Prime the store and the write-through tracker with the Y.Doc's
		// current content, so we don't re-save unchanged text on first tick.
		const initialMd = getEditorMarkdown();
		userMd.set(initialMd);
		lastWrittenMd = initialMd;
		updateDiff();

		// Dev-only: expose the editor on window for stress tests and
		// interactive debugging via devtools. Guarded so production bundles
		// don't leak a global.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			(window as any).__docwriterEditor = editor;
		}
	});

	onDestroy(() => {
		// Fire any pending debounced write before tearing down — switching
		// tabs fast (within the 50ms debounce) used to drop the last few
		// keystrokes since onDestroy ran before the timer fired.
		if (writeDebounceTimer) {
			clearTimeout(writeDebounceTimer);
			writeDebounceTimer = null;
			void writeToDisk(getEditorMarkdown());
		}
		// Tear down any rough-notation annotations so their SVGs don't leak.
		for (const a of feedbackAnnotations) a.remove();
		feedbackAnnotations = [];
		if (editor) editor.destroy();
		// Clear the dev-only window handle so tests (or anyone polling on it)
		// don't see a destroyed editor between tab switches.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			if ((window as any).__docwriterEditor === editor) {
				(window as any).__docwriterEditor = null;
			}
		}
		disposeAgentUndo();
		if (idleTimer) clearTimeout(idleTimer);
		if (countdownInterval) clearInterval(countdownInterval);
	});

	let rendering = $state(false);
	isRendering.subscribe((v) => {
		rendering = v;
		if (v) {
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
			clearCountdown();
		}
	});

	// Export the live editor instance so +page.svelte can apply agent
	// markdown via applyAgentMarkdown(). We expose it via the reviewBaseline
	// callback path rather than a global to keep ownership clear.
	export function getEditor(): Editor | undefined {
		return editor;
	}
</script>

<div
	class="tiptap-wrapper"
	class:feedback-active={feedbackSelectionRange !== null}
	style:--font-scale={fontScale}
>
	<div class="tiptap-editor" bind:this={element}></div>
	<!-- Feedback selection overlay: absolutely positioned above the editor,
	     outside PM's DOM tree so rough-notation's SVG isn't clobbered by
	     PM's state-sync. refreshFeedbackOverlay fills this with empty spans
	     sized to the selection's client rects, then annotates each. -->
	<div class="feedback-overlay" bind:this={feedbackOverlayEl} aria-hidden="true"></div>
	{#if feedbackPopup}
		<div
			class="feedback-popup"
			class:flip-below={feedbackPopup.flipBelow}
			style:left="{feedbackPopup.x}px"
			style:top="{feedbackPopup.y}px"
			bind:this={feedbackPopupEl}
			role="toolbar"
		>
			<div class="feedback-quote">
				"{feedbackPopup.text.slice(0, 200)}{feedbackPopup.text.length > 200 ? '…' : ''}"
			</div>
			<div class="feedback-input-row">
				<textarea
					class="feedback-input"
					bind:value={feedbackInput}
					oninput={(e) => {
						const el = e.currentTarget;
						el.style.height = 'auto';
						el.style.height = el.scrollHeight + 'px';
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCustomFeedback(); }
						if (e.key === 'Escape') { feedbackPopup = null; feedbackInput = ''; }
					}}
					placeholder="What's wrong with this?"
					rows={1}
				></textarea>
				<button class="feedback-submit" onclick={sendCustomFeedback}>Go</button>
			</div>
			<div class="quick-actions">
				{#each pinnedActions as action}
					<button
						class="quick-btn pinned"
						style:--action-color={action.color}
						onclick={() => sendFeedback(action)}
						title={action.label}
					>
						{action.label}
					</button>
				{/each}
				{#each recent.slice(0, 4) as action}
					<button
						class="quick-btn"
						style:--action-color={action.color}
						onclick={() => sendFeedback(action)}
						title={action.label}
					>
						{action.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.tiptap-wrapper {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 48px 32px;
		background: var(--bg);
	}
	/* Feedback overlay sits on top of the prose but doesn't intercept clicks.
	 * refreshFeedbackOverlay() fills this with absolutely-positioned empty
	 * spans sized to each client rect of the current selection, then calls
	 * rough-notation's annotate() on them. */
	.feedback-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 2;
	}
	/* When feedback overlay is active, suppress the browser's native
	 * ::selection color inside the prose — otherwise it stacks with
	 * rough-notation's marker tint. Selection is still logically active
	 * (cursor state, copy/paste work); just the color goes transparent. */
	.tiptap-wrapper.feedback-active :global(.tiptap-content ::selection) {
		background: transparent;
	}
	.tiptap-wrapper.feedback-active :global(.tiptap-content *::selection) {
		background: transparent;
	}
	.tiptap-editor :global(.tiptap-content) {
		max-width: 680px;
		margin: 0 auto;
		outline: none;
		font-family: 'Lora', Georgia, serif;
		font-size: calc(17px * var(--font-scale, 1));
		line-height: 1.75;
		color: var(--prose-text);
		overflow-wrap: break-word;
	}
	/* Plain-text mode: Geist Mono — clean, modern, narrow letterforms that
	 * read like a writing app rather than a code editor. Tight line-height
	 * + narrow column for focus; ui-monospace is the OS fallback. */
	.tiptap-editor :global(.tiptap-plain) {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(15px * var(--font-scale, 1));
		line-height: 1.45;
		max-width: 760px;
		white-space: pre-wrap;
		tab-size: 2;
	}
	/* Zero out paragraph margins — every line is its own paragraph in plain
	 * mode, so any vertical margin becomes visible blank-line gaps. Empty
	 * paragraphs need a min-height to stay visible (the ProseMirror
	 * trailing break adds the space, but we ensure a consistent one). */
	.tiptap-editor :global(.tiptap-plain p) {
		margin: 0;
		min-height: 1em;
	}
	.tiptap-editor :global(.tiptap-content p) { margin: 0 0 10px; }

	/* When the magic-highlighter decoration is painting a selection for
	 * feedback, hide the browser's native ::selection color inside that
	 * range so the two don't stack into a double-tint. Browser selection
	 * still applies outside the decorated range. */
	.tiptap-editor :global(.tiptap-content .feedback-select::selection) {
		background: transparent;
	}
	/* `<mark>` from the Highlight extension: theme-aware flat tint (no
	 * rough-notation for persistent marks since they can be many). */
	.tiptap-editor :global(.tiptap-content mark) {
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		color: inherit;
		padding: 0 2px;
		border-radius: 2px;
	}
	/* Feedback-selected text gets the rough-notation marker stroke via JS
	 * (see refreshFeedbackOverlay) — this class only exists to give us
	 * a queryable hook; it intentionally has no background. */
	.tiptap-editor :global(.tiptap-content .feedback-select) {
		color: inherit;
	}
	.tiptap-editor :global(.tiptap-content h1) { font-size: calc(28px * var(--font-scale, 1)); font-weight: 700; margin: 32px 0 16px; color: var(--text); }
	.tiptap-editor :global(.tiptap-content h2) { font-size: calc(22px * var(--font-scale, 1)); font-weight: 600; margin: 28px 0 12px; color: var(--text); }
	.tiptap-editor :global(.tiptap-content h3) { font-size: calc(18px * var(--font-scale, 1)); font-weight: 600; margin: 24px 0 8px; color: var(--text); }
	.tiptap-editor :global(.tiptap-content ul),
	.tiptap-editor :global(.tiptap-content ol) { padding-left: 24px; margin: 4px 0 10px; }
	.tiptap-editor :global(.tiptap-content li) { margin-bottom: 4px; }
	.tiptap-editor :global(.tiptap-content li p) { margin: 0; }
	.tiptap-editor :global(.tiptap-content blockquote) {
		border-left: 3px solid var(--border-light);
		padding-left: 12px;
		margin: 4px 0 10px;
		color: var(--text-muted);
	}
	.tiptap-editor :global(.tiptap-content hr) {
		border: none;
		border-top: 1px solid var(--border-light);
		margin: 24px 0;
	}
	.tiptap-editor :global(.tiptap-content img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		margin: 8px 0;
	}
	.tiptap-editor :global(.tiptap-content .md-table),
	.tiptap-editor :global(.tiptap-content table) {
		border-collapse: collapse;
		margin: 8px 0 16px;
		width: 100%;
		overflow: hidden;
		font-size: calc(15px * var(--font-scale, 1));
	}
	.tiptap-editor :global(.tiptap-content th),
	.tiptap-editor :global(.tiptap-content td) {
		border: 1px solid var(--border-light);
		padding: 6px 10px;
		text-align: left;
		vertical-align: top;
	}
	.tiptap-editor :global(.tiptap-content th) {
		background: var(--bg-surface);
		font-weight: 600;
	}
	/* Task list: tiptap renders each TaskItem as a <li data-checked="...">
	 * containing a <label><input type="checkbox">...</label> and a <div>
	 * with the content. Use a grid so the checkbox lives in a fixed
	 * column and the first line of text center-aligns with it cleanly. */
	.tiptap-editor :global(.tiptap-content ul[data-type="taskList"]) {
		list-style: none;
		padding-left: 8px;
	}
	.tiptap-editor :global(.tiptap-content ul[data-type="taskList"] li) {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: start;
		column-gap: 8px;
		margin-bottom: 3px;
	}
	.tiptap-editor :global(.tiptap-content ul[data-type="taskList"] li > label) {
		/* Line the checkbox up with the text baseline of the first line of
		 * the item. The first-line leading is (line-height - 1em) / 2, which
		 * at line-height: 1.75 works out to ~0.375em of space above the
		 * cap-height; translating the checkbox down by that amount centers
		 * it on the x-height of the first line. */
		display: flex;
		align-items: center;
		height: 1.75em;
	}
	.tiptap-editor :global(.tiptap-content ul[data-type="taskList"] li > label input[type="checkbox"]) {
		margin: 0;
	}
	.tiptap-editor :global(.tiptap-content ul[data-type="taskList"] li[data-checked="true"] > div) {
		color: var(--text-faint);
		text-decoration: line-through;
	}
	.tiptap-editor :global(.tiptap-content .is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--text-faint);
		float: left;
		height: 0;
		pointer-events: none;
	}
	/* Diff decoration classes, applied by the DiffOverlay extension */
	.tiptap-editor :global(.diff-added) {
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
	}
	.tiptap-editor :global(.diff-removed) {
		color: var(--diff-removed-color);
		text-decoration: line-through;
		opacity: 0.7;
	}
	/* Ghost strikethrough widget for agent removals. The removed text isn't
	 * in the editor's doc tree (the editor displays the live Y.Doc state),
	 * so we inject this inline span at the position the text used to occupy. */
	.tiptap-editor :global(.diff-removed-widget) {
		color: var(--diff-removed-color);
		background: color-mix(in srgb, var(--diff-removed-color) 12%, transparent);
		text-decoration: line-through;
		opacity: 0.75;
		padding: 0 3px;
		border-radius: 3px;
		user-select: none;
	}
	/* Tiny-edit variants: when every pending round is small (< ~25 chars
	 * delta, e.g. a typo fix), drop the solid green/red treatment and use
	 * a ghost-like muted style so the diff reads as "a small suggestion"
	 * rather than "the agent rewrote a paragraph". Background gone; text
	 * takes just a subtle color + thin underline/strike. */
	.tiptap-editor :global(.diff-added.diff-added-tiny) {
		color: var(--diff-added-color);
		background: transparent;
		border-bottom: 1px dotted color-mix(in srgb, var(--diff-added-color) 60%, transparent);
	}
	.tiptap-editor :global(.diff-removed-widget.diff-removed-tiny) {
		background: transparent;
		color: color-mix(in srgb, var(--diff-removed-color) 70%, var(--text-faint));
		opacity: 0.6;
		padding: 0 1px;
	}
	.feedback-popup {
		position: fixed;
		transform: translate(-50%, -100%);
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
		padding: 10px 10px 8px;
		width: 340px;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		font-family: 'Inter', -apple-system, sans-serif;
		z-index: 100;
		/* Hard clip in case any child escapes its bounds (long unbreakable
		 * words in the quoted passage or a feedback label). */
		overflow: hidden;
	}
	.feedback-popup.flip-below {
		transform: translate(-50%, 0);
	}
	.feedback-quote {
		font-size: 12px;
		color: var(--text-faint);
		margin-bottom: 7px;
		padding: 0 2px;
		line-height: 1.35;
		font-style: italic;
		/* Wrap long selections onto up to 3 lines, then truncate. Using
		 * -webkit-line-clamp (works in Chrome/Safari/Firefox as of 2024). */
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
		overflow-wrap: anywhere;
		max-width: 100%;
		min-width: 0;
	}
	.feedback-input-row {
		display: flex;
		gap: 6px;
		align-items: stretch;
	}
	.feedback-input {
		flex: 1;
		min-width: 0;
		max-width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 7px 10px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
		color: var(--text);
		background: var(--bg);
		resize: none;
		overflow: hidden;
		line-height: 1.4;
		min-height: 32px;
		max-height: 120px;
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.feedback-input::placeholder {
		color: var(--text-faint);
	}
	.feedback-input:focus {
		border-color: var(--accent);
	}
	.feedback-submit {
		padding: 0 14px;
		border-radius: 6px;
		border: none;
		background: var(--accent);
		color: white;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
	}
	.feedback-submit:hover { filter: brightness(0.92); }
	.quick-actions {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 7px;
	}
	.quick-btn {
		padding: 3px 9px;
		border-radius: 4px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
		font-family: inherit;
		/* Long custom-feedback labels truncate with an ellipsis; full text is
		 * surfaced by the `title` attribute on hover. */
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.quick-btn.pinned {
		color: var(--action-color);
		border-color: color-mix(in srgb, var(--action-color) 30%, var(--border-light));
	}
	.quick-btn:hover {
		background: color-mix(in srgb, var(--action-color) 10%, transparent);
		border-color: var(--action-color);
		color: var(--action-color);
	}
</style>
