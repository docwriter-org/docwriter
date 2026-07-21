<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Editor } from '@tiptap/core';
	import { TextSelection, type Transaction } from '@tiptap/pm/state';
	import { DiffOverlay, setDiffState } from './diff-overlay';
	import {
		CommentOverlay,
		setCommentOverlayState,
		computeRelPositionsForRange
	} from './comment-overlay';
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
	import { MediaOverlay } from './media-overlay';
	import { D3Overlay } from './d3-overlay';
	import { MarkdownRender } from './markdown-render';
	import {
		SourceCommentOverlay,
		type SourceCommentStyle
	} from './source-comment-overlay';
	import { handleEditorPaste, handleEditorDrop } from './media-paste';
	import FindBar from '$lib/components/FindBar.svelte';
	import CommentGutter from '$lib/components/CommentGutter.svelte';
	import { Crosshair, Lock, Unlock } from 'lucide-svelte';
	import { FreezeOverlay, setFreezeOverlayState } from './freeze-overlay';
	import { makeFreezeRuleText, freezeQuoteFromRule, isFreezeRule } from '$lib/freeze';
	import type { Rule } from '$lib/types';
	// `ySyncPluginKey` MUST come from the same package whose ySyncPlugin the
	// Collaboration extension installs (@tiptap/y-tiptap), re-exported here via
	// editor-extensions. Importing it from `y-prosemirror` yields a different
	// PluginKey, so `transaction.getMeta(ySyncPluginKey)` never matches and
	// remote/agent Yjs transactions get misclassified as user edits.
	import { collaborativeExtensions, ySyncPluginKey } from '$lib/editor-extensions';
	import { getYDocForTab, whenYDocReadyForTab, waitForTabSync } from '$lib/yjs-doc';
	import {
		reviewBaseline,
		isRendering,
		submitCountdown,
		editorFontScale,
		editorSoftWrap,
		editorLineNumbers,
		pinnedActions,
		recentActions,
		trackActionUsage,
		rules,
		pushHistory,
		pendingReviewRounds,
		commentThreads,
		openCommentThreadId,
		agentSettings,
		expandedReviewRoundId,
		pinnedDiffRounds,
		showAiProvenance
	} from '$lib/stores';
	import type { Action, CommentThread, FeedbackMode } from '$lib/types';
	import type { MaterializedPendingReviewRound } from '$lib/review-rounds';

	const IDLE_MS = 3_000;

	interface Props {
		/** Workspace path for the tab this editor instance is bound to. */
		tabId: string;
		onSubmit?: (trigger?: string) => void;
		/** One-shot scroll restore. Read once in onMount after the editor's
		 * content has laid out, then ignored. The parent captures this from
		 * `getScrollTop()` before tearing the editor down (Accept / Reject /
		 * file reload) so the user keeps their place across the remount. */
		initialScrollTop?: number;
		/** Accept / reject the pending review round whose gutter card the user
		 * clicked. Wired to acceptAgentEdit / rejectAgentEdit in +page. */
		onAcceptInlineEdit?: (roundId: string | null) => void;
		onRejectInlineEdit?: (roundId: string | null) => void;
		/** Accept every pending edit for one feedback thread at once. */
		onAcceptFeedbackEdits?: (roundIds: string[]) => void;
		/** Accept / reject every pending round on this tab. */
		onAcceptAllEdits?: () => void;
		onRejectAllEdits?: () => void;
		/** Resolve / reopen a thread (undoable; also drops its pending edits). */
		onResolveThread?: (threadId: string, resolved: boolean) => void;
		/** Open the resolved preview output beside the source editor
		 * (used by "Locate in PDF" on the feedback popup). */
		onOpenSplitPreview?: (path: string) => void;
		splitPreviewOpen?: boolean;
	}
	let {
		tabId,
		onSubmit,
		initialScrollTop = 0,
		onAcceptInlineEdit,
		onRejectInlineEdit,
		onAcceptFeedbackEdits,
		onAcceptAllEdits,
		onRejectAllEdits,
		onResolveThread,
		onOpenSplitPreview,
		splitPreviewOpen = false
	}: Props = $props();

	let element: HTMLDivElement;
	let wrapperEl: HTMLDivElement | null = null;
	let editor: Editor | undefined = $state();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let idleDeadline = 0;
	/** Plain-text snapshot of the doc as it was when the current editing burst
	 * began (before the first keystroke). When the idle timer fires we compare
	 * against it: if the net result is identical (e.g. typed a char then
	 * deleted it), there's nothing new for the agent to see, so we skip the
	 * auto-submit instead of waking it for a no-op. */
	let idleBaselineText: string | null = null;
	function docPlainText(doc: { textBetween: (a: number, b: number, c: string, d: string) => string; content: { size: number } }): string {
		return doc.textBetween(0, doc.content.size, '\n', '\n');
	}
	let plainMetricsRaf = 0;
	let plainResizeObserver: ResizeObserver | null = null;

	// `$store` auto-subscription (valid in runes mode): Svelte tears the
	// subscription down with the component, so a tab-switch remount can't leak
	// a live subscriber that keeps firing against a destroyed editor.
	let fontScale = $derived($editorFontScale);
	let softWrap = $derived($editorSoftWrap);
	let lineNumbersOn = $derived($editorLineNumbers);
	/** Per-paragraph row entries for the line gutter. Each row carries a
	 * label and an absolute `top` offset (px) from the editor content's
	 * top. Absolute positioning lets the gutter follow paragraphs through
	 * any vertical space introduced by media-overlay widgets, diff
	 * decorations, or soft-wrap continuations — `1` stays next to its
	 * markdown line even when a 360px image widget sits below it. */
	let plainLineRows = $state<Array<{ label: string; top: number }>>([{ label: '1', top: 0 }]);
	/** Total content height the gutter must span; without this, the gutter
	 * collapses to 0 (children are absolutely positioned) and the
	 * border-right disappears. */
	let plainGutterMinHeight = $state(0);
	let pointerSelecting = false;
	let shouldFocusFeedbackInput = false;
	let detachFeedbackPointerHandlers: (() => void) | null = null;

	// Feedback popup: floating toolbar when the user selects text. Shows
	// pinned actions + LRU recent actions + an open-ended text input.
	let feedbackPopup = $state<{ text: string; x: number; y: number; flipBelow: boolean; anchorTop: number; anchorBottom: number } | null>(null);
	let feedbackPopupEl: HTMLDivElement | null = $state(null);
	/** Lock-icon menu: Unlock / allow agent for a frozen passage. */
	let freezeMenu = $state<{ ruleId: string; quote: string; x: number; y: number } | null>(null);

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
	/** Routing mode for the current feedback submission. `edit` = direct
	 * edit_doc proposal; `plan` = the agent first replies on the feedback
	 * thread with WHY the passage was flagged (same reflection contract as
	 * chat's plan-first mode), then proposes the edit on the same thread.
	 * Resets to `edit` whenever the popup closes so each feedback session
	 * starts fresh. */
	let feedbackMode = $state<FeedbackMode>('edit');

	// Comment thread + review state, each mirrored from its store via `$store`
	// auto-subscription so there's exactly ONE reactive value per concept and
	// no manually-managed (leak-prone) subscriptions. These feed BOTH the diff
	// overlay (imperatively, inside updateDiff / syncCommentOverlay) and the
	// CommentGutter props. The overlay refresh is driven reactively by the
	// $effect near updateDiff below — no imperative updateDiff/syncCommentOverlay
	// calls are scattered through store handlers anymore.
	let threadsForTab: CommentThread[] = $derived($commentThreads);
	let openThreadId = $derived($openCommentThreadId);
	let newAwaitingThreadId = $state<string | null>(null);
	let rounds: MaterializedPendingReviewRound[] = $derived($pendingReviewRounds);
	let baseline = $derived($reviewBaseline);
	/** The gutter (and its --gutter-width column) shows when there's anything
	 * to review — unresolved comment threads OR pending edit rounds. */
	let hasGutterContent = $derived(
		threadsForTab.some((t) => !t.resolved) || rounds.length > 0
	);
	let recent: Action[] = $derived($recentActions);

	type FeedbackRange = { from: number; to: number };
	let dismissedFeedbackSelectionRange: FeedbackRange | null = null;

	function sameFeedbackRange(a: FeedbackRange | null, b: FeedbackRange): boolean {
		return a?.from === b.from && a?.to === b.to;
	}

	function extensionForPath(path: string): string {
		const clean = path.split(/[?#]/, 1)[0].toLowerCase();
		const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
		const dot = clean.lastIndexOf('.');
		return dot > slash ? clean.slice(dot) : '';
	}

	function sourceCommentStyleForPath(path: string): SourceCommentStyle | null {
		const ext = extensionForPath(path);
		if (['.tex', '.ltx', '.sty', '.cls', '.bib'].includes(ext)) {
			return { kind: 'line', marker: '%' };
		}
		if (['.py', '.r', '.rb', '.sh', '.bash', '.zsh', '.fish', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'].includes(ext)) {
			return { kind: 'line', marker: '#' };
		}
		if (['.js', '.jsx', '.ts', '.tsx', '.svelte', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.swift', '.kt', '.kts', '.php', '.scala'].includes(ext)) {
			return { kind: 'line', marker: '//' };
		}
		if (['.sql', '.lua'].includes(ext)) {
			return { kind: 'line', marker: '--' };
		}
		if (['.md', '.markdown', '.mdx', '.html', '.htm', '.xml', '.svg'].includes(ext)) {
			return { kind: 'block', open: '<!-- ', close: ' -->' };
		}
		if (['.css', '.scss', '.less'].includes(ext)) {
			return { kind: 'block', open: '/* ', close: ' */' };
		}
		return null;
	}

	function shouldRenderMarkdownForPath(path: string): boolean {
		const ext = extensionForPath(path);
		return !['.tex', '.ltx', '.sty', '.cls', '.bib'].includes(ext);
	}

	function escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	function selectedSourceLines(): Array<{ contentStart: number; text: string }> {
		if (!editor || !(editor.state.selection instanceof TextSelection)) return [];
		const { from, to, empty } = editor.state.selection;
		const lines: Array<{ contentStart: number; text: string }> = [];
		editor.state.doc.forEach((node, offset) => {
			if (node.type.name !== 'paragraph') return;
			const contentStart = offset + 1;
			const contentEnd = contentStart + node.content.size;
			const nodeEnd = offset + node.nodeSize;
			const text = node.textBetween(0, node.content.size, '\n', '');
			const include = empty
				? from >= offset && from <= nodeEnd
				: contentEnd > contentStart
					? to > contentStart && from < contentEnd
					: to >= contentStart && from <= contentStart;
			if (include) lines.push({ contentStart, text });
		});
		return lines;
	}

	function selectedOrCurrentBlockRange(): { from: number; to: number } | null {
		if (!editor || !(editor.state.selection instanceof TextSelection)) return null;
		const { from, to, empty } = editor.state.selection;
		if (!empty) return { from, to };
		let range: { from: number; to: number } | null = null;
		editor.state.doc.forEach((node, offset) => {
			if (range || node.type.name !== 'paragraph') return;
			const contentStart = offset + 1;
			const contentEnd = contentStart + node.content.size;
			if (from >= offset && from <= offset + node.nodeSize) {
				range = { from: contentStart, to: contentEnd };
			}
		});
		return range;
	}

	function toggleLineSourceComment(marker: string): boolean {
		if (!editor) return false;
		const lines = selectedSourceLines().filter((line) => line.text.trim().length > 0);
		if (lines.length === 0) return false;
		const markerRe = new RegExp(`^(\\s*)${escapeRegExp(marker)} ?`);
		const shouldUncomment = lines.every((line) => markerRe.test(line.text));
		let tr = editor.state.tr;
		for (const line of [...lines].sort((a, b) => b.contentStart - a.contentStart)) {
			if (shouldUncomment) {
				const match = line.text.match(markerRe);
				if (!match) continue;
				const indentLen = match[1].length;
				const removeFrom = line.contentStart + indentLen;
				tr = tr.delete(removeFrom, removeFrom + match[0].length - indentLen);
			} else {
				const indentLen = line.text.match(/^\s*/)?.[0].length ?? 0;
				tr = tr.insertText(`${marker} `, line.contentStart + indentLen);
			}
		}
		if (!tr.docChanged) return false;
		editor.view.dispatch(tr.scrollIntoView());
		closeFeedbackPopup({ preserveSelection: true, refocusEditor: true });
		return true;
	}

	function toggleBlockSourceComment(open: string, close: string): boolean {
		if (!editor) return false;
		const range = selectedOrCurrentBlockRange();
		if (!range) return false;
		const selected = editor.state.doc.textBetween(range.from, range.to, '\n', '\n');
		let tr = editor.state.tr;
		if (selected.startsWith(open) && selected.endsWith(close)) {
			tr = tr.delete(range.to - close.length, range.to);
			tr = tr.delete(range.from, range.from + open.length);
		} else {
			tr = tr.insertText(close, range.to);
			tr = tr.insertText(open, range.from);
		}
		if (!tr.docChanged) return false;
		editor.view.dispatch(tr.scrollIntoView());
		closeFeedbackPopup({ preserveSelection: true, refocusEditor: true });
		return true;
	}

	function toggleSourceComment(): boolean {
		const style = sourceCommentStyleForPath(tabId);
		if (!style) return false;
		return style.kind === 'line'
			? toggleLineSourceComment(style.marker)
			: toggleBlockSourceComment(style.open, style.close);
	}

	function isSourceCommentShortcut(event: KeyboardEvent): boolean {
		return (
			(event.metaKey || event.ctrlKey) &&
			!event.altKey &&
			(event.key === '/' || event.key === '?' || event.code === 'Slash')
		);
	}

	function handleSourceCommentShortcut(event: KeyboardEvent): boolean {
		if (!isSourceCommentShortcut(event)) return false;
		const target = event.target as HTMLElement | null;
		const inThisEditor =
			!!feedbackPopup ||
			!!editor?.isFocused ||
			!!(target && wrapperEl?.contains(target)) ||
			!!(target && feedbackPopupEl?.contains(target));
		if (!inThisEditor) return false;
		if (!toggleSourceComment()) return false;
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	function updateFeedbackPopup(autoFocus = false) {
		if (!editor || !editor.isFocused) return;
		// No feedback while the agent is paused: a paused agent won't act on
		// edits or comments, so the selection popup would be a dead end. Same
		// gate as Wake up / Send / auto-wake.
		if ($agentSettings.paused) {
			dismissedFeedbackSelectionRange = null;
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		const selection = editor.state.selection;
		const { from, to, empty } = selection;
		// Clicking a contenteditable=false diff widget (agent-added block) creates
		// a NodeSelection spanning the whole widget — to the user this looks like
		// the paragraph auto-selected on a bare click. Only treat genuine text
		// selections as feedback selections.
		if (!(selection instanceof TextSelection) || empty || to - from < 2) {
			dismissedFeedbackSelectionRange = null;
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		const selectedText = editor.state.doc.textBetween(from, to, '\n', '\n');
		if (!selectedText.trim()) {
			dismissedFeedbackSelectionRange = null;
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		const selectionRange = { from, to };
		if (sameFeedbackRange(dismissedFeedbackSelectionRange, selectionRange)) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
			updateDiff();
			return;
		}
		dismissedFeedbackSelectionRange = null;
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
		feedbackSelectionRange = selectionRange;
		updateDiff();
	}

	function handleSelectionChange() {
		if (pointerSelecting) return;
		updateFeedbackPopup(false);
	}

	// Pausing (e.g. double-clicking the Agent pill) closes any open feedback
	// popup — the selection stays, but the way to send it to the agent is gone
	// until the user resumes.
	$effect(() => {
		if ($agentSettings.paused && feedbackPopup) {
			feedbackPopup = null;
			feedbackInput = '';
			feedbackSelectionRange = null;
			shouldFocusFeedbackInput = false;
		}
	});

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

	function closeFeedbackPopup({
		preserveSelection = false,
		refocusEditor = false
	}: { preserveSelection?: boolean; refocusEditor?: boolean } = {}) {
		// Most close paths collapse the selection so the blue highlight does
		// not linger after a submit/outside click. Escape is different: the
		// user may want to keep the range selected for copy, drag, delete, or
		// replacement, so preserve it and suppress reopening for that range.
		if (editor) {
			if (preserveSelection) {
				const selection = editor.state.selection;
				dismissedFeedbackSelectionRange =
					feedbackSelectionRange ??
					(selection instanceof TextSelection && !selection.empty
						? { from: selection.from, to: selection.to }
						: null);
			} else {
				const { to } = editor.state.selection;
				editor.commands.setTextSelection({ from: to, to });
				dismissedFeedbackSelectionRange = null;
			}
		} else {
			dismissedFeedbackSelectionRange = null;
		}
		feedbackPopup = null;
		feedbackInput = '';
		feedbackSelectionRange = null;
		shouldFocusFeedbackInput = false;
		feedbackMode = 'edit';
		updateDiff();
		if (preserveSelection && refocusEditor) {
			requestAnimationFrame(() => editor?.commands.focus());
		}
	}

	function handleFeedbackWindowKeydown(e: KeyboardEvent) {
		if (handleSourceCommentShortcut(e)) return;
		if (e.key !== 'Escape') return;
		if (freezeMenu) {
			e.preventDefault();
			e.stopPropagation();
			freezeMenu = null;
			return;
		}
		if (!feedbackPopup) return;
		e.preventDefault();
		e.stopPropagation();
		closeFeedbackPopup({ preserveSelection: true, refocusEditor: true });
	}

	function deleteSelectedTextFromEditor() {
		if (!editor || !feedbackSelectionRange) return;
		const { from, to } = feedbackSelectionRange;
		editor.chain().focus().setTextSelection({ from, to }).deleteSelection().run();
		closeFeedbackPopup();
	}

	/** Format the trigger string for a feedback submission. The pre-opened
	 * thread id is included so the agent works on that thread rather than
	 * opening a duplicate one. In `plan` mode the trigger additionally
	 * requires a reply_to_comment reflection on the thread BEFORE the edit
	 * (same contract as chat's plan-first mode, landing in situ). */
	function buildFeedbackTrigger(
		label: string,
		passage: string,
		isCustom: boolean,
		threadId: string | null
	): string {
		// Both modes end in an edit; `[mode: edit]` keeps the system prompt's
		// routing rules pointed at edit_doc.
		const tag = `[mode: edit]`;
		const prefix = isCustom
			? `The user flagged this passage with feedback "${label}"`
			: `The user flagged this passage as "${label}"`;
		// The system prompt's "Where a response goes" rules carry the routing;
		// the trigger only needs the facts (mode tag + thread id).
		const threadHint = threadId ? ` A thread is open for this feedback (thread_id="${threadId}").` : '';
		// Plan-first: same reflection contract as chat's plan-first mode, but
		// the plan lands in situ — the agent MUST post it as a reply on the
		// feedback thread before proposing the edit, so the reasoning shows
		// as a comment above the pending-edit card.
		const planHint =
			feedbackMode === 'plan' && threadId
				? ` Plan first: before proposing any edit, you MUST reply on thread_id="${threadId}" via reply_to_comment with your reflection. Explain, in complete sentences, why the user likely flagged this passage, what in the current text reads wrong, and what you intend to change. Write it as plain explanatory prose that carries your reasoning, the way you would explain it out loud. Do not compress it into label-led fragments or bullet points. Only after posting that reply, propose the edit via edit_doc with thread_id="${threadId}" so it attaches to the same thread.`
				: '';
		return `${prefix}. ${tag} Rewrite it: "${passage}"${threadHint}${planHint}`;
	}

	/** Open a comment thread with the user's feedback as the first message,
	 * so the feedback persists on the passage and the agent prompt's
	 * transcript starts from the user's voice. Returns the new thread id, or
	 * null on failure. Fires for BOTH modes (direct edit = record, plan
	 * first = where the agent's reflection reply lands).
	 *
	 * `relPositions` carries the user's actual selection encoded as Yjs
	 * RelativePositions — when present, the server stores them on the
	 * anchor and the comment overlay anchors to the EXACT location the
	 * user selected (not just the first occurrence of `passage` in the
	 * doc). The comment-overlay backfill pass remains as a safety net
	 * for legacy threads created before this field existed. */
	async function maybeOpenThreadForFeedback(
		feedback: string,
		passage: string,
		relPositions: { relStart: string; relEnd: string } | null
	): Promise<string | null> {
		// Every feedback opens a thread so it persists on the passage — as a
		// record in direct-edit mode, and as the conversation the agent's
		// plan reflection replies on in plan-first mode.
		try {
			const res = await fetch('/api/comments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: 'new-thread',
					tabId,
					anchorText: passage,
					message: feedback,
					...(relPositions ?? {})
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

	/** Snapshot rel positions for the current feedback selection BEFORE
	 * closeFeedbackPopup wipes feedbackSelectionRange. The snapshot
	 * encodes the user's exact PM range as Yjs RelativePositions, so the
	 * comment anchors to where they actually clicked — not the first
	 * occurrence of the selected text. */
	function snapshotFeedbackRelPositions(): { relStart: string; relEnd: string } | null {
		if (!editor || !feedbackSelectionRange) return null;
		return computeRelPositionsForRange(
			editor,
			feedbackSelectionRange.from,
			feedbackSelectionRange.to
		);
	}

	async function sendFeedback(action: Action) {
		if (!feedbackPopup) return;
		const text = feedbackPopup.text;
		const modeSnapshot = feedbackMode;
		const relSnapshot = snapshotFeedbackRelPositions();
		trackActionUsage(action.label);
		if (!action.pinned) {
			recentActions.update((prev) => [action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6));
		}
		closeFeedbackPopup();
		// Restore the mode for the trigger build — closeFeedbackPopup reset
		// it to `edit`, but we want to honor what the user picked.
		feedbackMode = modeSnapshot;
		const threadId = await maybeOpenThreadForFeedback(action.label, text, relSnapshot);
		if (threadId) {
			newAwaitingThreadId = threadId;
			tick().then(() => { newAwaitingThreadId = null; });
		}
		const trigger = buildFeedbackTrigger(action.label, text, false, threadId);
		feedbackMode = 'edit';
		if (onSubmit) onSubmit(trigger);
	}

	async function sendCustomFeedback() {
		if (!feedbackPopup || !feedbackInput.trim()) return;
		const text = feedbackPopup.text;
		const fb = feedbackInput.trim();
		const modeSnapshot = feedbackMode;
		const relSnapshot = snapshotFeedbackRelPositions();
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
		const threadId = await maybeOpenThreadForFeedback(fb, text, relSnapshot);
		if (threadId) {
			newAwaitingThreadId = threadId;
			tick().then(() => { newAwaitingThreadId = null; });
		}
		const trigger = buildFeedbackTrigger(fb, text, true, threadId);
		feedbackMode = 'edit';
		if (onSubmit) onSubmit(trigger);
	}

	function syncPlainLineRows() {
		if (!editor) return;
		// Numbers hidden (the default): skip the per-paragraph rect measuring
		// entirely — the gutter isn't rendered. The $effect on lineNumbersOn
		// re-syncs when the user toggles them back on.
		if (!lineNumbersOn) return;
		const contentEl = editor.view.dom as HTMLElement | null;
		if (!contentEl) return;
		const lineHeight = parseFloat(getComputedStyle(contentEl).lineHeight || '0');
		if (!lineHeight) {
			plainLineRows = [{ label: '1', top: 0 }];
			return;
		}
		const paragraphs = Array.from(
			contentEl.querySelectorAll(':scope > p')
		) as HTMLElement[];
		const visibleParagraphs = paragraphs
			.map((paragraph, index) => ({ paragraph, index }))
			.filter(({ paragraph }) =>
				!paragraph.classList.contains('d3-code-line-hidden') &&
				!paragraph.classList.contains('svg-source-line-hidden') &&
				!paragraph.classList.contains('md-table-source-line-hidden')
			);
		const contentRect = contentEl.getBoundingClientRect();
		if (paragraphs.length === 0) {
			plainLineRows = [{ label: '1', top: 0 }];
			plainGutterMinHeight = Math.max(lineHeight, contentRect.height);
			return;
		}
		// Number every paragraph at its actual top — labels stay sequential
		// (1, 2, 3, …) even when a media-overlay thumbnail or diff ghost
		// pushes paragraph N+1 hundreds of pixels down. Absolute positioning
		// is the only way to do this; a flow column with 1.45em pitch
		// breaks the moment any block-level chrome between paragraphs
		// adds height the gutter doesn't know about.
		const contentTop = contentRect.top;
		plainLineRows = visibleParagraphs.map(({ paragraph, index }) => {
			const rect = paragraph.getBoundingClientRect();
			return { label: String(index + 1), top: Math.max(0, rect.top - contentTop) };
		});
		plainGutterMinHeight = Math.max(lineHeight, contentRect.height);
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
	/** Cancel any pending idle-timer countdown without triggering a submit.
	 * Call this when the user takes a non-typing action (accept/reject) so
	 * the countdown from their last keystroke doesn't fire unexpectedly. */
	export function cancelIdleTimer(): void {
		if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
		idleBaselineText = null;
		clearCountdown();
	}

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
		return waitForTabSync(tabId);
	}

	// Diff overlay derived state. `baseline` + `rounds` are declared above via
	// `$store` auto-subscription; the rest derive from them, so there's ONE
	// reactive value per concept and no manual subscriptions to leak.
	/** True when every pending round is a tiny (<THRESHOLD char) edit. Drives a
	 * softer ghost style on the diff overlay so a one-word tweak doesn't look
	 * like a paragraph rewrite. */
	let allRoundsTiny = $derived(rounds.length > 0 && rounds.every((r) => r.kind === 'tiny'));
	// Compose the full pending stack in the overlay: baseline is rounds[0].beforeMd
	// (via reviewBaseline) and the proposal is the last round's afterMd (all ops
	// applied in order). Each round's hunks are rendered separately with that
	// round's id on the pill.
	let currentProposalText = $derived(
		rounds.length > 0 ? (rounds[rounds.length - 1].afterMd ?? null) : null
	);
	// Muted mode + which round is "expanded" in the OutlinePane drive a
	// peek-one-round-at-a-time variant of the overlay. See updateDiff().
	let muted = $derived($agentSettings.muted);
	let expandedRoundId = $derived($expandedReviewRoundId);
	// Rounds the user pinned "keep diff visible" on — their green proposal stays
	// revealed regardless of which card is focused.
	let pinnedRoundIds = $derived($pinnedDiffRounds);

	// Sole reactive trigger for the in-doc diff overlay. Touching each store-
	// derived input makes this effect re-run whenever any of them changes; the
	// actual overlay write happens inside updateDiff, which defers to a
	// queueMicrotask so it lands AFTER y-prosemirror reconciles the doc (see the
	// long comment on updateDiff). Store handlers no longer call updateDiff
	// imperatively, so this is the only reactive path — no duplicate triggers,
	// nothing to leak. A revised edit arriving over WebSocket while a thread is
	// open still reveals in the document without the user reopening the thread,
	// because `rounds` / `openThreadId` are tracked here.
	$effect(() => {
		rounds;
		openThreadId;
		baseline;
		expandedRoundId;
		muted;
		pinnedRoundIds;
		updateDiff();
	});
	// A round appearing/disappearing flips whether its thread should be
	// highlighted (diff present → suppress the redundant comment highlight), and
	// opening/closing a thread changes the same. Deferred inside
	// syncCommentOverlay, so it's safe during a Yjs apply.
	$effect(() => {
		threadsForTab;
		openThreadId;
		rounds;
		syncCommentOverlay();
	});
	// Pending-round changes alter paragraph heights (diff decorations), so the
	// line-number gutter needs a relayout when the round set changes.
	$effect(() => {
		rounds;
		schedulePlainLineSync();
	});
	// Round whose in-doc diff should pulse — driven by hovering its row in a
	// feedback thread card. Null = nothing flashing.
	let flashRoundId: string | null = null;
	let flashClearTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set (or clear) the hover-flash target. Always self-expiring: a non-null
	 * flash auto-clears after a beat so it can NEVER get stuck on. Without this,
	 * accepting an edit while hovering its row removes the card before
	 * `onmouseleave` fires, leaving `flashRoundId` pinned — and a later Ctrl+Z
	 * that resurrects the round makes its diff pulse forever. */
	function setHoverFlash(roundId: string | null) {
		if (flashClearTimer) {
			clearTimeout(flashClearTimer);
			flashClearTimer = null;
		}
		flashRoundId = roundId;
		updateDiff();
		if (roundId) {
			flashClearTimer = setTimeout(() => {
				flashClearTimer = null;
				flashRoundId = null;
				updateDiff();
			}, 1100);
		}
	}

	/** The open feedback thread's edits, in the same order the gutter cards
	 * number them, so in-doc numbers line up with the card rows. */
	function openThreadEdits(): MaterializedPendingReviewRound[] {
		if (!openThreadId) return [];
		return rounds.filter((r) => r.feedbackThreadId === openThreadId);
	}
	function openThreadEditIds(): string[] {
		return openThreadEdits().map((r) => r.id);
	}
	function openThreadRoundNumbers(): Map<string, number> {
		const m = new Map<string, number>();
		openThreadEdits().forEach((r, i) => m.set(r.id, i + 1));
		return m;
	}

	/** PM range currently highlighted as "what the user is giving feedback
	 * on". Set when the feedback popup opens, cleared when it closes.
	 * `$state` so the `.feedback-active` class on the wrapper reacts. */
	let feedbackSelectionRange: { from: number; to: number } | null = $state(null);

	// Cached preview output for the active tab: companion PDF for `.tex`
	// (same stem) or a hook's configured output. Gates the "Locate in PDF"
	// button in the feedback popover.
	let previewOutputPath = $state<string | null>(null);
	$effect(() => {
		tabId;
		void refreshPreviewOutputPath();
	});
	async function refreshPreviewOutputPath() {
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
	type PdfJumpMessage = {
		kind: 'pdf-jump';
		page: number;
		x: number;
		y: number;
		h?: number;
		v?: number;
		w?: number;
		height?: number;
	};
	type PdfSearchMessage = {
		kind: 'pdf-search';
		queries: string[];
	};
	type PdfPreviewMessage = PdfJumpMessage | PdfSearchMessage;
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
	function postPdfPreviewMessage(message: PdfPreviewMessage) {
		const ch = getPdfJumpChannel();
		if (!ch) return;
		ch.postMessage(message);
	}
	function postPdfPreviewMessageWithOpenRetry(message: PdfPreviewMessage, shouldOpenSidePreview: boolean) {
		if (shouldOpenSidePreview) {
			for (const delay of [250, 800, 1500, 2500]) {
				setTimeout(() => postPdfPreviewMessage(message), delay);
			}
		} else {
			postPdfPreviewMessage(message);
		}
	}
	function stripLatexForPdfSearch(text: string): string {
		let out = text
			.replace(/~/g, ' ')
			.replace(/``|''/g, '"')
			.replace(/\\(?:cite|citep|citet|autocite|parencite|textcite)(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
			.replace(/\\(?:ref|eqref|label|url|href)(?:\[[^\]]*\])*\{[^}]*\}/g, ' ');
		for (let i = 0; i < 5; i += 1) {
			out = out.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
		}
		return out
			.replace(/\\([#$%&_{}])/g, '$1')
			.replace(/[{}$]/g, ' ')
			.replace(/\\[a-zA-Z]+\*?/g, ' ')
			.replace(/[^\S\r\n]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
	function pdfSearchQueries(text: string): string[] {
		const cleaned = stripLatexForPdfSearch(text);
		const words = cleaned.split(/\s+/).filter(Boolean);
		const seen = new Set<string>();
		const queries: string[] = [];
		const add = (query: string) => {
			const q = query.replace(/\s+/g, ' ').trim();
			if (q.length < 18 || seen.has(q.toLowerCase())) return;
			seen.add(q.toLowerCase());
			queries.push(q);
		};
		add(words.slice(0, 16).join(' '));
		for (const size of [12, 9, 6]) {
			for (let start = 0; start <= Math.max(0, words.length - size); start += Math.max(1, Math.floor(size / 2))) {
				add(words.slice(start, start + size).join(' '));
				if (queries.length >= 12) return queries;
			}
		}
		return queries;
	}

	async function showInPdf() {
		if (!previewOutputPath) return;
		const line = selectionLineNumber();
		if (line == null) return;
		const shouldOpenSidePreview = !splitPreviewOpen && !!onOpenSplitPreview;
		if (shouldOpenSidePreview) onOpenSplitPreview?.(previewOutputPath);
		const fallbackSearch = () => {
			const queries = pdfSearchQueries(feedbackPopup?.text ?? '');
			if (queries.length === 0) return;
			postPdfPreviewMessageWithOpenRetry({ kind: 'pdf-search', queries }, shouldOpenSidePreview);
		};
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
			if (!data?.ok) {
				fallbackSearch();
				return;
			}
			const jump: PdfJumpMessage = {
				kind: 'pdf-jump',
				page: data.page,
				x: data.x,
				y: data.y,
				h: data.h,
				v: data.v,
				w: data.w,
				height: data.height
			};
			postPdfPreviewMessageWithOpenRetry(jump, shouldOpenSidePreview);
		} catch {
			fallbackSearch();
		}
	}

	let commentOverlayQueued = false;
	/** Refresh the comment-highlight overlay. ALWAYS deferred to a microtask:
	 * callers fire from Yjs observers (comment-map / review-array changes), and
	 * dispatching a PM transaction synchronously inside an observer makes
	 * y-prosemirror write the OLD doc back into the fragment — clobbering a
	 * just-applied edit (same hazard documented on `updateDiff`). Accept now
	 * touches the comments map (auto-resolve), so a synchronous dispatch here
	 * would clobber the accepted text. Deferring runs it after y-prosemirror
	 * has reconciled, when the dispatch is a safe no-op for the fragment. */
	function syncCommentOverlay() {
		if (!editor) return;
		if (commentOverlayQueued) return;
		commentOverlayQueued = true;
		queueMicrotask(() => {
			commentOverlayQueued = false;
			if (!editor) return;
			// A thread with a pending edit is already marked in the doc by the
			// diff overlay (strikethrough + green insert). Highlighting it too is
			// redundant double-marking, so we suppress the amber comment highlight
			// (and its pill) for those — only threads WITHOUT a pending edit get
			// highlighted, i.e. the user's own text-selection feedback that hasn't
			// turned into a diff yet. Agent-suggested edits show only the diff.
			const pendingEditThreadIds = new Set(
				rounds
					.map((r) => r.feedbackThreadId)
					.filter((id): id is string => typeof id === 'string')
			);
			setCommentOverlayState(editor, {
				threads: threadsForTab.filter((t) => !pendingEditThreadIds.has(t.id)),
				openThreadId
			});
			setFreezeOverlayState(editor, { rules: $rules });
		});
	}

	// Keep freeze decorations in sync when rules change outside the editor
	// update path (Rules panel delete, freeze from popup, etc.).
	$effect(() => {
		$rules;
		if (editor) setFreezeOverlayState(editor, { rules: $rules });
	});

	function shortQuote(quote: string, max = 60): string {
		const q = quote.trim().replace(/\s+/g, ' ');
		return q.length > max ? q.slice(0, max - 1) + '…' : q;
	}

	async function freezeSelection() {
		if (!feedbackPopup) return;
		const quote = feedbackPopup.text.trim();
		if (!quote) return;
		const text = makeFreezeRuleText(quote);
		if ($rules.some((r) => r.text === text)) {
			closeFeedbackPopup({ preserveSelection: false, refocusEditor: true });
			return;
		}
		const next: Rule[] = [...$rules, { id: 'r' + Date.now(), text }];
		rules.set(next);
		try {
			await fetch('/api/document', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: { rules: next } })
			});
		} catch (e) {
			console.error('Failed to persist freeze rule:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Froze passage for the agent: "${shortQuote(quote)}"`
		});
		if (editor) setFreezeOverlayState(editor, { rules: next });
		closeFeedbackPopup({ preserveSelection: false, refocusEditor: true });
		// Wake the agent so it knows this passage is off-limits going forward.
		onSubmit?.(
			`The user froze this passage — do not edit it (a Freeze rule was added):\n"${quote}"`
		);
	}

	async function unfreezeRule(ruleId: string, opts?: { wakeAgent?: boolean }) {
		const wakeAgent = opts?.wakeAgent !== false;
		const rule = $rules.find((r) => r.id === ruleId);
		if (!rule || !isFreezeRule(rule)) return;
		const quote = freezeQuoteFromRule(rule);
		const next = $rules.filter((r) => r.id !== ruleId);
		rules.set(next);
		freezeMenu = null;
		try {
			await fetch('/api/document', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: { rules: next } })
			});
		} catch (e) {
			console.error('Failed to remove freeze rule:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Unfroze passage: "${shortQuote(quote)}"`
		});
		if (editor) setFreezeOverlayState(editor, { rules: next });
		if (wakeAgent) {
			onSubmit?.(
				`The user unlocked a previously frozen passage — you may edit it again if needed:\n"${quote}"`
			);
		}
	}

	function openFreezeMenu(ruleId: string, x: number, y: number) {
		const rule = $rules.find((r) => r.id === ruleId);
		if (!rule || !isFreezeRule(rule)) return;
		const quote = freezeQuoteFromRule(rule);
		// Toggle closed if the same lock is clicked again.
		if (freezeMenu?.ruleId === ruleId) {
			freezeMenu = null;
			return;
		}
		freezeMenu = { ruleId, quote, x, y };
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
			// Guard against timing issues where one store updates before the
			// other (e.g. fragment observer clears rounds before array observer
			// sets baseline to null). Use hasRounds as source of truth.
			const hasRounds = rounds.length > 0;
			// Muted mode: hide the overlay entirely until the user clicks a
			// pending card, then show only that round's decorations.
			let baselineForOverlay = hasRounds ? baseline : null;
			let proposalForOverlay = hasRounds ? currentProposalText : null;
			let pendingRoundsForOverlay: MaterializedPendingReviewRound[] = [];
			if (muted && hasRounds) {
				const expanded = expandedRoundId
					? rounds.find((r) => r.id === expandedRoundId)
					: null;
				if (expanded && expanded.beforeMd != null && expanded.afterMd != null) {
					baselineForOverlay = expanded.beforeMd;
					proposalForOverlay = expanded.afterMd;
					pendingRoundsForOverlay = [expanded];
				} else {
					baselineForOverlay = null;
					proposalForOverlay = null;
				}
			} else if (hasRounds) {
				pendingRoundsForOverlay = rounds;
			}
			const validThreadIds = new Set(
				threadsForTab.filter((t) => !t.resolved).map((t) => t.id)
			);
			const overlayRounds = pendingRoundsForOverlay.map((round) =>
				round.feedbackThreadId && !validThreadIds.has(round.feedbackThreadId)
					? { ...round, feedbackThreadId: undefined }
					: round
			);
			setDiffState(editor, {
				baseline: baselineForOverlay,
				proposedText: proposalForOverlay,
				activeFeedbackRange: feedbackSelectionRange,
				allRoundsTiny,
				// Proposed (green) lines show inline for the focused round, any
				// the user pinned "keep diff visible", and — when a feedback
				// thread card is open — all the edits grouped under it. No pill.
				revealedRoundIds: new Set([
					...pinnedRoundIds,
					...(expandedRoundId ? [expandedRoundId] : []),
					...openThreadEditIds()
				]),
				// When a feedback thread card is open, number its edits 1..N in
				// the document so each in-doc diff maps to a numbered card row.
				roundNumbers: openThreadRoundNumbers(),
				// Pulse the hovered edit's diff so the user can locate it fast.
				flashRoundId,
				pendingRounds: overlayRounds
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
		// Fully paused: never start the 3-2-1 auto-wake countdown.
		if ($agentSettings.paused) {
			cancelIdleTimer();
			return;
		}
		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			clearCountdown();
			// Skip the auto-submit if this editing burst netted no change (e.g.
			// space then backspace) — the agent already has this exact text.
			const current = editor ? docPlainText(editor.state.doc) : null;
			const unchanged = idleBaselineText !== null && current === idleBaselineText;
			idleBaselineText = null;
			if (!unchanged && onSubmit) onSubmit();
		}, IDLE_MS);
	}

	// If the user pauses mid-countdown, clear it immediately so the pill
	// stops showing 3s/2s/1s and no pending timeout can still fire.
	$effect(() => {
		if ($agentSettings.paused) cancelIdleTimer();
	});

	/**
	 * Decide whether a PM transaction should restart the auto-submit idle
	 * timer. Only the user's own text edits count. We skip:
	 *   - remote Yjs syncs (`ySyncPluginKey` meta) — another client / the agent;
	 *   - meta-only transactions (`!docChanged`: overlay decoration refreshes,
	 *     setMeta, selection moves) — these fire constantly while edits/threads
	 *     are on screen and would otherwise keep resetting the countdown so it
	 *     never reaches 0.
	 * (The server is authoritative for persistence — Hocuspocus persists every
	 * update — so this component doesn't HTTP-autosave; it only drives the timer.)
	 */
	function onEditorUpdate({ transaction }: { transaction: Transaction }) {
		if (!editor) return;
		schedulePlainLineSync();
		const isUserEdit =
			transaction.docChanged && transaction.getMeta(ySyncPluginKey) === undefined;
		if (!isUserEdit) return;
		// Burst start (no countdown running): snapshot the doc as it was BEFORE
		// this keystroke, so the timer can tell whether the burst netted any
		// real change.
		if (idleTimer === null) idleBaselineText = docPlainText(transaction.before);
		restartIdleCountdown();
		// The user is writing, not reading comments. Collapse any expanded
		// thread so its margin card doesn't sit in their peripheral vision;
		// they can re-open it via the pill or gutter card.
		if (openThreadId) openCommentThreadId.set(null);
	}

	onMount(async () => {
		// Wait for the Hocuspocus provider's initial sync to finish. The
		// server is authoritative: it replays the tab's Yjs update log from
		// SQLite (seeding from the workspace file on first open if the log
		// is empty) and streams the result here before `synced` fires.
		const ydoc = getYDocForTab(tabId);
		await whenYDocReadyForTab(tabId);

		editor = new Editor({
			element,
			extensions: [
				...collaborativeExtensions(ydoc, { placeholder: 'Start writing...' }),
				DiffOverlay,
				CommentOverlay,
				FreezeOverlay,
				CelebrationOverlay,
				FindOverlay,
				MediaOverlay,
				D3Overlay,
				...(shouldRenderMarkdownForPath(tabId) ? [MarkdownRender] : []),
				SourceCommentOverlay.configure({
					style: sourceCommentStyleForPath(tabId)
				})
			],
			// Collaboration provides initial content from the Y.Doc; do NOT
			// pass a string `content` here (doing so would wipe the Y.Doc).
			editorProps: {
				attributes: { class: 'tiptap-content tiptap-plain' },
				// Plain-text copy: the Y.Doc is stored verbatim (serializeFragment
				// does no escaping), so hand ProseMirror the raw text between the
				// slice bounds. Paragraphs join with '\n' and hard breaks render as
				// '\n' inside a line — matching the on-disk file byte-for-byte.
				clipboardTextSerializer: (slice) =>
					slice.content.textBetween(0, slice.content.size, '\n', '\n'),
				handlePaste: (view, event) => handleEditorPaste(view, event).handled,
				handleDrop: (view, event) => handleEditorDrop(view, event as DragEvent).handled,
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
					if (handleSourceCommentShortcut(event)) return true;
					// Cmd/Ctrl+Enter wakes the agent immediately, skipping the
					// idle countdown. Plain Enter still inserts a new line.
					// No-op while paused — same gate as Wake up / Send.
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						if ($agentSettings.paused) return true;
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
					if (!feedbackPopup) return;
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

		const handlePreviewLayoutChanged = () => schedulePlainLineSync();
		editorRoot.addEventListener('d3-code-visibility-changed', handlePreviewLayoutChanged);
		editorRoot.addEventListener('docwriter:media-layout-changed', handlePreviewLayoutChanged);
		editorRoot.addEventListener('docwriter:markdown-layout-changed', handlePreviewLayoutChanged);

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

		const handleFreezeMenu = (ev: Event) => {
			const { ruleId, x, y } = (ev as CustomEvent).detail as {
				ruleId?: string;
				x?: number;
				y?: number;
			};
			if (ruleId && typeof x === 'number' && typeof y === 'number') {
				openFreezeMenu(ruleId, x, y);
			}
		};
		editorRoot.addEventListener('docwriter:freeze-menu', handleFreezeMenu as EventListener);

		// Mousedown anywhere outside a gutter card collapses the open
		// thread AND the open edit card. Pill clicks stop propagation on
		// mousedown, so window won't see those; inline-highlight clicks
		// fire handleClick after this mousedown, so they re-open the
		// matching thread.
		const handleOutsideMousedown = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest?.('.gutter-card')) return;
			if (target.closest?.('.comment-thread-pill')) return;
			if (target.closest?.('.freeze-lock-menu')) return;
			if (target.closest?.('.freeze-lock')) return;
			openCommentThreadId.set(null);
			expandedReviewRoundId.set(null);
			freezeMenu = null;
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
			editorRoot.removeEventListener('docwriter:freeze-menu', handleFreezeMenu as EventListener);
			editorRoot.removeEventListener('d3-code-visibility-changed', handlePreviewLayoutChanged);
			editorRoot.removeEventListener('docwriter:media-layout-changed', handlePreviewLayoutChanged);
			editorRoot.removeEventListener('docwriter:markdown-layout-changed', handlePreviewLayoutChanged);
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
		if (flashClearTimer) clearTimeout(flashClearTimer);
		flashClearTimer = null;
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
		lineNumbersOn;
		schedulePlainLineSync();
	});

	// When a render starts, cancel any pending idle auto-submit. `$store`
	// auto-subscription in an $effect cleans up on unmount (no leaked subscriber).
	$effect(() => {
		if ($isRendering) {
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

	export function focusEditor(opts?: { scrollIntoView?: boolean }): void {
		editor?.commands.focus(null, { scrollIntoView: opts?.scrollIntoView ?? true });
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

<svelte:window onkeydown={handleFeedbackWindowKeydown} />

<div
	class="tiptap-host"
	class:find-open={findState.open}
	class:show-ai-provenance={$showAiProvenance}
>
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
	style:--font-scale={fontScale}
	bind:this={wrapperEl}
>
	<div
		class="plain-editor-shell"
		class:soft-wrap-enabled={softWrap}
	>
		{#if lineNumbersOn}
			<div
				class="plain-line-gutter"
				aria-hidden="true"
				style:min-height="{plainGutterMinHeight}px"
			>
				{#each plainLineRows as row}
					<div class="plain-line-number" style:top="{row.top}px">{row.label}</div>
				{/each}
			</div>
		{/if}
		<div class="tiptap-editor plain-mode" class:soft-wrap-enabled={softWrap} bind:this={element}></div>
		{#if hasGutterContent}
			<CommentGutter
				threads={threadsForTab}
				rounds={rounds}
				baseline={baseline}
				editor={editor}
				tabId={tabId}
				openThreadId={openThreadId}
				{newAwaitingThreadId}
				onOpen={(id) => openCommentThreadId.set(id)}
				onClose={() => openCommentThreadId.set(null)}
				onAcceptRound={(roundId) => onAcceptInlineEdit?.(roundId)}
				onRejectRound={(roundId) => onRejectInlineEdit?.(roundId)}
				pinnedRoundIds={pinnedRoundIds}
				onAcceptFeedback={(roundIds) => onAcceptFeedbackEdits?.(roundIds)}
				onAcceptAll={() => onAcceptAllEdits?.()}
				onRejectAll={() => onRejectAllEdits?.()}
				onResolveThread={(threadId, resolved) => onResolveThread?.(threadId, resolved)}
				muted={muted}
				onPinThreadEdits={(roundIds, pinned) =>
					pinnedDiffRounds.update((s) => {
						const n = new Set(s);
						for (const id of roundIds) pinned ? n.add(id) : n.delete(id);
						return n;
					})}
				onHoverEdit={(roundId) => setHoverFlash(roundId)}
				onApprove={(t, msgId) => {
					const msg = t.messages.find((m) => m.id === msgId);
					const suggestion = msg?.proposedEdit;
					const transcript = t.messages
						.map((m) => `- [${m.author === 'agent' ? 'agent' : 'user'}] ${m.text}`)
						.join('\n');
					const trigger = suggestion
						? `The user approved the suggestion in comment thread "${t.id}" on this tab. Apply this edit via edit_doc with thread_id="${t.id}" so it attaches to this thread:\n\nold_string: "${suggestion.oldString}"\nnew_string: "${suggestion.newString}"\n\nAnchor passage: "${t.anchor.quote}"\nFull thread:\n${transcript}`
						: `The user approved comment thread "${t.id}" on this tab. Apply the edit you described via edit_doc with thread_id="${t.id}" so it attaches to this thread.\n\nAnchor passage: "${t.anchor.quote}"\nFull thread:\n${transcript}`;
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
					// Routing (revise the pending edit vs. reply in words) lives in
					// the system prompt's "Where a response goes" rules; the trigger
					// carries the facts only.
					const hasPendingEdit = rounds.some((r) => r.feedbackThreadId === t.id);
					const trigger =
						`The user replied on comment thread thread_id="${t.id}" on this tab` +
						`${hasPendingEdit ? ' (it has a pending edit)' : ''}.\n` +
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
			<div class="feedback-secondary-row">
				{#if previewOutputPath}
					<button
						class="feedback-show-in-pdf"
						type="button"
						onclick={showInPdf}
						title="Locate this passage in the PDF preview"
					>
						<Crosshair size={11} />
						<span>Locate in PDF</span>
					</button>
				{/if}
				<button
					class="feedback-freeze-btn"
					type="button"
					onclick={() => void freezeSelection()}
					title="Stop the agent from editing this passage. Stored as a Freeze rule; unlock from the gutter or Rules panel."
				>
					<Lock size={11} />
					<span>Freeze for agent</span>
				</button>
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
						if (e.key === 'Escape') {
							e.preventDefault();
							e.stopPropagation();
							closeFeedbackPopup({ preserveSelection: true, refocusEditor: true });
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
					oncut={(e) => {
						if (feedbackInput || !feedbackPopup) return;
						e.preventDefault();
						e.clipboardData?.setData('text/plain', feedbackPopup.text);
						deleteSelectedTextFromEditor();
					}}
				></div>
				<button class="feedback-submit" onclick={sendCustomFeedback}>Go</button>
			</div>
			<div class="feedback-mode-row" role="group" aria-label="How the agent should respond">
				<button
					class="mode-chip"
					class:mode-chip-active={feedbackMode === 'edit'}
					onclick={() => (feedbackMode = 'edit')}
					title="The agent proposes an edit to the passage right away."
					type="button"
				>Direct edit</button>
				<button
					class="mode-chip"
					class:mode-chip-active={feedbackMode === 'plan'}
					onclick={() => (feedbackMode = 'plan')}
					title="The agent first replies on the thread with why this passage reads wrong and what it intends to change, then proposes the edit."
					type="button"
				>Plan first</button>
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
			<div class="feedback-hint">
				<kbd>Enter</kbd> to send · <kbd>Esc</kbd> to dismiss
			</div>
		</div>
	{/if}
	{#if freezeMenu}
		<div
			class="freeze-lock-menu"
			style:left="{freezeMenu.x}px"
			style:top="{freezeMenu.y}px"
			role="menu"
			aria-label="Frozen passage"
		>
			<div class="freeze-lock-menu-quote">
				“{shortQuote(freezeMenu.quote, 72)}”
			</div>
			<button
				class="freeze-lock-menu-action"
				type="button"
				role="menuitem"
				onclick={() => void unfreezeRule(freezeMenu!.ruleId)}
			>
				<Unlock size={12} />
				<span>Unlock — allow agent to edit</span>
			</button>
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
	/* AI-provenance view: agent-written text carries the `ai` mark
	 * (span[data-ai-text], see AiProvenanceMark). It renders as normal prose
	 * until the toggle turns the view on — then it takes the theme's
	 * provenance color, iA-Writer-authorship style. */
	.tiptap-host :global(.tiptap-content span[data-ai-text]) {
		transition: color 160ms ease;
	}
	.tiptap-host.show-ai-provenance :global(.tiptap-content span[data-ai-text]) {
		color: var(--ai-provenance, var(--tool-accent));
	}
	.tiptap-wrapper {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		/* Tighter right padding when there's no comment gutter — the gutter
		 * column adds ~180px of breathing room on the right when comments
		 * exist, so the wrapper itself doesn't need much. Without comments
		 * we still want a small gap so prose doesn't kiss the right edge. */
		/* Bottom padding reserves scroll room equal to the floating agent
		 * dock's height (published as --dock-reserved-bottom) so the lowest
		 * gutter card can scroll clear of the dock instead of hiding behind
		 * it. The dock sits bottom-right over this wrapper. */
		/* Symmetric L/R padding, constant whether or not comments exist — the
		 * gutter column is always reserved in the grid, so the page never
		 * shifts when a thread/card appears. Tight (16px) so the width goes
		 * to the page + comment margin instead of dead canvas. */
		padding: 0 16px calc(48px + var(--dock-reserved-bottom, 0px)) 16px;
		/* Shared app canvas (defined on .app) — the document is a white sheet
		 * floating on it; the line-number + comment gutters live on the canvas
		 * in the margins rather than blending into the page. */
		background: var(--canvas, color-mix(in srgb, var(--text) 5%, var(--bg)));
	}
	.tiptap-wrapper.plain-mode-wrapper {
		overflow: auto;
	}
	/* The page: a white sheet with a soft shadow. Only the editor column gets
	 * this — the line gutter and comment gutter stay on the canvas. */
	.tiptap-editor.plain-mode {
		/* The page is the ELEVATED surface (matches the comment cards) so it
		 * lifts off the recessed canvas in every theme — in dark themes this
		 * is lighter than the canvas, not darker. */
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 3px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 8px 28px rgba(0, 0, 0, 0.05);
		/* A near-empty doc should still read as a sheet of paper, not a
		 * one-line box — fill most of the viewport height. Grows past this
		 * once content is long enough. */
		min-height: calc(100vh - 150px);
	}
	/* Google-Docs-style page: line gutter | a page-width column | the
	 * comment/edit gutter. The whole group is centered, so the page floats
	 * like a sheet of paper with the review cards in its right margin. The
	 * gutter column is reserved ALWAYS (even with no cards) so the page
	 * doesn't shift left when a review appears — the cards just fill the
	 * margin that was already there. Keep `--gutter-width` in sync with
	 * `.comment-gutter` in CommentGutter.svelte. */
	.plain-editor-shell {
		display: grid;
		grid-template-columns: var(--line-gutter-width, 52px) minmax(0, var(--paper-width, 720px)) var(--gutter-width, 300px);
		gap: var(--editor-grid-gap, 18px);
		width: 100%;
		justify-content: center;
		align-items: start;
	}
	/* Explicit column assignment: the line gutter is conditionally rendered
	 * (line-numbers toggle), so auto-placement would otherwise shift the
	 * page into column 1 when it's absent. */
	.plain-editor-shell > .plain-line-gutter {
		grid-column: 1;
	}
	.plain-editor-shell > .tiptap-editor.plain-mode {
		grid-column: 2;
	}
	.plain-editor-shell > :global(.comment-gutter) {
		grid-column: 3;
	}
	.plain-line-gutter {
		position: relative;
		align-self: start;
		/* No padding: when children are absolutely positioned, gutter
		 * padding doesn't reserve visual space for them — instead the
		 * number itself owns its right inset (so it stops short of the
		 * border) and its width (so multi-digit and single-digit numbers
		 * right-align consistently). Padding-top would also offset all
		 * line numbers down because their `top` values are measured from
		 * the editor's content top, not from this padding edge. */
		padding: 0;
		color: var(--text-faint);
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(15px * var(--font-scale, 1));
		line-height: 1.45;
		user-select: none;
		pointer-events: none;
		/* Sits on the canvas in the left margin (like a page-number column),
		 * not on the white sheet — so no background and no column rule. */
		background: transparent;
	}
	.plain-line-number {
		position: absolute;
		right: 0;
		/* Match the old flow-column geometry exactly: each number block
		 * spans the gutter's content area (40px) with a 12px right inset
		 * so the digit stops well before the column rule. Fixed width +
		 * `text-align: right` keeps single- and multi-digit numbers
		 * right-aligned consistently. */
		width: var(--line-number-width, 40px);
		padding-right: var(--line-number-pad-right, 12px);
		box-sizing: border-box;
		height: 1.45em;
		text-align: right;
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
		/* Page margins live on the inner content (not the column element) so
		 * the line-number tops — measured relative to .tiptap-content — stay
		 * aligned. box-sizing keeps width:100% inside the column. */
		padding: 26px 30px;
		box-sizing: border-box;
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

	.tiptap-editor :global(.source-comment) {
		color: var(--text-muted);
		opacity: 0.58;
	}

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
	/* Fade-in for diff decorations. ProseMirror creates fresh DOM for these
	 * spans/widgets every time the decoration set rebuilds, so the keyframe
	 * fires whenever the overlay turns on (unmute, peek a round, new edit
	 * arrives). Going the other direction (mute / collapse peek) the nodes
	 * are removed so out-fade isn't possible without buffering — skipped
	 * intentionally; the pop-out reads as "dismissed" anyway. */
	@keyframes diffFadeIn {
		from { opacity: 0; }
		to { opacity: var(--diff-final-opacity, 1); }
	}

	.tiptap-editor :global(.diff-added) {
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
		animation: diffFadeIn 480ms ease-out both;
	}
	.tiptap-editor :global(.tiptap-plain p.diff-added-line) {
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
		animation: diffFadeIn 480ms ease-out both;
	}
	.tiptap-editor :global(.diff-added-line) {
		display: block;
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
		white-space: pre-wrap;
		cursor: text;
		user-select: none;
		transform-origin: top;
		animation: diffSlideIn 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	.tiptap-editor :global(.diff-added[data-thread-id]),
	.tiptap-editor :global(.diff-added-line[data-thread-id]),
	.tiptap-editor :global(.diff-removed[data-thread-id]),
	.tiptap-editor :global(.diff-removed-line[data-thread-id]),
	.tiptap-editor :global(.diff-insert-caret[data-thread-id]) {
		cursor: pointer;
	}
	/* Insertion caret: a small pulsing green bar marking where a collapsed,
	 * purely-additive agent edit will add text — so an edit with nothing
	 * struck out still signals "more coming here" in the document. */
	.tiptap-editor :global(.diff-insert-caret) {
		display: inline-block;
		width: 2px;
		height: 1.05em;
		margin: 0 1px;
		vertical-align: text-bottom;
		border-radius: 1px;
		background: var(--diff-added-color);
		user-select: none;
		animation: diffInsertCaretPulse 1.6s ease-in-out infinite;
	}
	@keyframes diffInsertCaretPulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 0.8; }
	}
	@keyframes diffSlideIn {
		0% {
			opacity: 0;
			transform: translateY(-3px) scaleY(0.7);
			max-height: 0;
		}
		100% {
			opacity: 1;
			transform: translateY(0) scaleY(1);
			max-height: 1000px;
		}
	}
	/* "Show" / "Hide" pill that toggles a diff block's proposed
	 * replacement. The inline variant lives at the end of the last
	 * strikethrough paragraph and is pinned to the right margin via
	 * absolute positioning so it consumes ZERO vertical space — the
	 * cursor doesn't move when the user types nearby. The block
	 * variant is the fallback for pure insertions (no strikethrough
	 * to host the inline pill). */
	.tiptap-editor :global(.diff-toggle-pill-wrap.inline) {
		position: absolute;
		top: 50%;
		right: 6px;
		transform: translateY(-50%);
		display: inline-flex;
		gap: 4px;
		align-items: center;
		user-select: none;
		z-index: 5;
		pointer-events: auto;
		opacity: 1;
		text-decoration: none;
	}
	.tiptap-editor :global(.diff-toggle-pill-wrap.block) {
		display: flex;
		gap: 4px;
		align-items: center;
		margin: 4px 0;
		user-select: none;
	}
	.tiptap-editor :global(.diff-toggle-pill) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10.5px;
		font-weight: 500;
		color: var(--accent);
		background: var(--bg-elevated);
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-light));
		border-radius: 999px;
		cursor: pointer;
		line-height: 1.4;
		letter-spacing: 0.02em;
		text-decoration: none;
		opacity: 0.85;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}
	.tiptap-editor :global(.diff-toggle-pill:hover) {
		background: var(--accent-bg);
		border-color: var(--accent);
		opacity: 1;
	}
	.tiptap-editor :global(.diff-toggle-pill.expanded) {
		color: var(--text-secondary);
		background: var(--bg-surface);
		border-color: var(--border-light);
	}
	.tiptap-editor :global(.diff-toggle-pill.expanded:hover) {
		background: var(--bg);
		color: var(--text);
		border-color: color-mix(in srgb, var(--text-secondary) 30%, var(--border-light));
	}
	/* Inline ✓ accept pill — companion to the toggle pill. Green palette
	 * so it reads as the affirmative action. */
	.tiptap-editor :global(.diff-accept-pill) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px 1px 6px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--diff-added-color);
		background: var(--bg-elevated);
		border: 1px solid color-mix(in srgb, var(--diff-added-color) 35%, var(--border-light));
		border-radius: 999px;
		cursor: pointer;
		line-height: 1.4;
		text-decoration: none;
		opacity: 0.85;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}
	.tiptap-editor :global(.diff-accept-pill:hover) {
		background: color-mix(in srgb, var(--diff-added-color) 14%, var(--bg-elevated));
		border-color: var(--diff-added-color);
		opacity: 1;
	}
	.tiptap-editor :global(.diff-accept-pill svg) {
		display: block;
		flex: none;
	}
	/* Inline ✕ reject pill — mirror of accept, red palette. */
	.tiptap-editor :global(.diff-reject-pill) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px 1px 6px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--diff-removed-color);
		background: var(--bg-elevated);
		border: 1px solid color-mix(in srgb, var(--diff-removed-color) 35%, var(--border-light));
		border-radius: 999px;
		cursor: pointer;
		line-height: 1.4;
		text-decoration: none;
		opacity: 0.85;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}
	.tiptap-editor :global(.diff-reject-pill:hover) {
		background: color-mix(in srgb, var(--diff-removed-color) 14%, var(--bg-elevated));
		border-color: var(--diff-removed-color);
		opacity: 1;
	}
	.tiptap-editor :global(.diff-reject-pill svg) {
		display: block;
		flex: none;
	}
	/* Strikethrough drawn as a pseudo-element line that sweeps left → right
	 * (scaleX 0 → 1, like a pen). It's painted ABOVE any background, so the
	 * strike still shows when the word also has a comment highlight behind
	 * it — a `background`-based strike would get covered. */
	@keyframes strikeSweepX {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}
	.tiptap-editor :global(.diff-removed) {
		position: relative;
		color: var(--diff-removed-color);
		text-decoration: none;
		--diff-final-opacity: 0.7;
		opacity: 0.7;
		/* Strike drawn as a repeating background line (not a single absolutely-
		 * positioned ::after box) so it renders on EVERY row when a removed span
		 * wraps across lines — the old ::after only covered the first row.
		 * box-decoration-break: clone repeats the background per line fragment;
		 * the background-size width sweeps 0→100% left-to-right. */
		background-image: linear-gradient(var(--diff-removed-color), var(--diff-removed-color));
		background-repeat: no-repeat;
		background-position: 0 0.58em;
		background-size: 100% 1.5px;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
		animation: diffFadeIn 480ms ease-out both,
			strikeSweepBg 520ms cubic-bezier(0.33, 0, 0.2, 1) both;
	}
	@keyframes strikeSweepBg {
		from {
			background-size: 0% 1.5px;
		}
		to {
			background-size: 100% 1.5px;
		}
	}
	.tiptap-editor :global(.tiptap-plain p.diff-removed-line) {
		color: var(--diff-removed-color);
		text-decoration: line-through;
		--diff-final-opacity: 0.72;
		opacity: 0.72;
		/* Multi-row paragraphs can't sweep a single line cleanly, so they
		 * redden + draw the strike in gradually instead (still gentle). */
		animation: removedLineReddenIn 520ms ease-out both;
		position: relative;
	}
	@keyframes removedLineReddenIn {
		from {
			color: var(--prose-text);
			text-decoration-color: transparent;
			opacity: 0.85;
		}
	}
	/* Word-level modified paragraph: no color or strikethrough — the
	 * paragraph reads as normal editable text and only the changed tokens
	 * are decorated. `position: relative` is the sole effect, so the
	 * absolutely-positioned inline "Show diff" pill anchors to this
	 * paragraph's right margin instead of the editor edge. */
	.tiptap-editor :global(.tiptap-plain p.diff-modified-line),
	.tiptap-editor :global(.diff-modified-line) {
		position: relative;
	}
	/* Number badge floating in the left margin of a changed paragraph, shown
	 * while its feedback thread card is open — maps each in-doc change to a
	 * numbered row in the card. */
	.tiptap-editor :global(.diff-num-badge) {
		position: absolute;
		/* Fan out leftward when several badges land on the same line. */
		left: calc(-1.9em - var(--badge-i, 0) * 1.5em);
		top: 0.15em;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.35em;
		height: 1.35em;
		border-radius: 50%;
		/* Light circle matching the card's numbered rows (.edit-num) — soft
		 * accent fill + accent text, not a solid dark badge. */
		background: color-mix(in srgb, var(--accent) 14%, var(--bg));
		color: var(--accent);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 0.66em;
		font-weight: 700;
		line-height: 1;
		user-select: none;
	}
	.tiptap-editor :global(.diff-thread-btn) {
		position: absolute;
		left: calc(-3.45em - var(--thread-i, 0) * 1.55em);
		top: 0.08em;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.55em;
		height: 1.55em;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-light));
		border-radius: 50%;
		background: var(--bg-elevated);
		color: var(--accent);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
		cursor: pointer;
		user-select: none;
		z-index: 6;
	}
	.tiptap-editor :global(.diff-thread-btn:hover) {
		background: var(--accent-bg);
		border-color: var(--accent);
	}
	.tiptap-editor :global(.diff-thread-btn svg) {
		display: block;
		width: 0.85em;
		height: 0.85em;
	}
	/* Hover-flash: pulse a changed paragraph when its row is hovered in the
	 * thread card, so the user can locate it instantly. */
	.tiptap-editor :global(.diff-flash) {
		animation: diff-flash-pulse 0.9s ease-in-out infinite;
		border-radius: 3px;
	}
	@keyframes diff-flash-pulse {
		0%,
		100% {
			background: transparent;
		}
		50% {
			background: color-mix(in srgb, var(--accent) 22%, transparent);
		}
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
	.feedback-secondary-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 8px;
	}
	.feedback-show-in-pdf,
	.feedback-freeze-btn {
		font: inherit;
		font-size: 11px;
		color: var(--text-faint);
		background: transparent;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		padding: 3px 9px 3px 7px;
		margin-bottom: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.feedback-show-in-pdf:hover,
	.feedback-freeze-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.feedback-freeze-btn {
		color: var(--accent);
		border-color: var(--accent-light);
		background: var(--accent-bg);
	}
	.feedback-freeze-btn:hover {
		color: var(--accent-subject, var(--accent));
		background: color-mix(in srgb, var(--accent) 16%, var(--accent-bg));
		border-color: var(--accent);
	}
	/* Frozen passage: no purple/accent wash (that reads as human highlight
	 * or feedback). Soft ink underline + muted lock in the left margin. */
	:global(.tiptap-content .freeze-mark) {
		background: transparent;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
		border: none;
		border-radius: 0;
		box-shadow: inset 0 -1px 0 0 color-mix(in srgb, var(--text-faint) 55%, transparent);
		outline: none;
	}
	/* ProseMirror wraps widgets in .ProseMirror-widget — collapse that too. */
	:global(.tiptap-content .ProseMirror-widget:has(.freeze-lock-slot)),
	:global(.tiptap-content .freeze-lock-slot) {
		position: relative;
		display: inline-block;
		width: 0 !important;
		max-width: 0 !important;
		height: 0 !important;
		margin: 0 !important;
		padding: 0 !important;
		border: 0 !important;
		overflow: visible;
		vertical-align: baseline;
	}
	:global(.tiptap-content .freeze-lock) {
		position: absolute;
		left: -24px;
		top: -2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		line-height: 0;
	}
	:global(.tiptap-content .freeze-lock:hover) {
		color: var(--text-muted);
		background: var(--bg-hover);
	}
	.freeze-lock-menu {
		position: fixed;
		z-index: 40;
		transform: translateX(-50%);
		min-width: 200px;
		max-width: 280px;
		padding: 8px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-elevated);
		box-shadow: 0 8px 24px color-mix(in srgb, var(--text) 12%, transparent);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.freeze-lock-menu-quote {
		padding: 2px 4px 8px;
		font-size: 11px;
		line-height: 1.35;
		color: var(--text-faint);
		font-style: italic;
	}
	.freeze-lock-menu-action {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}
	.freeze-lock-menu-action:hover {
		background: var(--bg-hover);
		color: var(--text);
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
	/* Footer keyboard hint — reminds you the popover is dismissable with
	 * Esc (and submittable with Enter) so it never feels like a trap. */
	.feedback-hint {
		margin-top: 8px;
		padding-top: 7px;
		border-top: 1px solid var(--border-light);
		font-size: 11px;
		color: var(--text-faint);
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.feedback-hint kbd {
		font-family: inherit;
		font-size: 10px;
		line-height: 1;
		padding: 2px 5px;
		border: 1px solid var(--border-light);
		border-radius: 4px;
		background: var(--bg-surface);
		color: var(--text-secondary);
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
	/* Media overlay widgets — Substack-style inline previews layered on
	 * top of plain markdown source. The thumbnail variant is a block
	 * decoration that appears after a host paragraph; the card variant
	 * is the body of the floating hover tooltip (`.media-link-tooltip`,
	 * which lives in document.body). The card styles MUST be top-level
	 * `:global` rather than scoped under `.tiptap-editor` because the
	 * tooltip is rendered outside the editor's DOM tree — scoping under
	 * `.tiptap-editor` would silently fail to apply, leaving the og
	 * image to render at its native (often gigantic) size. */
	:global(.media-widget) {
		display: block;
		margin: 6px 0 12px;
		user-select: none;
		max-width: 680px;
	}
	:global(.media-image-widget) {
		display: block;
		max-width: 100%;
	}
	:global(.media-svg-widget) {
		display: block;
		max-width: 720px;
		padding: 10px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-elevated);
	}
	:global(.media-svg-label) {
		margin-bottom: 8px;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	:global(.media-thumb) {
		display: block;
		max-width: 100%;
		max-height: 360px;
		border-radius: 6px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		object-fit: contain;
		object-position: left center;
		animation: media-fade-in 240ms ease-out both;
	}
	:global(.media-svg-thumb) {
		width: 100%;
		max-height: 420px;
		background: white;
	}
	:global(.media-thumb-error) {
		padding: 10px 12px;
		border-radius: 6px;
		border: 1px dashed var(--border-light);
		background: var(--bg-surface);
		color: var(--text-faint);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 12px;
	}
	:global(.media-thumb-error-label) {
		font-style: italic;
	}
	/* Link card. Row layout: image left, body right. Falls back to a
	 * body-only card when og:image is missing. */
	:global(.media-card-widget) {
		display: flex;
		gap: 12px;
		align-items: stretch;
		padding: 12px;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-elevated);
		text-decoration: none;
		color: inherit;
		font-family: 'Inter', -apple-system, sans-serif;
		min-height: 88px;
		max-width: 560px;
		transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
		animation: media-fade-in 240ms ease-out both;
	}
	:global(.media-card-widget:hover) {
		border-color: color-mix(in srgb, var(--accent) 35%, var(--border-light));
		background: var(--bg-hover);
	}
	:global(.media-card-image) {
		flex: 0 0 88px;
		width: 88px;
		height: 88px;
		overflow: hidden;
		border-radius: 4px;
		background: var(--bg-surface);
	}
	:global(.media-card-image img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	:global(.media-card-body) {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 4px;
	}
	:global(.media-card-title) {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
		line-height: 1.35;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	:global(.media-card-desc) {
		font-size: 12.5px;
		color: var(--text-muted);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	:global(.media-card-host) {
		font-size: 10.5px;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: auto;
	}
	:global(.media-card-minimal) {
		font-size: 12px;
		color: var(--text-muted);
		font-style: italic;
		align-self: center;
	}
	/* Skeleton for the og card while metadata is fetching. The shimmer
	 * gradient sweeps left-to-right; same hue as the surrounding chrome
	 * so it reads as "loading" not "broken". */
	:global(.media-card-skeleton) {
		display: flex;
		gap: 12px;
		flex: 1;
		min-width: 0;
	}
	:global(.media-card-skeleton-image) {
		flex: 0 0 88px;
		width: 88px;
		height: 88px;
		border-radius: 4px;
		background: linear-gradient(
			90deg,
			var(--bg-surface) 0%,
			var(--bg-hover) 50%,
			var(--bg-surface) 100%
		);
		background-size: 200% 100%;
		animation: media-shimmer 1.4s linear infinite;
	}
	:global(.media-card-skeleton-body) {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		justify-content: center;
	}
	:global(.media-card-skeleton-line) {
		height: 10px;
		border-radius: 3px;
		background: linear-gradient(
			90deg,
			var(--bg-surface) 0%,
			var(--bg-hover) 50%,
			var(--bg-surface) 100%
		);
		background-size: 200% 100%;
		animation: media-shimmer 1.4s linear infinite;
	}
	@keyframes media-shimmer {
		from { background-position: 200% 0; }
		to { background-position: -200% 0; }
	}
	@keyframes media-fade-in {
		from { opacity: 0; transform: translateY(-2px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* D3 diagram widgets. Rendered by src/lib/editor/d3-overlay.ts as block
	 * widget decorations, so these need top-level global selectors. */
	.tiptap-editor :global(.d3-code-fence) {
		color: var(--text-muted);
	}
	.tiptap-editor :global(.tiptap-plain p.d3-code-line) {
		margin: 0;
	}
	.tiptap-editor :global(.tiptap-plain p.d3-code-line-hidden) {
		display: none;
	}
	.tiptap-editor :global(.tiptap-plain p.d3-code-line-expanded) {
		animation: d3-source-reveal 90ms ease-out both;
	}
	.tiptap-editor :global(.tiptap-plain p.svg-source-line-hidden) {
		display: none;
	}
	.tiptap-editor :global(.tiptap-plain p.svg-source-line-expanded) {
		animation: d3-source-reveal 90ms ease-out both;
	}
	.tiptap-editor :global(.tiptap-plain p.md-table-source-line-hidden) {
		display: none;
	}
	.tiptap-editor :global(.tiptap-plain p.md-table-source-line-expanded) {
		animation: d3-source-reveal 90ms ease-out both;
	}
	@keyframes d3-source-reveal {
		from { opacity: 0; transform: translateY(-1px); }
		to { opacity: 1; transform: translateY(0); }
	}
	:global(.d3-code-toggle),
	:global(.svg-source-toggle),
	:global(.md-table-source-toggle) {
		display: inline-flex;
		align-items: center;
		margin: 1px 0 2px;
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(12px * var(--font-scale, 1));
		line-height: 1.45;
		user-select: none;
	}
	:global(.d3-code-toggle-btn),
	:global(.svg-source-toggle-btn),
	:global(.md-table-source-toggle-btn) {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: transparent;
		text-underline-offset: 3px;
		transition: color 120ms ease, text-decoration-color 120ms ease;
	}
	:global(.d3-code-toggle-btn:hover),
	:global(.svg-source-toggle-btn:hover),
	:global(.md-table-source-toggle-btn:hover) {
		color: var(--text-muted);
		text-decoration-color: color-mix(in srgb, var(--text-muted) 45%, transparent);
	}
	:global(.md-table-widget) {
		display: block;
		max-width: min(100%, 980px);
		margin: 6px 0 14px;
		font-family: 'Inter', -apple-system, sans-serif;
		animation: media-fade-in 180ms ease-out both;
	}
	:global(.md-table-label) {
		margin-bottom: 5px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	:global(.md-table-scroll) {
		max-width: 100%;
		overflow-x: auto;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-elevated);
	}
	:global(.md-table-preview) {
		width: 100%;
		min-width: 520px;
		border-collapse: collapse;
		font-size: calc(13px * var(--font-scale, 1));
		line-height: 1.45;
		color: var(--text);
	}
	:global(.md-table-preview th),
	:global(.md-table-preview td) {
		padding: 8px 10px;
		border-bottom: 1px solid var(--border-light);
		border-right: 1px solid var(--border-light);
		vertical-align: top;
	}
	:global(.md-table-preview th:last-child),
	:global(.md-table-preview td:last-child) {
		border-right: 0;
	}
	:global(.md-table-preview tbody tr:last-child td) {
		border-bottom: 0;
	}
	:global(.md-table-preview th) {
		background: var(--bg-surface);
		font-weight: 650;
		color: var(--text-secondary);
	}
	:global(.md-table-preview code) {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 0.92em;
		background: var(--bg-surface);
		border-radius: 3px;
		padding: 1px 4px;
	}
	:global(.d3-widget) {
		display: block;
		margin: 6px 0 12px;
		user-select: none;
		max-width: 680px;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		overflow: hidden;
		animation: media-fade-in 240ms ease-out both;
	}
	:global(.d3-widget-toolbar) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 10px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border-light);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	:global(.d3-widget-label) {
		min-width: 0;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	:global(.d3-widget-iframe-wrap) {
		background: white;
	}
	:global(.d3-widget-iframe) {
		display: block;
	}
	/* Inline URL mark — classic web-link affordance: accent color + solid
	 * underline. Plain-text editor philosophy says don't mutate the
	 * source, but visually styling URLs as links is the universal cue
	 * that they're interactive. Hovering surfaces a floating og-card
	 * tooltip (`.media-link-tooltip` below) — the mark stays clickable
	 * looking even when you're not hovering. */
	.tiptap-editor :global(.media-link-inline) {
		color: var(--accent);
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.tiptap-editor :global(.media-link-inline:hover) {
		text-decoration-color: var(--accent);
	}
	/* Floating hover tooltip. Lives in document.body (outside the editor's
	 * scroll container) so position: fixed coordinates work without being
	 * clipped, and so it stacks above any other editor chrome. Uses the
	 * same `.media-card-widget` chrome the standalone-line cards use, so
	 * the visual language is consistent — just smaller and lifted. */
	:global(.media-link-tooltip) {
		position: fixed;
		z-index: 200;
		max-width: 360px;
		font-family: 'Inter', -apple-system, sans-serif;
		filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.16));
		animation: media-tooltip-in 160ms ease-out both;
	}
	:global(.media-link-tooltip .media-card-widget) {
		max-width: 360px;
		min-height: 0;
		padding: 10px;
		background: var(--bg-elevated);
	}
	:global(.media-link-tooltip .media-card-image) {
		flex: 0 0 64px;
		width: 64px;
		height: 64px;
	}
	:global(.media-link-tooltip .media-card-title) {
		font-size: 13px;
	}
	:global(.media-link-tooltip .media-card-desc) {
		font-size: 11.5px;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	:global(.media-link-tooltip .media-card-host) {
		font-size: 10px;
	}
	@keyframes media-tooltip-in {
		from { opacity: 0; transform: translateY(-3px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* ── Markdown visual rendering (decoration-only) ── */
	.tiptap-editor :global(.tiptap-plain p.md-heading) {
		font-family: 'Lora', 'Georgia', serif;
		color: var(--text);
	}
	.tiptap-editor :global(.tiptap-plain p.md-h1) {
		font-size: calc(26px * var(--font-scale, 1));
		font-weight: 700;
		line-height: 1.3;
	}
	.tiptap-editor :global(.tiptap-plain p.md-h2) {
		font-size: calc(22px * var(--font-scale, 1));
		font-weight: 600;
		line-height: 1.35;
	}
	.tiptap-editor :global(.tiptap-plain p.md-h3) {
		font-size: calc(19px * var(--font-scale, 1));
		font-weight: 600;
		line-height: 1.4;
	}
	.tiptap-editor :global(.tiptap-plain p.md-h4) {
		font-size: calc(17px * var(--font-scale, 1));
		font-weight: 600;
		line-height: 1.4;
	}
	.tiptap-editor :global(.tiptap-plain p.md-h5),
	.tiptap-editor :global(.tiptap-plain p.md-h6) {
		font-size: calc(15px * var(--font-scale, 1));
		font-weight: 600;
		line-height: 1.45;
	}
	.tiptap-editor :global(.md-syntax) {
		opacity: 0.3;
	}
	.tiptap-editor :global(.md-bold) {
		font-weight: 700;
	}
	.tiptap-editor :global(.md-italic) {
		font-style: italic;
	}
	.tiptap-editor :global(.md-code) {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.9em;
		background: var(--bg-surface);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-fence) {
		color: var(--text-faint);
		font-size: calc(12px * var(--font-scale, 1));
		line-height: 1.35;
		min-height: 1.35em;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-fence-open) {
		margin-top: 8px;
		padding: 0 10px;
		border: 1px solid var(--border-light);
		border-bottom: 0;
		border-radius: 6px 6px 0 0;
		background: color-mix(in srgb, var(--bg-surface) 70%, var(--bg-elevated));
		box-sizing: border-box;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-fence-close) {
		margin-bottom: 10px;
		padding: 0 10px;
		border: 1px solid var(--border-light);
		border-top: 0;
		border-radius: 0 0 6px 6px;
		background: color-mix(in srgb, var(--bg-surface) 70%, var(--bg-elevated));
		box-sizing: border-box;
	}
	.tiptap-editor :global(.md-code-fence-marker) {
		opacity: 0.35;
	}
	.tiptap-editor :global(.md-code-lang) {
		display: inline-flex;
		align-items: center;
		margin-left: 5px;
		padding: 0 6px;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-light));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));
		color: var(--accent);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 10px;
		font-weight: 650;
		line-height: 1.45;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-block-line) {
		margin: 0;
		padding: 0 12px;
		border-left: 1px solid var(--border-light);
		border-right: 1px solid var(--border-light);
		background: color-mix(in srgb, var(--text) 4%, var(--bg-elevated));
		color: var(--text);
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: calc(14px * var(--font-scale, 1));
		line-height: 1.5;
		min-height: 1.5em;
		box-sizing: border-box;
		tab-size: 2;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-block-line-first) {
		padding-top: 8px;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-block-line-last) {
		padding-bottom: 8px;
	}
	.tiptap-editor :global(.tiptap-plain p.md-code-block-line-single) {
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.tiptap-editor :global(.md-strikethrough) {
		text-decoration: line-through;
		opacity: 0.6;
	}
	.tiptap-editor :global(.md-link-text) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.tiptap-editor :global(.md-link-url) {
		opacity: 0.3;
		font-size: 0.9em;
	}
	.tiptap-editor :global(.tiptap-plain p.md-blockquote) {
		border-left: 3px solid var(--border-light);
		padding-left: 12px;
		color: var(--text-muted);
	}
	.tiptap-editor :global(.tiptap-plain p.md-list-item) {
		--md-list-offset: 2.6ch;
		padding-left: var(--md-list-offset);
		text-indent: calc(-1 * var(--md-list-offset));
	}
	.tiptap-editor :global(.tiptap-plain p.md-ol-item) {
		--md-list-offset: 3.6ch;
	}
	.tiptap-editor :global(.md-list-marker) {
		display: inline-block;
		color: var(--text-faint);
		font-weight: 600;
		opacity: 0.72;
	}
	.tiptap-editor :global(.md-bullet) {
		width: 1.7ch;
		margin-right: 0.55ch;
		text-align: right;
	}
	.tiptap-editor :global(.md-ordered-marker) {
		width: 3ch;
		margin-right: 0.45ch;
		text-align: right;
	}
	.tiptap-editor :global(.tiptap-plain p.md-hr) {
		border-bottom: 1px solid var(--border-light);
		line-height: 0.5;
		opacity: 0.5;
	}
</style>
