<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import type { Transaction } from '@tiptap/pm/state';
	import { ySyncPluginKey } from 'y-prosemirror';
	import { DiffOverlay, setDiffState } from './diff-overlay';
	import { collaborativeExtensions } from '$lib/editor-extensions';
	import { getYDoc, whenYDocReady, isYDocEmpty, getCurrentTab } from '$lib/yjs-doc';
	import { seedYDocFromContent } from '$lib/yjs-markdown';
	import { AGENT_APPLY_KEY } from '$lib/yjs-agent';
	import {
		userMd,
		reviewBaseline,
		annotations,
		isRendering,
		submitCountdown,
		editorFontScale,
		pinnedActions,
		recentActions,
		trackActionUsage,
		pendingReviewRounds
	} from '$lib/stores';
	import type { Action, Annotation } from '$lib/types';

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
	let plainLineCount = $state(1);
	let pointerSelecting = false;
	let shouldFocusFeedbackInput = false;
	let detachFeedbackPointerHandlers: (() => void) | null = null;

	// Feedback popup: floating toolbar when the user selects text. Shows
	// pinned actions + LRU recent actions + an open-ended text input.
	let feedbackPopup = $state<{ text: string; x: number; y: number; flipBelow: boolean } | null>(null);
	let feedbackPopupEl: HTMLDivElement | null = $state(null);
	let feedbackInputEl: HTMLDivElement | null = $state(null);
	let feedbackInput = $state('');
	let recent: Action[] = $state([]);
	recentActions.subscribe((v) => (recent = v));

	function updateFeedbackPopup(autoFocus = false) {
		if (!editor || !editor.isFocused) return;
		const { from, to, empty } = editor.state.selection;
		if (empty || to - from < 2) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		const selectedText = editor.state.doc.textBetween(from, to, ' ');
		if (!selectedText.trim()) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		const start = editor.view.coordsAtPos(from);
		const end = editor.view.coordsAtPos(to);
		const x = (start.left + end.right) / 2;
		const POPUP_H_APPROX = 140;
		const flipBelow = start.top < POPUP_H_APPROX + 20;
		const y = flipBelow ? end.bottom + 8 : start.top - 8;
		shouldFocusFeedbackInput = autoFocus;
		feedbackPopup = { text: selectedText, x, y, flipBelow };
		feedbackSelectionRange = { from, to };
		updateDiff();
	}

	function handleSelectionChange() {
		if (pointerSelecting) return;
		updateFeedbackPopup(false);
	}

	$effect(() => {
		if (!feedbackPopup || !shouldFocusFeedbackInput) return;
		shouldFocusFeedbackInput = false;
		requestAnimationFrame(() => feedbackInputEl?.focus());
	});

	$effect(() => {
		if (!feedbackInputEl) return;
		const text = feedbackInput;
		if (feedbackInputEl.textContent !== text) {
			feedbackInputEl.textContent = text;
		}
	});

	function closeFeedbackPopup() {
		feedbackPopup = null;
		feedbackInput = '';
		feedbackSelectionRange = null;
		shouldFocusFeedbackInput = false;
		updateDiff();
	}

	function deleteSelectedTextFromEditor() {
		if (!editor || !feedbackSelectionRange) return;
		const { from, to } = feedbackSelectionRange;
		editor.chain().focus().setTextSelection({ from, to }).deleteSelection().run();
		closeFeedbackPopup();
	}

	function sendFeedback(action: Action) {
		if (!feedbackPopup) return;
		const text = feedbackPopup.text;
		addFeedbackAnnotation(action.label, text);
		trackActionUsage(action.label);
		if (!action.pinned) {
			recentActions.update((prev) => [action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6));
		}
		closeFeedbackPopup();
		if (onSubmit) onSubmit(`The user flagged this passage as "${action.label}". Rewrite it to address that: "${text}"`);
	}

	function sendCustomFeedback() {
		if (!feedbackPopup || !feedbackInput.trim()) return;
		const text = feedbackPopup.text;
		const fb = feedbackInput.trim();
		addFeedbackAnnotation(fb, text);
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
		closeFeedbackPopup();
		if (onSubmit) onSubmit(`The user flagged this passage with feedback "${fb}". Rewrite it to address that: "${text}"`);
	}

	function addFeedbackAnnotation(comment: string, excerpt: string) {
		const range = feedbackSelectionRange;
		const tabId = getCurrentTab();
		if (!range || !tabId) return;
		annotations.update((prev) => [
			{
				id: 'anno_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
				tabId,
				excerpt,
				comment,
				from: range.from,
				to: range.to,
				timestamp: Date.now()
			},
			...prev
		]);
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

	function syncPlainLineCount() {
		if (!editor || kind !== 'plain') return;
		plainLineCount = Math.max(1, editor.state.doc.childCount);
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

	let currentAnnotations: Annotation[] = [];
	annotations.subscribe((v) => {
		currentAnnotations = v;
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

	function updateDiff() {
		if (!editor) return;
		setDiffState(editor, {
			baseline: currentBaseline,
			annotations: currentAnnotations.filter((annotation) => annotation.tabId === getCurrentTab()),
			activeFeedbackRange: feedbackSelectionRange,
			isPlainText: kind === 'plain',
			allRoundsTiny
		});
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

	function scheduleAutosave(md: string) {
		if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
		writeDebounceTimer = setTimeout(() => writeToDisk(md), 50);
	}

	function restartIdleCountdown() {
		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();
		idleTimer = setTimeout(() => {
			clearCountdown();
			if (onSubmit) onSubmit();
		}, IDLE_MS);
	}

	type UpdateKind = 'yjs-remote' | 'agent-apply' | 'user-edit';

	function classifyUpdate(transaction: Transaction): UpdateKind {
		const syncMeta = transaction.getMeta(ySyncPluginKey);
		if (transaction.getMeta(AGENT_APPLY_KEY) || syncMeta?.isUndoRedoOperation) return 'agent-apply';
		if (syncMeta !== undefined) return 'yjs-remote';
		return 'user-edit';
	}

	/**
	 * Update policy
	 * ┌─────────────┬──────────┬────────────┐
	 * │    Kind     │ Autosave │ Idle timer │
	 * ├─────────────┼──────────┼────────────┤
	 * │ yjs-remote  │ skip     │ skip       │
	 * ├─────────────┼──────────┼────────────┤
	 * │ agent-apply │ run      │ skip       │
	 * ├─────────────┼──────────┼────────────┤
	 * │ user-edit   │ run      │ restart    │
	 * └─────────────┴──────────┴────────────┘
	 */
	function onEditorUpdate({ transaction }: { transaction: Transaction }) {
		if (!editor) return;
		syncPlainLineCount();
		const kind = classifyUpdate(transaction);
		if (kind === 'yjs-remote') return;
		const md = getEditorMarkdown();
		userMd.set(md);
		scheduleAutosave(md);
		if (kind === 'user-edit') restartIdleCountdown();
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
			onSelectionUpdate: () => handleSelectionChange(),
			onBlur: () => {
				setTimeout(() => {
					if (feedbackPopupEl && feedbackPopupEl.contains(document.activeElement)) return;
					closeFeedbackPopup();
				}, 150);
			}
		});

		const editorRoot = editor.view.dom;
		const handlePointerDown = () => {
			pointerSelecting = true;
			shouldFocusFeedbackInput = false;
		};
		const handlePointerUp = () => {
			if (!pointerSelecting) return;
			pointerSelecting = false;
			requestAnimationFrame(() => requestAnimationFrame(() => updateFeedbackPopup(true)));
		};
		editorRoot.addEventListener('pointerdown', handlePointerDown);
		window.addEventListener('pointerup', handlePointerUp);

		// Prime the store and the write-through tracker with the Y.Doc's
		// current content, so we don't re-save unchanged text on first tick.
		const initialMd = getEditorMarkdown();
		userMd.set(initialMd);
		lastWrittenMd = initialMd;
		syncPlainLineCount();
		updateDiff();
		editor.on('update', ({ transaction }) => onEditorUpdate({ transaction }));

		// Dev-only: expose the editor on window for stress tests and
		// interactive debugging via devtools. Guarded so production bundles
		// don't leak a global.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			(window as any).__docwriterEditor = editor;
		}

		detachFeedbackPointerHandlers = () => {
			editorRoot.removeEventListener('pointerdown', handlePointerDown);
			window.removeEventListener('pointerup', handlePointerUp);
		};
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
		if (editor) editor.destroy();
		detachFeedbackPointerHandlers?.();
		detachFeedbackPointerHandlers = null;
		// Clear the dev-only window handle so tests (or anyone polling on it)
		// don't see a destroyed editor between tab switches.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			if ((window as any).__docwriterEditor === editor) {
				(window as any).__docwriterEditor = null;
			}
		}
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
	class:plain-mode-wrapper={kind === 'plain'}
	style:--font-scale={fontScale}
>
	{#if kind === 'plain'}
		<div class="plain-editor-shell">
			<div class="plain-line-gutter" aria-hidden="true">
				{#each Array.from({ length: plainLineCount }, (_, i) => i + 1) as line}
					<div class="plain-line-number">{line}</div>
				{/each}
			</div>
			<div class="tiptap-editor plain-mode" bind:this={element}></div>
		</div>
	{:else}
		<div class="tiptap-editor" bind:this={element}></div>
	{/if}
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
				<div
					class="feedback-input"
					bind:this={feedbackInputEl}
					contenteditable="true"
					role="textbox"
					aria-multiline="true"
					tabindex="0"
					data-empty={feedbackInput.trim() ? 'false' : 'true'}
					oninput={(e) => {
						const el = e.currentTarget as HTMLDivElement;
						feedbackInput = (el.textContent || '').replace(/\u00A0/g, ' ');
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCustomFeedback(); }
						if (e.key === 'Escape') { closeFeedbackPopup(); }
						if (
							(e.key === 'Backspace' || e.key === 'Delete') &&
							!feedbackInput.trim() &&
							feedbackSelectionRange
						) {
							e.preventDefault();
							deleteSelectedTextFromEditor();
						}
					}}
				></div>
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
				{#each recent.slice(0, 6) as action}
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
	.tiptap-wrapper.plain-mode-wrapper {
		overflow: auto;
	}
	.plain-editor-shell {
		display: grid;
		grid-template-columns: 52px minmax(0, 1fr);
		gap: 18px;
		width: max-content;
		min-width: 100%;
		max-width: none;
		margin: 0 auto;
		align-items: start;
	}
	.plain-line-gutter {
		padding: 2px 12px 0 0;
		border-right: 1px solid var(--border-light);
		color: var(--text-faint);
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(15px * var(--font-scale, 1));
		line-height: 1.45;
		text-align: right;
		user-select: none;
		pointer-events: none;
		background: color-mix(in srgb, var(--bg-surface) 52%, transparent);
	}
	.plain-line-number {
		height: 1.45em;
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
	.tiptap-editor.plain-mode :global(.tiptap-content) {
		max-width: none;
		margin: 0;
	}
	/* Plain-text mode: Geist Mono — clean, modern, narrow letterforms that
	 * read like a writing app rather than a code editor. Tight line-height
	 * + narrow column for focus; ui-monospace is the OS fallback. */
	.tiptap-editor :global(.tiptap-plain) {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(15px * var(--font-scale, 1));
		line-height: 1.45;
		white-space: pre;
		overflow-wrap: normal;
		tab-size: 2;
	}
	/* Zero out paragraph margins — every line is its own paragraph in plain
	 * mode, so any vertical margin becomes visible blank-line gaps. Empty
	 * paragraphs need a min-height to stay visible (the ProseMirror
	 * trailing break adds the space, but we ensure a consistent one). */
	.tiptap-editor :global(.tiptap-plain p) {
		margin: 0;
		min-height: 1.45em;
	}
	.tiptap-editor :global(.tiptap-content:not(.tiptap-plain) p) { margin: 0 0 10px; }

	/* `<mark>` from the Highlight extension: theme-aware flat tint (no
	 * rough-notation for persistent marks since they can be many). */
	.tiptap-editor :global(.tiptap-content mark) {
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		color: inherit;
		padding: 0 2px;
		border-radius: 2px;
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
	.tiptap-editor :global(.feedback-annotation) {
		position: relative;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-bottom: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
		cursor: help;
	}
	.tiptap-editor :global(.feedback-annotation:hover::after) {
		content: attr(data-feedback-comment);
		position: absolute;
		left: 0;
		bottom: calc(100% + 10px);
		z-index: 40;
		display: block;
		width: max-content;
		max-width: min(420px, 60vw);
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);
		color: var(--text);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 12.5px;
		font-style: normal;
		font-weight: 500;
		line-height: 1.45;
		letter-spacing: 0;
		white-space: normal;
		word-break: break-word;
		overflow-wrap: anywhere;
		pointer-events: none;
	}
	.tiptap-editor :global(.feedback-selection) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent) 42%, transparent);
		border-radius: 2px;
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
		display: block;
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
		line-height: 1.4;
		min-height: 32px;
		max-height: 120px;
		overflow-y: auto;
		word-break: break-word;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.feedback-input[data-empty='true']::before {
		content: "What's wrong with this?";
		color: var(--text-faint);
		pointer-events: none;
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
		display: inline-block;
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
		max-width: min(100%, 320px);
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
