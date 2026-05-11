<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import { TextSelection, type Transaction } from '@tiptap/pm/state';
	import { ySyncPluginKey } from 'y-prosemirror';
	import { DiffOverlay, setDiffState } from './diff-overlay';
	import { CommentOverlay, setCommentOverlayState } from './comment-overlay';
	import { CelebrationOverlay, flashCelebration } from './celebration-overlay';
	import {
		FindOverlay,
		findKey,
		openFind,
		closeFind,
		setFindQuery,
		findStep,
		type FindState
	} from './find-overlay';
	import FindBar from '$lib/components/FindBar.svelte';
	import PreviewButton from '$lib/components/PreviewButton.svelte';
	import CommentGutter from '$lib/components/CommentGutter.svelte';
	import { Crosshair } from 'lucide-svelte';
	import { collaborativeExtensions } from '$lib/editor-extensions';
	import { getYDoc, whenYDocReady, getCurrentTab, waitForCurrentTabSync } from '$lib/yjs-doc';
	import {
		reviewBaseline,
		annotations,
		isRendering,
		submitCountdown,
		editorFontScale,
		editorSoftWrap,
		pinnedActions,
		recentActions,
		trackActionUsage,
		pendingReviewRounds,
		commentThreads,
		openCommentThreadId,
		activeTab
	} from '$lib/stores';
	import type { Action, Annotation, CommentThread, FeedbackMode } from '$lib/types';

	const IDLE_MS = 3_000;

	interface Props {
		onSubmit?: (trigger?: string) => void;
		/** One-shot scroll restore. Read once in onMount after the editor's
		 * content has laid out, then ignored. The parent captures this from
		 * `getScrollTop()` before tearing the editor down (Accept / Reject /
		 * file reload) so the user keeps their place across the remount. */
		initialScrollTop?: number;
	}
	let { onSubmit, initialScrollTop = 0 }: Props = $props();

	let element: HTMLDivElement;
	let wrapperEl: HTMLDivElement | null = null;
	let editor: Editor | undefined = $state();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let idleDeadline = 0;
	let plainMetricsRaf = 0;
	let plainResizeObserver: ResizeObserver | null = null;

	let fontScale = $state(1.0);
	editorFontScale.subscribe((v) => (fontScale = v));
	let softWrap = $state(false);
	editorSoftWrap.subscribe((v) => (softWrap = v));
	let plainLineRows = $state<string[]>(['1']);
	let hasPendingProposal = false;
	let pointerSelecting = false;
	let shouldFocusFeedbackInput = false;
	let detachFeedbackPointerHandlers: (() => void) | null = null;

	// Feedback popup: floating toolbar when the user selects text. Shows
	// pinned actions + LRU recent actions + an open-ended text input.
	let feedbackPopup = $state<{ text: string; x: number; y: number; flipBelow: boolean; anchorTop: number; anchorBottom: number } | null>(null);
	let feedbackPopupEl: HTMLDivElement | null = $state(null);

	// Mirror of the FindOverlay plugin state, kept in sync via the editor's
	// `update` event below. Drives the FindBar's input, counter, and
	// match-stepping buttons.
	let findState = $state<FindState>({
		open: false,
		query: '',
		caseSensitive: false,
		matches: [],
		currentIdx: -1
	});
	let feedbackInputEl: HTMLDivElement | null = $state(null);
	let feedbackInput = $state('');
	/** Routing mode for the current feedback submission. `auto` lets the
	 * agent decide comment vs. edit; `edit` forces an edit_doc call;
	 * `discuss` forces a post_comment call. Resets to `auto` whenever the
	 * popup closes so each feedback session starts fresh. */
	let feedbackMode = $state<FeedbackMode>('auto');

	// Comment thread state — mirrors the commentThreads store for local
	// use in the overlay and the gutter component.
	let threadsForTab: CommentThread[] = $state([]);
	let openThreadId = $state<string | null>(null);
	commentThreads.subscribe((v) => {
		threadsForTab = v;
		syncCommentOverlay();
	});
	openCommentThreadId.subscribe((v) => {
		openThreadId = v;
		syncCommentOverlay();
	});
	let recent: Action[] = $state([]);
	recentActions.subscribe((v) => (recent = v));

	function updateFeedbackPopup(autoFocus = false) {
		if (!editor || !editor.isFocused) return;
		const selection = editor.state.selection;
		const { from, to, empty } = selection;
		// Clicking a contenteditable=false diff widget (agent-added block) creates
		// a NodeSelection spanning the whole widget — to the user this looks like
		// the paragraph auto-selected on a bare click. Only treat genuine text
		// selections as feedback selections.
		if (!(selection instanceof TextSelection) || empty || to - from < 2) {
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
		const POPUP_W_APPROX = 340;
		const MARGIN = 12;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Anchor the popup to the visible edge of the selection. For giant
		// selections (Select All) the real top/bottom are off-screen, so
		// clamp to the viewport. Actual popup height is applied in an effect
		// after the element mounts (see clamp effect below).
		const anchorTop = Math.max(MARGIN, Math.min(vh - MARGIN, start.top));
		const anchorBottom = Math.max(MARGIN, Math.min(vh - MARGIN, end.bottom));
		const POPUP_H_GUESS = 140;
		const flipBelow = anchorTop < POPUP_H_GUESS + 20 && vh - anchorBottom > anchorTop;
		const y = flipBelow ? anchorBottom + 8 : anchorTop - 8;
		let x = (start.left + end.right) / 2;
		x = Math.max(POPUP_W_APPROX / 2 + MARGIN, Math.min(vw - POPUP_W_APPROX / 2 - MARGIN, x));
		shouldFocusFeedbackInput = autoFocus;
		feedbackPopup = { text: selectedText, x, y, flipBelow, anchorTop, anchorBottom };
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

	// Re-clamp popup using its actual measured height once it's in the DOM.
	// The quick-actions row can make the popup meaningfully taller than the
	// up-front guess, which otherwise lets it spill past the viewport edge.
	$effect(() => {
		if (!feedbackPopup || !feedbackPopupEl) return;
		const rect = feedbackPopupEl.getBoundingClientRect();
		const h = rect.height;
		const MARGIN = 12;
		const vh = window.innerHeight;
		const popup = feedbackPopup;
		// With flipBelow, `y` is the top edge; otherwise it's the bottom edge
		// (translate -100%). Compute what the resulting top/bottom would be
		// and flip/shift if it escapes the viewport.
		let flipBelow = popup.flipBelow;
		let y = popup.y;
		const topIfAbove = y - h;
		const bottomIfBelow = y + h;
		if (!flipBelow && topIfAbove < MARGIN) {
			// Not enough room above — try flipping below the selection.
			const candidateY = popup.anchorBottom + 8;
			if (candidateY + h <= vh - MARGIN) {
				flipBelow = true;
				y = candidateY;
			} else {
				// Neither side fits; pin to top of viewport.
				flipBelow = true;
				y = MARGIN;
			}
		} else if (flipBelow && bottomIfBelow > vh - MARGIN) {
			const candidateY = popup.anchorTop - 8;
			if (candidateY - h >= MARGIN) {
				flipBelow = false;
				y = candidateY;
			} else {
				// Pin to bottom of viewport.
				flipBelow = true;
				y = Math.max(MARGIN, vh - MARGIN - h);
			}
		}
		if (y !== popup.y || flipBelow !== popup.flipBelow) {
			feedbackPopup = { ...popup, y, flipBelow };
		}
	});

	$effect(() => {
		if (!feedbackInputEl) return;
		const text = feedbackInput;
		if (feedbackInputEl.textContent !== text) {
			feedbackInputEl.textContent = text;
		}
	});

	function closeFeedbackPopup() {
		// Collapse the editor's text selection so the blue highlight on the
		// passage goes away. Without this, after sending feedback (or any
		// other path that closes the popup) the underlying selection stays
		// selected and the user sees a highlighted span sitting there with
		// no popup attached. We collapse to the END of the selection (`to`)
		// so the cursor lands just past where they were looking. No focus
		// call — paths like onBlur close the popup specifically because the
		// editor lost focus, and we don't want to steal it back.
		if (editor) {
			const { to } = editor.state.selection;
			editor.commands.setTextSelection({ from: to, to });
		}
		feedbackPopup = null;
		feedbackInput = '';
		feedbackSelectionRange = null;
		shouldFocusFeedbackInput = false;
		feedbackMode = 'auto';
		updateDiff();
	}

	function deleteSelectedTextFromEditor() {
		if (!editor || !feedbackSelectionRange) return;
		const { from, to } = feedbackSelectionRange;
		editor.chain().focus().setTextSelection({ from, to }).deleteSelection().run();
		closeFeedbackPopup();
	}

	/** Format the trigger string for a feedback submission. The `[mode: …]`
	 * tag is parsed by the agent prompt to force commenting vs. editing
	 * (or leave it to auto-routing). The verb ("Rewrite", "Discuss",
	 * "Consider") also nudges the agent even if it missed the tag.
	 * When a thread was pre-opened for the feedback (Auto/Discuss modes),
	 * include its id so the agent replies on that thread rather than
	 * opening a duplicate one. */
	function buildFeedbackTrigger(
		label: string,
		passage: string,
		isCustom: boolean,
		threadId: string | null
	): string {
		const mode = feedbackMode;
		const verb = mode === 'discuss' ? 'Discuss' : mode === 'edit' ? 'Rewrite' : 'Address';
		const tag = `[mode: ${mode}]`;
		const prefix = isCustom
			? `The user flagged this passage with feedback "${label}"`
			: `The user flagged this passage as "${label}"`;
		const threadHint = threadId
			? ` A thread is already open for this feedback (thread_id="${threadId}"). If you comment, use post_comment with that thread_id — do not open a new thread.`
			: '';
		return `${prefix}. ${tag} ${verb} it: "${passage}"${threadHint}`;
	}

	/** Pre-open a comment thread with the user's feedback as the first
	 * message, so the transcript in the agent prompt starts from the
	 * user's voice. Returns the new thread id, or null on failure or when
	 * the mode is `edit` (no thread wanted in that case). */
	async function maybeOpenThreadForFeedback(
		feedback: string,
		passage: string
	): Promise<string | null> {
		if (feedbackMode === 'edit') return null;
		const tabId = getCurrentTab();
		if (!tabId) return null;
		try {
			const res = await fetch('/api/comments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: 'new-thread',
					tabId,
					anchorText: passage,
					message: feedback
				})
			});
			if (!res.ok) return null;
			const data = await res.json();
			return typeof data?.threadId === 'string' ? data.threadId : null;
		} catch (e) {
			console.error('Failed to pre-open thread for feedback:', e);
			return null;
		}
	}

	async function sendFeedback(action: Action) {
		if (!feedbackPopup) return;
		const text = feedbackPopup.text;
		const modeSnapshot = feedbackMode;
		addFeedbackAnnotation(action.label, text);
		trackActionUsage(action.label);
		if (!action.pinned) {
			recentActions.update((prev) => [action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6));
		}
		closeFeedbackPopup();
		// Restore the mode for the pre-open call — closeFeedbackPopup reset
		// it to `auto`, but we want to honor what the user picked.
		feedbackMode = modeSnapshot;
		const threadId = await maybeOpenThreadForFeedback(action.label, text);
		const trigger = buildFeedbackTrigger(action.label, text, false, threadId);
		feedbackMode = 'auto';
		if (onSubmit) onSubmit(trigger);
	}

	async function sendCustomFeedback() {
		if (!feedbackPopup || !feedbackInput.trim()) return;
		const text = feedbackPopup.text;
		const fb = feedbackInput.trim();
		const modeSnapshot = feedbackMode;
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
		feedbackMode = modeSnapshot;
		const threadId = await maybeOpenThreadForFeedback(fb, text);
		const trigger = buildFeedbackTrigger(fb, text, true, threadId);
		feedbackMode = 'auto';
		if (onSubmit) onSubmit(trigger);
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

	function logicalPlainLineCount(): number {
		if (!editor) return 1;
		let count = 0;
		editor.state.doc.forEach((node) => {
			if (node.content.size === 0) {
				count += 1;
				return;
			}
			let blockLines = 1;
			node.forEach((child) => {
				if (child.type?.name === 'hardBreak') blockLines += 1;
			});
			count += blockLines;
		});
		return Math.max(1, count);
	}

	function syncPlainLineRows() {
		if (!editor) return;
		const contentEl = editor.view.dom as HTMLElement | null;
		const lineHeight = contentEl
			? parseFloat(getComputedStyle(contentEl).lineHeight || '0')
			: 0;
		if (hasPendingProposal && contentEl && lineHeight) {
			const totalRows = Math.max(1, Math.round(contentEl.getBoundingClientRect().height / lineHeight));
			plainLineRows = Array.from({ length: totalRows }, (_, i) => String(i + 1));
			return;
		}
		const logicalCount = logicalPlainLineCount();
		if (!softWrap) {
			plainLineRows = Array.from({ length: logicalCount }, (_, i) => String(i + 1));
			return;
		}
		const paragraphs = contentEl
			? Array.from(contentEl.querySelectorAll(':scope > p'))
			: [];
		if (paragraphs.length === 0) {
			plainLineRows = Array.from({ length: logicalCount }, (_, i) => String(i + 1));
			return;
		}
		if (!contentEl) {
			plainLineRows = Array.from({ length: logicalCount }, (_, i) => String(i + 1));
			return;
		}
		if (!lineHeight) {
			plainLineRows = Array.from({ length: logicalCount }, (_, i) => String(i + 1));
			return;
		}
		const rows: string[] = [];
		paragraphs.forEach((paragraph, index) => {
			const height = paragraph.getBoundingClientRect().height;
			const visualRows = Math.max(1, Math.round(height / lineHeight));
			rows.push(String(index + 1));
			for (let i = 1; i < visualRows; i += 1) rows.push('');
		});
		plainLineRows = rows.length > 0 ? rows : ['1'];
	}

	function schedulePlainLineSync() {
		if (plainMetricsRaf) cancelAnimationFrame(plainMetricsRaf);
		plainMetricsRaf = requestAnimationFrame(() => {
			plainMetricsRaf = 0;
			syncPlainLineRows();
		});
	}

	/** Wait until the current tab's local Yjs updates have been acknowledged
	 * by the server. This preserves the old "flush before server reads"
	 * contract even though HTTP autosave is gone. */
	export async function flushAutosave(): Promise<boolean> {
		// Let the local ProseMirror/Yjs transaction settle into the provider
		// before we ask whether there are unsynced changes. Without this small
		// defer, an accept/reject click immediately after typing can observe
		// `hasUnsyncedChanges === false` one tick too early and race the
		// browser's pending local update against the server-side review action.
		await Promise.resolve();
		await new Promise<void>((resolve) => {
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => resolve());
				return;
			}
			setTimeout(resolve, 0);
		});
		return waitForCurrentTabSync();
	}

	// Diff overlay state — baseline changes when a review starts/ends.
	let currentBaseline: string | null = null;
	let currentProposalText: string | null = null;
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
		currentProposalText = v.length > 0 ? v[v.length - 1].afterMd ?? null : null;
		hasPendingProposal = v.length > 0;
		schedulePlainLineSync();
		updateDiff();
	});

	/** PM range currently highlighted as "what the user is giving feedback
	 * on". Set when the feedback popup opens, cleared when it closes.
	 * `$state` so the `.feedback-active` class on the wrapper reacts. */
	let feedbackSelectionRange: { from: number; to: number } | null = $state(null);

	// Cached preview-hook output path for the active tab. Used to gate
	// the "Show in PDF" button in the feedback popover — only useful
	// when there's a build hook producing a PDF (or other previewable
	// file) for the current tab. Refreshed on every active-tab change.
	let previewOutputPath = $state<string | null>(null);
	activeTab.subscribe(() => void refreshPreviewOutputPath());
	async function refreshPreviewOutputPath() {
		const tabId = getCurrentTab();
		if (!tabId) {
			previewOutputPath = null;
			return;
		}
		try {
			const res = await fetch(
				`/api/hooks/preview-match?file=${encodeURIComponent(tabId)}`
			);
			if (!res.ok) {
				previewOutputPath = null;
				return;
			}
			const data = await res.json();
			previewOutputPath = typeof data?.outputPath === 'string' ? data.outputPath : null;
		} catch {
			previewOutputPath = null;
		}
	}

	/** Compute the 1-based line number of the current feedback selection
	 * in the editor's plain text. In docwriter's plain-text mode each
	 * paragraph is one source line, so we count paragraph boundaries
	 * before the selection's `from` position. */
	function selectionLineNumber(): number | null {
		if (!editor || !feedbackSelectionRange) return null;
		const { from } = feedbackSelectionRange;
		let line = 1;
		let pos = 0;
		const doc = editor.state.doc;
		for (let i = 0; i < doc.childCount; i += 1) {
			const child = doc.child(i);
			const childEnd = pos + child.nodeSize;
			if (from < childEnd) return line;
			pos = childEnd;
			line += 1;
		}
		return line;
	}

	let pdfJumpChannel: BroadcastChannel | null = null;
	function getPdfJumpChannel(): BroadcastChannel | null {
		if (typeof window === 'undefined') return null;
		if (pdfJumpChannel) return pdfJumpChannel;
		try {
			pdfJumpChannel = new BroadcastChannel('docwriter-preview');
		} catch {
			pdfJumpChannel = null;
		}
		return pdfJumpChannel;
	}

	async function showInPdf() {
		if (!previewOutputPath) return;
		const tabId = getCurrentTab();
		if (!tabId) return;
		const line = selectionLineNumber();
		if (line == null) return;
		try {
			const res = await fetch('/api/synctex', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: 'forward',
					file: tabId,
					line,
					column: 0,
					pdf: previewOutputPath
				})
			});
			const data = await res.json();
			if (!data?.ok) return;
			const ch = getPdfJumpChannel();
			if (!ch) return;
			ch.postMessage({
				kind: 'pdf-jump',
				page: data.page,
				x: data.x,
				y: data.y,
				h: data.h,
				v: data.v,
				w: data.w,
				height: data.height
			});
		} catch {
			/* synctex CLI missing or build not yet produced .synctex.gz — silent */
		}
	}

	function syncCommentOverlay() {
		if (!editor) return;
		setCommentOverlayState(editor, {
			threads: threadsForTab,
			openThreadId
		});
	}

	// Whether a diff-state update is already queued for this microtask checkpoint.
	let diffUpdateQueued = false;

	/** Schedule a deferred setDiffState call.
	 *
	 * Yjs observer callbacks (fragment.observe, reviewArr.observe) fire in this
	 * order within a single transaction cleanup:
	 *   1. Direct type observers  ← textHandler / reviewArr handler call updateDiff
	 *   2. Deep observers         ← y-prosemirror's _typeChanged updates ProseMirror
	 *
	 * If we dispatch a PM transaction synchronously in step 1, y-prosemirror sees
	 * a non-isChangeOrigin transaction and calls _prosemirrorChanged with the OLD
	 * PM doc, writing the old text BACK into the Yjs fragment (clobbering the
	 * accepted edit). Deferring to a queueMicrotask ensures setDiffState fires
	 * AFTER step 2, by which time PM already has the new content. At that point
	 * _prosemirrorChanged is a no-op (PM == Yjs). */
	function updateDiff() {
		if (!editor) return;
		if (diffUpdateQueued) return;
		diffUpdateQueued = true;
		queueMicrotask(() => {
			diffUpdateQueued = false;
			if (!editor) return;
			setDiffState(editor, {
				baseline: currentBaseline,
				proposedText: currentProposalText,
				annotations: currentAnnotations.filter((annotation) => annotation.tabId === getCurrentTab()),
				activeFeedbackRange: feedbackSelectionRange,
				isPlainText: true,
				allRoundsTiny
			});
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

	function restartIdleCountdown() {
		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();
		idleTimer = setTimeout(() => {
			clearCountdown();
			if (onSubmit) onSubmit();
		}, IDLE_MS);
	}

	type UpdateKind = 'yjs-remote' | 'user-edit';

	function classifyUpdate(transaction: Transaction): UpdateKind {
		const syncMeta = transaction.getMeta(ySyncPluginKey);
		if (syncMeta !== undefined) return 'yjs-remote';
		return 'user-edit';
	}

	/**
	 * Update policy: the server is authoritative for persistence (Hocuspocus
	 * persists every WebSocket update), so this component doesn't HTTP-
	 * autosave. It only decides whether each PM transaction should restart
	 * the auto-submit idle timer:
	 * ┌─────────────┬────────────┐
	 * │    Kind     │ Idle timer │
	 * ├─────────────┼────────────┤
	 * │ yjs-remote  │ skip       │
	 * ├─────────────┼────────────┤
	 * │ user-edit   │ restart    │
	 * └─────────────┴────────────┘
	 */
	function onEditorUpdate({ transaction }: { transaction: Transaction }) {
		if (!editor) return;
		schedulePlainLineSync();
		const kind = classifyUpdate(transaction);
		if (kind === 'yjs-remote') return;
		if (kind === 'user-edit') {
			restartIdleCountdown();
			// A user edit means they're writing, not reading comments. Collapse
			// any expanded thread so the margin card doesn't stay in their
			// peripheral vision. They can re-open via the pill or gutter card.
			if (openThreadId) openCommentThreadId.set(null);
		}
	}

	onMount(async () => {
		// Wait for the Hocuspocus provider's initial sync to finish. The
		// server is authoritative: it replays the tab's Yjs update log from
		// SQLite (seeding from the workspace file on first open if the log
		// is empty) and streams the result here before `synced` fires.
		const ydoc = getYDoc();
		await whenYDocReady();

		editor = new Editor({
			element,
			extensions: [
				...collaborativeExtensions(ydoc, { placeholder: 'Start writing...' }),
				DiffOverlay,
				CommentOverlay,
				CelebrationOverlay,
				FindOverlay
			],
			// Collaboration provides initial content from the Y.Doc; do NOT
			// pass a string `content` here (doing so would wipe the Y.Doc).
			editorProps: {
				attributes: { class: 'tiptap-content tiptap-plain' },
				handleKeyDown: (_view, event) => {
					// Cmd/Ctrl+F opens the find bar. Block the browser's
					// native find dialog so we own the in-doc search UX.
					if (
						(event.key === 'f' || event.key === 'F') &&
						(event.metaKey || event.ctrlKey) &&
						!event.altKey
					) {
						event.preventDefault();
						if (editor) openFind(editor);
						return true;
					}
					// Cmd/Ctrl+Enter wakes the agent immediately, skipping the
					// idle countdown. Plain Enter still inserts a new line.
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

		// Restore scroll after the editor has rendered its initial content.
		// Two RAFs: one to let ProseMirror commit the doc, one to let layout
		// settle so scrollTop isn't clamped by a not-yet-tall scroll height.
		if (initialScrollTop > 0 && wrapperEl) {
			const target = initialScrollTop;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (wrapperEl) wrapperEl.scrollTop = target;
				});
			});
		}

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

		// Comment thread decorations dispatch this event when the user
		// clicks an inline highlight or the gutter pill. With cards in
		// the right-side comment gutter we just set the store — the
		// CommentGutter component expands the matching card in place.
		const handleOpenThread = (ev: Event) => {
			const { threadId } = (ev as CustomEvent).detail as { threadId: string };
			openCommentThreadId.set(threadId);
		};
		editorRoot.addEventListener('docwriter:open-thread', handleOpenThread as EventListener);

		// Mousedown anywhere outside a gutter card collapses the open
		// thread. Pill clicks stop propagation on mousedown, so window
		// won't see those; inline-highlight clicks fire handleClick
		// after this mousedown, so they re-open the matching thread.
		const handleOutsideMousedown = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest?.('.gutter-card')) return;
			if (target.closest?.('.comment-thread-pill')) return;
			openCommentThreadId.set(null);
		};
		window.addEventListener('mousedown', handleOutsideMousedown);

		// Same pattern for the feedback popup. Editor `onBlur` already
		// closes it for clicks that move focus, but clicking on non-
		// focusable chrome (line gutter, AgentDock card, OutlinePane
		// header) doesn't blur the editor — the popup got stuck open.
		// closeFeedbackPopup also collapses the editor's text selection
		// so the blue highlight clears.
		const handleFeedbackOutsideMousedown = (e: MouseEvent) => {
			if (!feedbackPopup) return;
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest?.('.feedback-popup')) return;
			if (editorRoot.contains(target)) return;
			closeFeedbackPopup();
		};
		window.addEventListener('mousedown', handleFeedbackOutsideMousedown);

		const detachOpenThread = () => {
			editorRoot.removeEventListener('docwriter:open-thread', handleOpenThread as EventListener);
			window.removeEventListener('mousedown', handleOutsideMousedown);
			window.removeEventListener('mousedown', handleFeedbackOutsideMousedown);
		};

		syncCommentOverlay();

		schedulePlainLineSync();
		updateDiff();
		editor.on('update', ({ transaction }) => onEditorUpdate({ transaction }));
		// Keep our reactive `findState` in sync with the FindOverlay plugin
		// state so the FindBar re-renders match counts, current index, etc.
		// after every transaction (typing, query change, step, close).
		editor.on('transaction', () => {
			if (!editor) return;
			const next = findKey.getState(editor.view.state);
			if (next) findState = next;
		});

		if (typeof ResizeObserver !== 'undefined') {
			plainResizeObserver = new ResizeObserver(() => schedulePlainLineSync());
			plainResizeObserver.observe(editorRoot);
		}

		// Dev-only: expose the editor on window for stress tests and
		// interactive debugging via devtools. Guarded so production bundles
		// don't leak a global.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			(window as any).__docwriterEditor = editor;
		}

		detachFeedbackPointerHandlers = () => {
			editorRoot.removeEventListener('pointerdown', handlePointerDown);
			window.removeEventListener('pointerup', handlePointerUp);
			detachOpenThread();
		};
	});

	onDestroy(() => {
		if (editor) editor.destroy();
		if (plainMetricsRaf) cancelAnimationFrame(plainMetricsRaf);
		plainMetricsRaf = 0;
		plainResizeObserver?.disconnect();
		plainResizeObserver = null;
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

	$effect(() => {
		if (!editor) return;
		softWrap;
		fontScale;
		schedulePlainLineSync();
	});

	isRendering.subscribe((v) => {
		if (v) {
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
			clearCountdown();
		}
	});

	// Export the live editor instance for tests and interactive debugging.
	export function getEditor(): Editor | undefined {
		return editor;
	}

	// Parent reads this before tearing the editor down (Accept / Reject /
	// reload) and feeds it back via `initialScrollTop` on the next mount.
	export function getScrollTop(): number {
		return wrapperEl?.scrollTop ?? 0;
	}

	// Flash a sage-green halo on the freshly-accepted text range. Called
	// by the parent right after a successful Accept; locates the new
	// text in the live PM doc and dispatches the celebration decoration
	// for ~800ms. No-op if `text` isn't found (race or fall-through).
	export function flashAcceptedRange(text: string): void {
		if (!editor) return;
		flashCelebration(editor, text);
	}
</script>

<div class="tiptap-host" class:find-open={findState.open}>
	<!-- Top-right floating chrome: preview button + find bar. Both live
	     outside the scroll container so they pin regardless of scroll.
	     When find is open, the preview button shifts down so the two
	     don't overlap (FindBar wins the corner). -->
	<PreviewButton activeTabPath={getCurrentTab() ?? null} />
	{#if findState.open}
		<FindBar
			findState={findState}
			onQueryChange={(query, caseSensitive) => {
				if (editor) setFindQuery(editor, { query, caseSensitive });
			}}
			onStep={(dir) => {
				if (editor) findStep(editor, dir);
			}}
			onClose={() => {
				if (editor) {
					closeFind(editor);
					editor.commands.focus();
				}
			}}
		/>
	{/if}
<div
	class="tiptap-wrapper"
	class:plain-mode-wrapper={true}
	class:soft-wrap-enabled={softWrap}
	class:has-comment-gutter={threadsForTab.some((t) => !t.resolved)}
	style:--font-scale={fontScale}
	bind:this={wrapperEl}
>
	<div
		class="plain-editor-shell"
		class:soft-wrap-enabled={softWrap}
		class:has-comment-gutter={threadsForTab.some((t) => !t.resolved)}
	>
		<div class="plain-line-gutter" aria-hidden="true">
			{#each plainLineRows as line}
				<div class="plain-line-number">{line}</div>
			{/each}
		</div>
		<div class="tiptap-editor plain-mode" class:soft-wrap-enabled={softWrap} bind:this={element}></div>
		{#if threadsForTab.some((t) => !t.resolved)}
			<CommentGutter
				threads={threadsForTab}
				editor={editor}
				tabId={getCurrentTab() ?? ''}
				openThreadId={openThreadId}
				onOpen={(id) => openCommentThreadId.set(id)}
				onClose={() => openCommentThreadId.set(null)}
				onApprove={(t, msgId) => {
					const msg = t.messages.find((m) => m.id === msgId);
					const suggestion = msg?.proposedEdit;
					const transcript = t.messages
						.map((m) => `- [${m.author === 'agent' ? 'agent' : 'user'}] ${m.text}`)
						.join('\n');
					const trigger = suggestion
						? `The user approved the suggestion in comment thread "${t.id}" on this tab. Apply this edit via edit_doc:\n\nold_string: "${suggestion.oldString}"\nnew_string: "${suggestion.newString}"\n\nAnchor passage: "${t.anchor.quote}"\nFull thread:\n${transcript}`
						: `The user approved comment thread "${t.id}" on this tab. Apply the edit you described via edit_doc.\n\nAnchor passage: "${t.anchor.quote}"\nFull thread:\n${transcript}`;
					onSubmit?.(trigger);
					openCommentThreadId.set(null);
				}}
				onReply={(t, replyText) => {
					// User replied on a thread — wake the agent to respond.
					// The post-reply thread `t` doesn't yet include the just-
					// posted message (the prop snapshot is from before the
					// network call resolved), so we append it manually below
					// when building the transcript.
					const transcript = [
						...t.messages.map(
							(m) => `- [${m.author === 'agent' ? 'agent' : 'user'}] ${m.text}`
						),
						`- [user] ${replyText}`
					].join('\n');
					const trigger =
						`The user replied on comment thread "${t.id}" on this tab. ` +
						`Decide whether to reply on the same thread (call post_comment with thread_id "${t.id}") or, ` +
						`if the user's reply is now a clear edit request, call edit_doc instead. ` +
						`Do NOT open a new thread for this reply.\n\n` +
						`Anchor passage: "${t.anchor.quote}"\n` +
						`User's latest reply: "${replyText}"\n` +
						`Full thread (latest reply included):\n${transcript}`;
					onSubmit?.(trigger);
				}}
			/>
		{/if}
	</div>
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
			{#if previewOutputPath}
				<button
					class="feedback-show-in-pdf"
					type="button"
					onclick={showInPdf}
					title="Locate this passage in the preview window (forward SyncTeX). Preview window must be open."
				>
					<Crosshair size={11} />
					<span>Locate in PDF</span>
				</button>
			{/if}
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
						if (e.key === 'Escape') {
							// Collapse the editor selection so a subsequent click
							// inside the previously-highlighted range doesn't cause
							// the browser to restore that selection on refocus
							// (which would re-open the feedback popup).
							if (editor) {
								const pos = editor.state.selection.to;
								editor.chain().focus().setTextSelection(pos).run();
							}
							closeFeedbackPopup();
						}
						if (
							(e.key === 'Backspace' || e.key === 'Delete') &&
							!feedbackInput.trim() &&
							feedbackSelectionRange
						) {
							e.preventDefault();
							deleteSelectedTextFromEditor();
						}
						if (
							(e.key === 'a' || e.key === 'A') &&
							(e.metaKey || e.ctrlKey) &&
							!feedbackInput &&
							editor
						) {
							e.preventDefault();
							editor.chain().focus().selectAll().run();
						}
					}}
					oncopy={(e) => {
						if (feedbackInput || !feedbackPopup) return;
						e.preventDefault();
						e.clipboardData?.setData('text/plain', feedbackPopup.text);
					}}
				></div>
				<button class="feedback-submit" onclick={sendCustomFeedback}>Go</button>
			</div>
			<div class="feedback-mode-row" role="group" aria-label="How the agent should respond">
				<button
					class="mode-chip"
					class:mode-chip-active={feedbackMode === 'auto'}
					onclick={() => (feedbackMode = 'auto')}
					title="Let the agent choose between editing and commenting based on tone"
					type="button"
				>Auto</button>
				<button
					class="mode-chip"
					class:mode-chip-active={feedbackMode === 'edit'}
					onclick={() => (feedbackMode = 'edit')}
					title="Force the agent to edit the passage"
					type="button"
				>Edit</button>
				<button
					class="mode-chip"
					class:mode-chip-active={feedbackMode === 'discuss'}
					onclick={() => (feedbackMode = 'discuss')}
					title="Force the agent to open a comment thread instead of editing"
					type="button"
				>Discuss</button>
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
</div>

<style>
	/* Host wraps the scrolling .tiptap-wrapper plus any chrome (FindBar,
	 * PreviewButton) that needs to stay pinned regardless of scroll. The
	 * host itself is the positioning context for those overlays. */
	.tiptap-host {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	/* When the FindBar is open, drop the PreviewButton below it so the
	 * two don't collide in the corner. */
	.tiptap-host.find-open :global(.preview-btn) {
		top: 50px;
	}
	.tiptap-wrapper {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		/* Tighter right padding when there's no comment gutter — the gutter
		 * column adds ~280px of breathing room on the right when comments
		 * exist, so the wrapper itself doesn't need much. Without comments
		 * we still want a small gap so prose doesn't kiss the right edge. */
		padding: 48px 12px 48px 32px;
		background: var(--bg);
	}
	.tiptap-wrapper.has-comment-gutter {
		padding-right: 32px;
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
	.plain-editor-shell.has-comment-gutter {
		/* Third column reserved for the right-side comment gutter so
		 * thread cards sit in a stable column beside the editor rather
		 * than floating over the prose. Width matches CommentGutter's
		 * fixed inner width. */
		grid-template-columns: 52px minmax(0, 1fr) 280px;
	}
	.plain-editor-shell.soft-wrap-enabled {
		width: 100%;
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
	.tiptap-editor.plain-mode.soft-wrap-enabled :global(.tiptap-content) {
		width: 100%;
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
	.tiptap-wrapper.soft-wrap-enabled .tiptap-editor :global(.tiptap-plain) {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
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
	.tiptap-editor :global(.tiptap-plain p.diff-added-line) {
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
	}
	.tiptap-editor :global(.diff-added-line) {
		display: block;
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
		white-space: pre-wrap;
		pointer-events: none;
		user-select: none;
	}
	.tiptap-editor :global(.diff-removed) {
		color: var(--diff-removed-color);
		text-decoration: line-through;
		opacity: 0.7;
	}
	.tiptap-editor :global(.tiptap-plain p.diff-removed-line) {
		color: var(--diff-removed-color);
		background: color-mix(in srgb, var(--diff-removed-color) 10%, transparent);
		text-decoration: line-through;
		opacity: 0.72;
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
	.tiptap-editor :global(.tiptap-plain p.diff-added-line.diff-added-line-tiny) {
		color: var(--diff-added-color);
		background: transparent;
		border-bottom: 1px dotted color-mix(in srgb, var(--diff-added-color) 60%, transparent);
	}
	.tiptap-editor :global(.diff-added-line.diff-added-line-tiny) {
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
	/* Find-in-doc match highlights. Soft amber on every match; the
	 * "current" match (where prev/next focus is) gets a stronger ring +
	 * background so the user can see where they are at a glance. */
	.tiptap-editor :global(.search-match) {
		background: color-mix(in srgb, #f59e0b 22%, transparent);
		border-radius: 2px;
	}
	.tiptap-editor :global(.search-match-current) {
		background: color-mix(in srgb, #f59e0b 42%, transparent);
		box-shadow: inset 0 0 0 1.5px #d97706;
	}
	/* "Small win" celebration: brief sage-green halo on text the user just
	 * accepted. The plugin adds this class for ~800ms; the keyframe fades
	 * background + box-shadow to transparent over the same window so the
	 * decoration lands and clears in one breath. ease-out-quart settles
	 * the way real things settle (fast start, soft stop). */
	.tiptap-editor :global(.accept-celebrate) {
		border-radius: 3px;
		animation: docwriter-accept-flash 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	@keyframes docwriter-accept-flash {
		0% {
			background: var(--win-bg, #d1fae5);
			box-shadow: inset 0 0 0 1px var(--win-border, #10b981);
		}
		60% {
			background: var(--win-bg, #d1fae5);
			box-shadow: inset 0 0 0 1px var(--win-border, #10b981);
		}
		100% {
			background: transparent;
			box-shadow: inset 0 0 0 1px transparent;
		}
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
	/* "Locate in PDF" — forward SyncTeX. Only renders when a preview
	 * hook exists for the active tab. Ghost styling so it sits quietly
	 * with the popover's other secondary affordances (mode toggles,
	 * recent-feedback chips) instead of competing for attention. */
	.feedback-show-in-pdf {
		font: inherit;
		font-size: 11px;
		color: var(--text-faint);
		background: transparent;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		padding: 3px 9px 3px 7px;
		margin-bottom: 8px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.feedback-show-in-pdf:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
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
	.feedback-mode-row {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 6px;
		padding: 2px;
		background: var(--bg-surface);
		border-radius: 6px;
		width: fit-content;
	}
	.mode-chip {
		font: inherit;
		font-size: 11px;
		font-weight: 500;
		padding: 3px 8px;
		color: var(--text-secondary);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}
	.mode-chip:hover:not(.mode-chip-active) {
		color: var(--text);
		background: var(--bg-hover);
	}
	.mode-chip-active {
		color: var(--text);
		background: var(--bg);
		box-shadow: 0 0 0 1px var(--border-light);
	}
	/* Comment thread overlay: unresolved threads get a subtle amber
	 * highlight, and a small gutter pill shows the message count. */
	.tiptap-editor :global(.comment-thread-highlight) {
		background: color-mix(in srgb, #f59e0b 10%, transparent);
		border-bottom: 2px solid color-mix(in srgb, #f59e0b 45%, transparent);
		border-radius: 2px;
		cursor: pointer;
	}
	.tiptap-editor :global(.comment-thread-highlight:hover) {
		background: color-mix(in srgb, #f59e0b 18%, transparent);
	}
	.tiptap-editor :global(.comment-thread-open) {
		background: color-mix(in srgb, #f59e0b 22%, transparent);
		border-bottom-color: color-mix(in srgb, #f59e0b 65%, transparent);
	}
	.tiptap-editor :global(.comment-thread-pill) {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin: 0 2px;
		padding: 1px 5px;
		background: #fef3c7;
		color: #92400e;
		border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent);
		border-radius: 10px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10px;
		font-weight: 600;
		line-height: 1.2;
		cursor: pointer;
		vertical-align: middle;
		user-select: none;
	}
	.tiptap-editor :global(.comment-thread-pill:hover),
	.tiptap-editor :global(.comment-thread-pill-open) {
		background: #fde68a;
		border-color: #f59e0b;
	}
	.tiptap-editor :global(.comment-thread-pill-count) {
		margin-left: 1px;
	}
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
