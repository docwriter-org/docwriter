/**
 * Custom MCP tools the agent uses in place of built-in `Edit` / `Read` /
 * `Write` for tab files. These tools route on path:
 *
 *   - **Scratch path** (`.docwriter/agent/scratch/...`) → plain filesystem
 *     I/O. Nothing the user sees; no Y.Doc involvement.
 *   - **Open tab** (workspace-relative id or absolute path to the real file)
 *     → Hocuspocus `openDirectConnection` + append a pending review round
 *     into the live Document's `review` map. The live document content does
 *     NOT change until the user accepts a round.
 *   - **Unknown path** → isError:true with a clear message. `write_doc`
 *     never creates new tabs.
 *
 * Agent edits are review proposals, not live-doc mutations. The proposal
 * round lands in the document's review map immediately; Accept later commits
 * the chosen `afterMd` into the live Y.Doc.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, relative } from 'path';
import * as Y from 'yjs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Document } from '@hocuspocus/server';

import { matchImportedComment, updateFeedbackDisposition, getFeedbackImport } from './feedback-import';
import {
	serializeYDoc,
	getReviewArray,
	readReviewRounds,
	getCommentsMap,
	getFragment,
	AGENT_ORIGIN,
	USER_ORIGIN,
	normalizeTypography,
	captureAnchorContext,
	nthIndexOf,
	buildThreadAnchor,
	applyEditToFragment,
	replaceYDocTextWithAiProvenance
} from '$lib/shared/ydoc-codec';
import {
	matchesStaleAcceptApply,
	type StaleAcceptApply
} from '$lib/shared/stale-accept';
import { touchLastSeen } from '$lib/server/last-seen';
import { isScratchPath, resolveTabFromPath, isOpenTab } from './path-router';
import { classifyRoundKind } from '$lib/review-diff';
import {
	materializePendingReviewText,
	reviewTextHash
} from '$lib/review-rounds';
import type {
	CommentMessage,
	CommentThread,
	PendingReviewOperation,
	PendingReviewRound
} from '$lib/types';
import { isValidTabId, tabFile, WORKSPACE_ROOT } from './document-files';
import { resolveWorkspacePath } from './workspace-path';
import { getRules, getTabsState, setTabsState } from './runtime-state';
import { writeTextAtomic } from './file-utils';
import { findOverlappingFreeze, freezeQuoteFromRule } from '$lib/freeze';

export function toolError(message: string): CallToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: message }]
	};
}

export function toolText(message: string): CallToolResult {
	return {
		content: [{ type: 'text', text: message }]
	};
}

export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count += 1;
		idx += needle.length;
	}
	return count;
}

/** Resolve the live Hocuspocus instance stashed on `globalThis` by
 * `ws-server.ts`. The stashed handle is a `Server` wrapper whose real
 * directory-of-documents lives at `.hocuspocus`; `openDirectConnection` is a
 * method on the inner `Hocuspocus`, not the `Server` wrapper. Returns null
 * if it isn't up (development-time misconfiguration, not a tool-call
 * runtime condition). */
export function getHocuspocus(): { openDirectConnection: (name: string) => Promise<{ transact: (cb: (doc: Document) => void | Promise<void>) => Promise<void>; disconnect: () => Promise<void> }> } | null {
	const holder = globalThis as unknown as { __docwriterWsServer?: unknown };
	const server = holder.__docwriterWsServer as
		| {
				hocuspocus?: {
					openDirectConnection: (name: string) => Promise<{
						transact: (cb: (doc: Document) => void | Promise<void>) => Promise<void>;
						disconnect: () => Promise<void>;
					}>;
				};
		  }
		| undefined;
	return server?.hocuspocus ?? null;
}

interface TabWriteResult {
	beforeMd: string;
	afterMd: string;
	/** True when the edit was tossed because its target thread was already
	 * resolved (no review round created). */
	discarded?: boolean;
	/** True when a stale Accept committed this write to the live document
	 * instead of leaving another pending review round. */
	committed?: boolean;
}

interface RoundMutation {
	operation: PendingReviewOperation;
	afterMd: string;
}

function narrowWriteOperation(
	beforeMd: string,
	afterMd: string
): PendingReviewOperation | null {
	let prefix = 0;
	while (
		prefix < beforeMd.length &&
		prefix < afterMd.length &&
		beforeMd[prefix] === afterMd[prefix]
	) {
		prefix += 1;
	}

	let beforeTail = beforeMd.length - 1;
	let afterTail = afterMd.length - 1;
	while (
		beforeTail >= prefix &&
		afterTail >= prefix &&
		beforeMd[beforeTail] === afterMd[afterTail]
	) {
		beforeTail -= 1;
		afterTail -= 1;
	}

	const oldString = beforeMd.slice(prefix, beforeTail + 1);
	const newString = afterMd.slice(prefix, afterTail + 1);
	if (!oldString) return null;
	if (countOccurrences(beforeMd, oldString) !== 1) return null;
	return {
		type: 'edit',
		oldString,
		newString
	};
}

export function currentProposalText(doc: Y.Doc): string {
	return materializePendingReviewText(serializeYDoc(doc), readReviewRounds(doc));
}

/** Run a write-transaction against the live Hocuspocus Document for `tabId`.
 * `mutator` receives the current proposal text (latest pending `afterMd`, or
 * the committed live doc if no proposal is pending) and returns the next
 * proposal string, or null to abort. */
/** Thread id the NEXT review round should attach to. Set transiently by
 * `edit_doc` for the duration of a single call when the agent passes an
 * explicit `thread_id` (and restored after), so attachment is per-edit and
 * intentional — NOT a render-wide default. Null means "no thread": the round
 * opens its own fresh thread (`createAgentEditThread`). This is what lets a
 * thread revision and an unrelated directive edit in the same turn land in
 * different threads. */
let activeFeedbackThreadId: string | null = null;
export function setActiveFeedbackThreadId(id: string | null) {
	activeFeedbackThreadId = id;
}

/** The enforcement promise interpolated into the system prompt's "Announce
 * edits on a thread" section. Defined here, beside the runTabWrite gate
 * that enforces it, so the prompt and the enforcement can't drift apart —
 * change the gate's behavior and this sentence in the same place. */
export const REPLY_BEFORE_EDIT_PROMPT_NOTE =
	"This is enforced: while a thread's latest message is the user's, edit_doc and write_doc targeting it fail until you have replied.";

/** Reviewer running the current critique pass, if any. Set by /api/render
 * for the duration of a critique render (same lifecycle as
 * `activeFeedbackThreadId`) and stamped onto every review round and
 * agent-authored comment the pass creates, so the gutter can attribute
 * them to the reviewer instead of the plain agent. */
let activeReviewerId: string | null = null;
export function setActiveReviewerId(id: string | null) {
	activeReviewerId = id;
}

/** Set for the duration of a stale-Accept render. While set, `edit_doc` /
 * `write_doc` on that tab commit the replacement immediately — the user
 * already clicked Accept; the agent is only finding the current old_string. */
let staleAcceptApply: StaleAcceptApply | null = null;
export function setStaleAcceptApply(value: StaleAcceptApply | null) {
	staleAcceptApply = value;
}
export function getStaleAcceptApply(): StaleAcceptApply | null {
	return staleAcceptApply;
}

function applyWriteToLiveFragment(doc: Y.Doc, operation: PendingReviewOperation): boolean {
	if (operation.type === 'write') {
		replaceYDocTextWithAiProvenance(doc, operation.content);
		return true;
	}
	return applyEditToFragment(
		getFragment(doc),
		operation.oldString,
		operation.newString,
		operation.replaceAll === true
	);
}

function dropMatchingReviewRounds(
	doc: Y.Doc,
	options?: { dropThreadId?: string; dropRoundId?: string }
): string[] {
	const reviewArr = getReviewArray(doc);
	const existing = reviewArr.toArray();
	const droppedThreadIds: string[] = [];
	for (let i = existing.length - 1; i >= 0; i--) {
		const round = existing[i];
		const drop =
			(options?.dropRoundId && round.id === options.dropRoundId) ||
			(options?.dropThreadId && round.feedbackThreadId === options.dropThreadId);
		if (!drop) continue;
		if (round.feedbackThreadId) droppedThreadIds.push(round.feedbackThreadId);
		reviewArr.delete(i, 1);
	}
	return droppedThreadIds;
}

function resolveEmptyEditThreads(ydoc: Y.Doc, threadIds: Iterable<string>): void {
	const ids = new Set([...threadIds].filter((id): id is string => !!id));
	if (ids.size === 0) return;
	const commentsMap = getCommentsMap(ydoc);
	const stillReferenced = new Set(
		getReviewArray(ydoc)
			.toArray()
			.map((r) => r.feedbackThreadId)
			.filter((id): id is string => typeof id === 'string')
	);
	for (const tid of ids) {
		const thread = commentsMap.get(tid);
		if (!thread || thread.resolved) continue;
		if (stillReferenced.has(tid)) continue;
		if (thread.messages.some((m) => m.author === 'user')) continue;
		commentsMap.set(tid, { ...thread, resolved: true });
	}
}

/** Apply an agent write to the live fragment and drop the stale/superseded
 * pending rounds. Used when the user already Accepted an orphaned proposal.
 * Caller is responsible for origin: this wraps a USER_ORIGIN transact so
 * the apply is undoable like a normal Accept. */
export function commitWriteToLiveDoc(
	doc: Y.Doc,
	operation: PendingReviewOperation,
	options?: { dropThreadId?: string; dropRoundId?: string }
): { ok: true } | { ok: false; error: string } {
	let applied = false;
	doc.transact(() => {
		applied = applyWriteToLiveFragment(doc, operation);
		if (!applied) return;
		const dropped = dropMatchingReviewRounds(doc, options);
		resolveEmptyEditThreads(doc, [...dropped, options?.dropThreadId ?? '']);
	}, USER_ORIGIN);
	return applied
		? { ok: true }
		: { ok: false, error: 'Could not apply the rebased edit to the live document.' };
}

export async function runTabWrite(
	tabId: string,
	trigger: PendingReviewRound['trigger'],
	mutator: (currentText: string) => RoundMutation | null
): Promise<TabWriteResult | { error: string }> {
	const ws = getHocuspocus();
	if (!ws) {
		return { error: 'WebSocket server not initialized — Y.Doc sync is offline.' };
	}
	const direct = await ws.openDirectConnection(tabId);
	let result: TabWriteResult | { error: string } | null = null;
	try {
		await direct.transact((document) => {
			const doc = document as unknown as Y.Doc;
			const beforeMd = currentProposalText(doc);
			const mutation = mutator(beforeMd);
			if (mutation === null) {
				result = { error: 'mutator-aborted' };
				return;
			}
			const { operation, afterMd } = mutation;
			if (afterMd === beforeMd) {
				// No-op write. Still succeeds, but don't emit a review round.
				result = { beforeMd, afterMd };
				return;
			}
			// Edits targeting a feedback thread pass two gates. (1) The user
			// already RESOLVED it (e.g. while the agent was still thinking):
			// they are done with it — toss the edit instead of reviving the
			// thread with a new proposal. (2) The prompt's "Announce edits on
			// a thread" contract: if the thread's latest message is the
			// user's, the agent hasn't said anything about this proposal yet,
			// and letting it land would show a bare diff with no explanation.
			// Bounce the write with instructions; the agent replies on the
			// thread and retries. The error string is the whole contract
			// because every provider path (MCP tools and tool-handlers.ts)
			// surfaces it verbatim — which is also why it names no parameter
			// syntax: the surfaces' reply_to_comment schemas differ.
			const targetThreadId = activeFeedbackThreadId ?? undefined;
			if (targetThreadId) {
				const thread = getCommentsMap(doc).get(targetThreadId);
				if (thread?.resolved) {
					result = { beforeMd, afterMd: beforeMd, discarded: true };
					return;
				}
				const lastMessage = thread?.messages[thread.messages.length - 1];
				if (lastMessage?.author === 'user') {
					result = {
						error:
							`the user's latest message on thread "${targetThreadId}" has no reply yet, ` +
							`so this proposal would land as a bare diff with no explanation. First reply ` +
							`on that thread with reply_to_comment — one or two first-person sentences on ` +
							`what you make of the user's feedback and what you are changing — then retry ` +
							`this exact call.`
					};
					return;
				}
			}
			const reviewArr = getReviewArray(doc);
			const threadIdExplicit = activeFeedbackThreadId ?? undefined;
			// Default op: an explicit edit as given, or a narrowed wholesale
			// write. `baseForRound` is the text this op is anchored to.
			let baseForRound = beforeMd;
			let normalizedOperation =
				operation.type === 'write'
					? (narrowWriteOperation(beforeMd, afterMd) ?? operation)
					: operation;

			// ── Revise-in-place re-base ──────────────────────────────────
			// When this edit attaches to a thread that ALREADY has pending
			// rounds, the agent produced `afterMd` on top of those rounds'
			// text (the proposal it was revising — that's what `read_doc`
			// and the prompt show). We're about to SUPERSEDE those rounds,
			// so the agent's `old_string` would no longer match the
			// committed document: the round would show in the thread card
			// but fail to render in the doc (stale). Re-derive the operation
			// against the document WITHOUT this thread's pending rounds, so
			// it anchors to text that still exists once the old proposal is
			// withdrawn. `afterMd` is the agent's intended final text, so a
			// diff from that clean base reconstructs a valid op.
			const existingRounds = reviewArr.toArray();
			const supersedes = threadIdExplicit
				? existingRounds.filter((r) => r.feedbackThreadId === threadIdExplicit)
				: [];
			if (supersedes.length > 0) {
				baseForRound = materializePendingReviewText(
					serializeYDoc(doc),
					existingRounds.filter((r) => r.feedbackThreadId !== threadIdExplicit)
				);
				if (afterMd !== baseForRound) {
					normalizedOperation =
						narrowWriteOperation(baseForRound, afterMd) ??
						({ type: 'write', content: afterMd } as const);
				}
			}

			// Stale Accept: the user already clicked Accept. Apply the
			// rebased op to the live fragment in a USER_ORIGIN transact —
			// do not leave a new review card for a second Accept.
			if (matchesStaleAcceptApply(staleAcceptApply, tabId)) {
				const committed = commitWriteToLiveDoc(doc, normalizedOperation, {
					dropThreadId: threadIdExplicit ?? staleAcceptApply?.threadId,
					dropRoundId: staleAcceptApply?.staleRoundId
				});
				if (committed.ok) {
					touchLastSeen(tabId, doc);
					result = { beforeMd, afterMd, committed: true };
					return;
				}
				// Could not apply to the live fragment (e.g. the agent's
				// old_string only exists in a stacked proposal view). Fall
				// through and leave a pending round so the client can still
				// Accept the rebased edit.
			}

			doc.transact(() => {
				// No explicit thread → open one so EVERY edit lives under a
				// thread (the thread is the parent; there are no standalone edit
				// cards). Anchor an edit to its replaced passage; anchor a
				// wholesale write to the first non-empty line it replaces.
				let threadId = threadIdExplicit;
				if (!threadId) {
					// Anchor to a SINGLE line (the first changed/non-empty line),
					// never the whole multi-line old_string: a multi-line quote
					// doesn't match the editor's plain text verbatim, so the
					// thread card can't be positioned and silently disappears.
					const fullOldStr = normalizedOperation.type === 'edit'
						? normalizedOperation.oldString
						: baseForRound;
					const anchorQuote = firstNonEmptyLine(fullOldStr);
					if (anchorQuote) {
						const occIdx = computeAnchorOccurrenceIndex(
							baseForRound, anchorQuote, fullOldStr
						);
						threadId = createAgentEditThread(doc, anchorQuote, occIdx, baseForRound);
					}
				}

				const round: PendingReviewRound = {
					id: cryptoRandomId(),
					operation: normalizedOperation,
					baseHash:
						normalizedOperation.type === 'write'
							? reviewTextHash(baseForRound)
							: undefined,
					trigger,
					feedbackThreadId: threadId,
					timestamp: Date.now(),
					kind: classifyRoundKind(baseForRound, afterMd),
					stepCount: 1,
					...(activeReviewerId ? { reviewerId: activeReviewerId } : {})
				};
				// Revise-in-place: a new edit made for a feedback thread replaces
				// any older still-pending edits for that same thread, so the
				// thread shows one current proposal (and the doc only the latest)
				// instead of stacking versions.
				if (round.feedbackThreadId) {
					const existing = reviewArr.toArray();
					for (let i = existing.length - 1; i >= 0; i--) {
						if (existing[i].feedbackThreadId === round.feedbackThreadId) {
							reviewArr.delete(i, 1);
						}
					}
				}
				reviewArr.push([round]);
			}, AGENT_ORIGIN);
			result = { beforeMd, afterMd };
		});
	} finally {
		await direct.disconnect();
	}
	return result ?? { error: 'DirectConnection.transact returned with no result' };
}

export function cryptoRandomId(): string {
	// Node 22+ has globalThis.crypto per Web Crypto API.
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return 'round-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Open a comment thread anchored to the passage an agent edit replaces and
 * return its id, so a spontaneous edit renders as a thread card (with a
 * conversation + Resolve) instead of a bare standalone edit card. The anchor
 * quote is the edit's `oldString`, which `edit_doc` already guaranteed
 * matches the live text exactly once, so the gutter can position the card and
 * the client backfills CRDT rel-positions on first render. The single agent
 * seed message means the thread has no user message yet — so when the edit is
 * accepted/rejected with no reply, the server auto-resolves it
 * (`resolveEmptyEditThreads`). Caller runs inside the AGENT_ORIGIN transact;
 * the comments map isn't tracked by the UndoManager, so this isn't undone. */
/** First non-empty line of a document — used to anchor a wholesale `write`
 * round's thread to real text that exists in the doc. */
function firstNonEmptyLine(text: string): string {
	for (const line of (text ?? '').split('\n')) {
		if (line.trim()) return line;
	}
	return '';
}

function computeAnchorOccurrenceIndex(
	docText: string,
	anchorQuote: string,
	fullOldString: string
): number {
	const editPos = docText.indexOf(fullOldString);
	if (editPos < 0) return 0;
	const offsetInOld = fullOldString.indexOf(anchorQuote);
	if (offsetInOld < 0) return 0;
	const anchorAbsPos = editPos + offsetInOld;
	let count = 0;
	let searchFrom = 0;
	while (true) {
		const found = docText.indexOf(anchorQuote, searchFrom);
		if (found < 0 || found >= anchorAbsPos) return count;
		count++;
		searchFrom = found + anchorQuote.length;
	}
}

function createAgentEditThread(
	doc: Y.Doc,
	oldString: string,
	occurrenceIndex: number,
	docText: string
): string {
	const threadId = 'thread_' + cryptoRandomId();
	const now = Date.now();
	const anchorIdx = nthIndexOf(docText, oldString, occurrenceIndex);
	const thread: CommentThread = {
		id: threadId,
		anchor: {
			quote: oldString,
			occurrenceIndex,
			// Snapshot the surroundings so the client's quote fallback can
			// tell "this text came back" (undo) apart from "the same string
			// was typed somewhere else" once the passage is deleted.
			...(anchorIdx >= 0 ? captureAnchorContext(docText, anchorIdx, oldString.length) : {})
		},
		messages: [
			{
				id: 'msg_' + cryptoRandomId(),
				author: 'agent',
				text: 'Suggested an edit.',
				timestamp: now,
				...(activeReviewerId ? { reviewerId: activeReviewerId } : {})
			}
		],
		resolved: false,
		createdAt: now
	};
	getCommentsMap(doc).set(threadId, thread);
	return threadId;
}

// ---- Auto-open-as-tab -----------------------------------------------------

/** Convert a user-supplied `path` (absolute or relative) into a workspace-
 * relative tabId, validating it and ensuring it doesn't escape the workspace
 * root. Returns null if the path can't be made into a valid tabId. */
export function pathToTabId(path: string): string | null {
	let candidate: string;
	if (isAbsolute(path)) {
		const rel = relative(WORKSPACE_ROOT, path);
		if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
		candidate = rel;
	} else {
		candidate = path;
	}
	if (!isValidTabId(candidate)) return null;
	return candidate;
}

type EnsureTabResult =
	| { ok: true; tabId: string; existedOnDisk: boolean }
	| { ok: false; error: CallToolResult };

/** Resolve `path` to a tab and ensure it's open. Three outcomes:
 *
 *  - Already an open tab → return it.
 *  - Not open, valid workspace path → open as a new tab. If the file
 *    doesn't exist and `createIfMissing` is true, create an empty file
 *    first. If `createIfMissing` is false and the file is absent, return
 *    an error.
 *  - Invalid path / escapes sandbox / unsupported shape → error.
 */
export function ensureWorkspaceTabOpen(
	path: string,
	opts: { createIfMissing: boolean }
): EnsureTabResult {
	const existingTabId = resolveTabFromPath(path);
	if (existingTabId && isOpenTab(existingTabId)) {
		return {
			ok: true,
			tabId: existingTabId,
			existedOnDisk: existsSync(tabFile(existingTabId))
		};
	}

	const tabId = pathToTabId(path);
	if (!tabId) {
		return {
			ok: false,
			error: toolError(
				`${path} is not a valid workspace-relative path. Use a path inside the workspace (e.g. "drafts/chapter-1.md") or under .docwriter/agent/scratch/.`
			)
		};
	}

	let absPath: string;
	try {
		absPath = resolveWorkspacePath(tabId);
	} catch (err) {
		return {
			ok: false,
			error: toolError(`${path} cannot be opened: ${(err as Error).message}`)
		};
	}

	const fileExists = existsSync(absPath);
	if (!fileExists && !opts.createIfMissing) {
		return {
			ok: false,
			error: toolError(
				`${path} does not exist. Use write_doc to create new files, or pick an existing file.`
			)
		};
	}
	if (!fileExists) {
		try {
			mkdirSync(dirname(absPath), { recursive: true });
			writeTextAtomic(absPath, '');
		} catch (err) {
			return {
				ok: false,
				error: toolError(`Failed to create ${path}: ${(err as Error).message}`)
			};
		}
	}

	const state = getTabsState();
	if (!state.order.includes(tabId)) {
		state.order.push(tabId);
		// Deliberately do NOT set `state.active = tabId`. The user may be
		// mid-sentence on another tab; silently yanking focus to a tab the
		// agent just created is disorienting. The new tab shows up in the
		// bar with a pulsing dot (driven by `freshAgentTabs` on the client)
		// and the user opens it when they're ready.
		setTabsState(state);
	}

	return { ok: true, tabId, existedOnDisk: fileExists };
}

// ---- Scratch-path helpers -------------------------------------------------

export function readScratch(path: string): CallToolResult {
	try {
		const content = readFileSync(path, 'utf8');
		return { content: [{ type: 'text', text: content }] };
	} catch (err) {
		return toolError(`Failed to read ${path}: ${(err as Error).message}`);
	}
}

export function writeScratch(path: string, content: string): CallToolResult {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf8');
		return toolText(`Wrote ${content.length} chars to ${path}.`);
	} catch (err) {
		return toolError(`Failed to write ${path}: ${(err as Error).message}`);
	}
}

export function editScratch(
	path: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): CallToolResult {
	if (!existsSync(path)) return toolError(`File not found: ${path}.`);
	let current: string;
	try {
		current = readFileSync(path, 'utf8');
	} catch (err) {
		return toolError(`Failed to read ${path}: ${(err as Error).message}`);
	}
	const hits = countOccurrences(current, oldString);
	if (hits === 0) {
		return toolError(
			`old_string not found in ${path}. The file may have been edited since your last read — re-read it and retry.`
		);
	}
	if (hits > 1 && !replaceAll) {
		return toolError(
			`old_string matches ${hits} locations in ${path}. Make it more specific (add surrounding context), or pass replace_all: true to replace every occurrence.`
		);
	}
	const next = replaceAll
		? current.split(oldString).join(newString)
		: current.replace(oldString, newString);
	try {
		writeFileSync(path, next, 'utf8');
	} catch (err) {
		return toolError(`Failed to write ${path}: ${(err as Error).message}`);
	}
	return toolText(
		replaceAll
			? `Edit applied to ${path} (replaced ${hits} occurrence${hits === 1 ? '' : 's'}).`
			: `Edit applied to ${path}.`
	);
}

// ---- Tool definitions -----------------------------------------------------

const editDocTool = tool(
	'edit_doc',
	'Replace old_string with new_string in the given file. For a workspace file this creates or updates a pending review proposal. The document changes only when the user accepts it. For a path under .docwriter/agent/scratch/ it writes plain text. old_string must match exactly once. Pass replace_all: true to replace every occurrence in one proposal, which suits renames and consistent term changes.',
	{
		file_path: z
			.string()
			.describe(
				'Either the workspace-relative tab id (e.g. "drafts/chapter-1.md"), the absolute path to the tab file, or an absolute path inside .docwriter/agent/scratch/.'
			),
		old_string: z
			.string()
			.describe(
				'Exact substring to replace. Must appear exactly once unless replace_all is true.'
			),
		new_string: z.string().describe('The replacement string. Can be empty to delete.'),
		replace_all: z
			.boolean()
			.optional()
			.describe(
				'When true, replace every occurrence of old_string in a single proposal (useful for renames or consistent term updates). Default false.'
			),
		thread_id: z
			.string()
			.optional()
			.describe(
				'Pass the thread id when you are revising the edit that thread is about. The proposal lands in that thread\'s card and supersedes its pending edit. Omit it for a fresh edit. The system opens a thread automatically.'
			)
	},
	async ({ file_path, old_string, new_string, replace_all, thread_id }) => {
		const replaceAll = replace_all === true;
		old_string = normalizeTypography(old_string);
		new_string = normalizeTypography(new_string);
		if (isScratchPath(file_path)) return editScratch(file_path, old_string, new_string, replaceAll);

		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: false });
		if (!opened.ok) return opened.error;
		const tabId = opened.tabId;

		// Soft freeze gate: rules prefixed with "Freeze: " name passages the
		// agent must not edit. Reject before opening a review round so the
		// agent can apologize / work around instead of proposing a no-op.
		{
			const hit = findOverlappingFreeze([old_string, new_string], getRules());
			if (hit) {
				const quote = freezeQuoteFromRule(hit);
				const preview = quote.length > 80 ? quote.slice(0, 77) + '…' : quote;
				return toolError(
					`Frozen: overlapping "${preview}" — leave this passage unchanged.`
				);
			}
		}

		// An explicit thread_id on the call wins over the render-level default
		// (parsed from the triggering message). Restore the prior value after
		// so a single edit's targeting can't leak into later edits this turn.
		const priorThreadId = activeFeedbackThreadId;
		if (typeof thread_id === 'string' && thread_id) {
			setActiveFeedbackThreadId(thread_id);
		}
		let failure: string | null = null;
		let appliedHits = 0;
		const result = await runTabWrite(tabId, 'agent_edit_doc', (currentMd) => {
			const hits = countOccurrences(currentMd, old_string);
			if (hits === 0) {
				failure = `old_string not found in ${file_path}. The user may have edited this area — read_doc to see the current state and retry.`;
				return null;
			}
			if (hits > 1 && !replaceAll) {
				failure = `old_string matches ${hits} locations in ${file_path}. Make it more specific (add surrounding context), or pass replace_all: true to replace every occurrence.`;
				return null;
			}
			appliedHits = hits;
			// Use a function replacement so JavaScript does NOT interpret `$`
			// patterns in new_string ($&, $`, $', $n). Without this, an
			// edit_doc whose new_string contains a literal $' (very common in
			// LaTeX math like x'$ or derivatives) substitutes the entire
			// post-match text of the doc in place of $', silently duplicating
			// large chunks. split/join (replaceAll path) is already safe — it
			// doesn't go through the regex replacement engine.
			const afterMd = replaceAll
				? currentMd.split(old_string).join(new_string)
				: currentMd.replace(old_string, () => new_string);
			return {
				operation: {
					type: 'edit',
					oldString: old_string,
					newString: new_string,
					...(replaceAll ? { replaceAll: true } : {})
				},
				afterMd
			};
		});
		// Restore the render-level default so this edit's explicit targeting
		// doesn't leak into later edit_doc calls in the same turn.
		if (typeof thread_id === 'string' && thread_id) {
			setActiveFeedbackThreadId(priorThreadId);
		}
		if (failure) return toolError(failure);
		if ('error' in result) {
			if (result.error === 'mutator-aborted') {
				// A mutator-level abort that didn't set `failure` is a bug; surface it.
				return toolError(`edit_doc aborted without a reason for ${file_path}.`);
			}
			return toolError(`edit_doc failed for ${file_path}: ${result.error}`);
		}
		if (result.discarded) {
			return toolText(
				`Edit discarded for ${file_path}: the user resolved this feedback thread before the edit landed, so it was not applied. Do not retry.`
			);
		}

		if (typeof thread_id === 'string' && thread_id) {
			const imp = getFeedbackImport();
			if (imp) {
				for (const c of imp.comments) {
					if (imp.commentToThread[c.id] === thread_id) {
						updateFeedbackDisposition(c.id, thread_id, 'applied');
						break;
					}
				}
			}
		}

		return toolText(
			result.committed
				? replaceAll
					? `Edit applied and accepted on ${file_path} (replaced ${appliedHits} occurrence${appliedHits === 1 ? '' : 's'}). The user already clicked Accept — do not leave another proposal.`
					: `Edit applied and accepted on ${file_path}. The user already clicked Accept — do not leave another proposal.`
				: replaceAll
					? `Edit applied to ${file_path} (replaced ${appliedHits} occurrence${appliedHits === 1 ? '' : 's'}).`
					: `Edit applied to ${file_path}.`
		);
	}
);

const readDocTool = tool(
	'read_doc',
	'Read the current content of a workspace file or scratch file. For an open tab it returns the review-aware content: the newest pending proposal if one exists, otherwise the committed document.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative tab id, absolute path to an open tab file, or absolute path inside .docwriter/agent/scratch/.'
			)
	},
	async ({ file_path }) => {
		if (isScratchPath(file_path)) return readScratch(file_path);

		// Open tab → return review-aware live content (newest pending proposal
		// if any, else the committed Y.Doc text). This is the path that lets
		// the agent see its own queued edits before they land.
		const tabId = resolveTabFromPath(file_path);
		if (tabId && isOpenTab(tabId)) {
			const ws = getHocuspocus();
			if (!ws) {
				return toolError('WebSocket server not initialized — Y.Doc sync is offline.');
			}
			const direct = await ws.openDirectConnection(tabId);
			try {
				let content = '';
				await direct.transact((document) => {
					content = currentProposalText(document as unknown as Y.Doc);
				});
				return { content: [{ type: 'text', text: content }] };
			} catch (err) {
				return toolError(`Failed to read ${file_path}: ${(err as Error).message}`);
			} finally {
				await direct.disconnect();
			}
		}

		// Workspace file that isn't an open tab → just read it from disk.
		// The system prompt tells the agent to use read_doc for any workspace
		// file regardless of tab state; bouncing it back here would force a
		// pointless fallback to the built-in Read tool. Reading is non-
		// mutating, so we don't open a tab on the user's behalf — that's an
		// edit_doc / write_doc side effect, not a read one.
		const candidateTabId = tabId ?? pathToTabId(file_path);
		if (candidateTabId) {
			let absPath: string;
			try {
				absPath = resolveWorkspacePath(candidateTabId);
			} catch (err) {
				return toolError(`${file_path} cannot be read: ${(err as Error).message}`);
			}
			if (!existsSync(absPath)) {
				return toolError(
					`${file_path} does not exist in the workspace. Use Glob to find files or write_doc to create one.`
				);
			}
			try {
				const content = readFileSync(absPath, 'utf8');
				return { content: [{ type: 'text', text: content }] };
			} catch (err) {
				return toolError(`Failed to read ${file_path}: ${(err as Error).message}`);
			}
		}

		return toolError(
			`${file_path} is not a valid workspace path or scratch path. Workspace paths look like "drafts/chapter-1.md"; scratch paths live under .docwriter/agent/scratch/.`
		);
	}
);

const writeDocTool = tool(
	'write_doc',
	'Replace the full content of a workspace or scratch file. If the file exists, the write lands as a pending review proposal. If it does not exist, write_doc creates it and opens it as a new tab with no proposal. Scratch paths are written directly.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-2.md"), an absolute path inside the workspace, or an absolute path under .docwriter/agent/scratch/. If the file does not exist, write_doc creates it and opens it as a new tab.'
			),
		content: z.string().describe('The new full content of the file.')
	},
	async ({ file_path, content }) => {
		if (isScratchPath(file_path)) return writeScratch(file_path, content);

		content = normalizeTypography(content);

		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: true });
		if (!opened.ok) return opened.error;

		// Route every write — including brand-new files — through the review
		// flow so the user sees a pending proposal they can accept or reject.
		// For a new file the baseline is empty and `afterMd` is the full content,
		// which renders as an "everything added" diff.
		const result = await runTabWrite(opened.tabId, 'agent_write_doc', () => ({
			operation: { type: 'write', content },
			afterMd: content
		}));
		if ('error' in result) {
			return toolError(`write_doc failed for ${file_path}: ${result.error}`);
		}
		const verb = opened.existedOnDisk ? 'Wrote' : 'Created';
		return toolText(
			result.committed
				? `${verb} and accepted ${content.length} chars on ${file_path}. The user already clicked Accept — do not leave another proposal.`
				: `${verb} ${content.length} chars to ${file_path}.`
		);
	}
);

// ---- reply_to_comment ---------------------------------------------------

/** Write a comment thread (new or reply) onto a tab's Y.Map('comments').
 * Runs inside a DirectConnection transaction so the update streams to all
 * connected browsers via Hocuspocus and persists through `yjs_updates`. */
export async function runCommentWrite(
	tabId: string,
	mutator: (doc: Y.Doc) => { ok: true } | { ok: false; error: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
	const ws = getHocuspocus();
	if (!ws) return { ok: false, error: 'WebSocket server not initialized — Y.Doc sync is offline.' };
	const direct = await ws.openDirectConnection(tabId);
	let result: { ok: true } | { ok: false; error: string } = {
		ok: false,
		error: 'DirectConnection.transact returned with no result'
	};
	try {
		await direct.transact((document) => {
			const doc = document as unknown as Y.Doc;
			const outcome = mutator(doc);
			result = outcome;
		});
	} finally {
		await direct.disconnect();
	}
	return result;
}

/** Create a new agent-authored comment thread on a tab's comments map.
 * Mirrors the thread shape used by `reply_to_comment`; writes under
 * AGENT_ORIGIN so the update is classified as an agent change (never on the
 * user's undo stack). Runs inside the caller's `runCommentWrite` transaction. */
function createAgentCommentThread(
	doc: Y.Doc,
	anchorText: string,
	occurrenceIndex: number,
	message: string,
	proposedEdit?: { old_string: string; new_string: string },
	externalAuthor?: string
): string {
	const threadId = 'thread_' + cryptoRandomId();
	const now = Date.now();
	const liveText = serializeYDoc(doc);
	const anchorIdx = nthIndexOf(liveText, anchorText, occurrenceIndex);
	const isExternal = !!externalAuthor;
	const thread: CommentThread = {
		id: threadId,
		anchor: {
			quote: anchorText,
			occurrenceIndex,
			...(anchorIdx >= 0 ? captureAnchorContext(liveText, anchorIdx, anchorText.length) : {})
		},
		messages: [
			{
				id: 'msg_' + cryptoRandomId(),
				author: isExternal ? 'external' : 'agent',
				text: message,
				timestamp: now,
				...(isExternal ? { externalAuthor } : {}),
				...(activeReviewerId ? { reviewerId: activeReviewerId } : {}),
				...(proposedEdit
					? {
							proposedEdit: {
								oldString: proposedEdit.old_string,
								newString: proposedEdit.new_string
							}
						}
					: {})
			}
		],
		resolved: false,
		createdAt: now
	};
	doc.transact(() => getCommentsMap(doc).set(threadId, thread), AGENT_ORIGIN);

	if (isExternal) {
		const commentId = matchImportedComment(externalAuthor, message);
		if (commentId) {
			updateFeedbackDisposition(commentId, threadId, 'discussed');
		}
	}

	return threadId;
}

/** Reply on an existing thread, optionally moving its anchor onto a new
 * passage (`anchorText`). Used by both the Claude MCP tool and the
 * provider-agnostic tool-handlers path. Caller runs inside `runCommentWrite`. */
export function applyReplyToComment(
	doc: Y.Doc,
	threadId: string,
	filePath: string,
	message: string,
	options?: {
		proposedEdit?: { old_string: string; new_string: string };
		anchorText?: string;
		occurrenceIndex?: number;
	}
): { ok: true; reanchored: boolean } | { ok: false; error: string } {
	const commentsMap = getCommentsMap(doc);
	const existing = commentsMap.get(threadId);
	if (!existing) {
		return { ok: false, error: `Thread "${threadId}" does not exist on ${filePath}.` };
	}

	let nextAnchor = existing.anchor;
	let reanchored = false;
	const anchorText = options?.anchorText?.trim();
	if (anchorText) {
		const liveText = serializeYDoc(doc);
		const hits = countOccurrences(liveText, anchorText);
		if (hits === 0) {
			return {
				ok: false,
				error: `anchor_text was not found in ${filePath}. Call read_doc and retry with exact current text.`
			};
		}
		if (hits > 1 && options?.occurrenceIndex === undefined) {
			return {
				ok: false,
				error: `anchor_text matches ${hits} locations in ${filePath}. Pass occurrence_index to choose one.`
			};
		}
		const occurrence = options?.occurrenceIndex ?? 0;
		if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= hits) {
			return {
				ok: false,
				error: `occurrence_index ${occurrence} is out of range; anchor_text appears ${hits} time${hits === 1 ? '' : 's'}.`
			};
		}
		const built = buildThreadAnchor(liveText, anchorText, occurrence);
		if (!built) {
			return { ok: false, error: `anchor_text was not found in ${filePath}.` };
		}
		nextAnchor = built;
		reanchored = true;
	}

	const now = Date.now();
	const newMessage: CommentMessage = {
		id: 'msg_' + cryptoRandomId(),
		author: 'agent',
		text: message,
		timestamp: now,
		...(activeReviewerId ? { reviewerId: activeReviewerId } : {}),
		...(options?.proposedEdit
			? {
					proposedEdit: {
						oldString: options.proposedEdit.old_string,
						newString: options.proposedEdit.new_string
					}
				}
			: {})
	};
	const updated: CommentThread = {
		...existing,
		anchor: nextAnchor,
		// Re-opening via a new reply un-resolves the thread so the user
		// sees the new message (and a re-attached orphan).
		resolved: false,
		messages: [...existing.messages, newMessage]
	};
	doc.transact(() => commentsMap.set(threadId, updated), AGENT_ORIGIN);
	return { ok: true, reanchored };
}

const commentDocTool = tool(
	'comment_doc',
	'Create a new comment thread anchored to existing text in a workspace document. Use it, at any autonomy level, as the announce thread before an edit proposal (see "Announce edits on a thread" in your instructions). Unprompted observation comments are allowed only at Medium or High autonomy, or when the user asks for a comment; at Low autonomy you may otherwise only reply on threads the user opened. The comment appears in the document gutter and does not change document text.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-1.md") or absolute path inside the workspace. Must be an existing file.'
			),
		anchor_text: z
			.string()
			.describe(
				'Exact text in the current document to anchor the comment to. Prefer a short unique passage, usually one sentence or clause.'
			),
		message: z.string().describe('The comment text. Say the useful point directly. Keep it short.'),
		occurrence_index: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				'Zero-based occurrence to anchor when anchor_text appears more than once. Omit only when anchor_text is unique.'
			),
		proposed_edit: z
			.object({
				old_string: z.string(),
				new_string: z.string()
			})
			.optional()
			.describe(
				'Optional concrete edit the user can approve from the comment. Do not use this at Medium autonomy unless the user directly asked for an edit.'
			),
		external_author: z
			.string()
			.optional()
			.describe(
				'Name of an external commenter when importing feedback from outside the system. When set, the comment is attributed to that person rather than the agent.'
			)
	},
	async ({ file_path, anchor_text, message, occurrence_index, proposed_edit, external_author }) => {
		if (isScratchPath(file_path)) {
			return toolError('comment_doc cannot be used on scratch paths — only on workspace files.');
		}
		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: false });
		if (!opened.ok) return opened.error;

		const anchorText = anchor_text.trim();
		const trimmedMessage = message.trim();
		if (!anchorText) return toolError('comment_doc requires non-empty anchor_text.');
		if (!trimmedMessage) return toolError('comment_doc requires a non-empty message.');

		let threadId = '';
		const outcome = await runCommentWrite(opened.tabId, (doc) => {
			const liveText = serializeYDoc(doc);
			const hits = countOccurrences(liveText, anchorText);
			if (hits === 0) {
				return {
					ok: false,
					error: `anchor_text was not found in ${file_path}. Call read_doc and retry with exact current text.`
				};
			}
			if (hits > 1 && occurrence_index === undefined) {
				return {
					ok: false,
					error: `anchor_text matches ${hits} locations in ${file_path}. Pass occurrence_index to choose one.`
				};
			}
			const occurrence = occurrence_index ?? 0;
			if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= hits) {
				return {
					ok: false,
					error: `occurrence_index ${occurrence} is out of range; anchor_text appears ${hits} time${hits === 1 ? '' : 's'}.`
				};
			}
			threadId = createAgentCommentThread(doc, anchorText, occurrence, trimmedMessage, proposed_edit, external_author);
			return { ok: true };
		});

		if (!outcome.ok) return toolError(outcome.error);
		return toolText(`Commented on ${file_path} in thread ${threadId}.`);
	}
);

const replyToCommentTool = tool(
	'reply_to_comment',
	'Reply on an existing comment thread. Route per the "Where a response goes" rules in your instructions. Write in the first person and keep it to a few sentences. Pass optional anchor_text to move the thread onto a new passage (re-attach after the original text was replaced by another accepted edit). You may attach proposed_edit for the user to approve later. To start a new thread, use comment_doc.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-1.md") or absolute path inside the workspace. Must be an existing file — comments can only be attached to a tab the user can open.'
			),
		thread_id: z
			.string()
			.describe(
				'Id of the existing thread to reply on (from the "Open comment threads" prompt block). Required: agents cannot open new threads.'
			),
		message: z
			.string()
			.describe(
				'Your reply. Speak in first person ("I\'d cut …", "I think …"), not as a narrator. Keep it shorter than an essay — a few sentences.'
			),
		anchor_text: z
			.string()
			.optional()
			.describe(
				'Exact current document text to move this thread onto. Use when the original anchor was deleted (e.g. the user accepted a neighboring proposal) and you need to re-attach the conversation to the corresponding current passage. Prefer a short unique sentence or clause.'
			),
		occurrence_index: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				'Zero-based occurrence to anchor when anchor_text appears more than once. Required only when anchor_text is not unique.'
			),
		proposed_edit: z
			.object({
				old_string: z.string(),
				new_string: z.string()
			})
			.optional()
			.describe(
				'Optional concrete edit you would propose if the user approves. `old_string` must match once in the current live markdown at the time of writing. The edit is NOT applied until the user clicks "Approve & propose edit" on your comment.'
			)
	},
	async ({ file_path, thread_id, message, proposed_edit, anchor_text, occurrence_index }) => {
		if (isScratchPath(file_path)) {
			return toolError(
				'reply_to_comment cannot be used on scratch paths — only on workspace tab files.'
			);
		}
		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: false });
		if (!opened.ok) return opened.error;

		const trimmedMessage = message.trim();
		if (!trimmedMessage) return toolError('reply_to_comment requires a non-empty message.');

		let reanchored = false;
		const outcome = await runCommentWrite(opened.tabId, (doc) => {
			const result = applyReplyToComment(doc, thread_id, file_path, trimmedMessage, {
				proposedEdit: proposed_edit,
				anchorText: anchor_text,
				occurrenceIndex: occurrence_index
			});
			if (result.ok) reanchored = result.reanchored;
			return result;
		});

		if (!outcome.ok) return toolError(outcome.error);
		return toolText(
			reanchored
				? `Replied on thread ${thread_id} (${file_path}) and re-attached it to the new passage.`
				: `Replied on thread ${thread_id} (${file_path}).`
		);
	}
);

/** Read all open (unresolved) comment threads for a tab. Threads are stored
 * in the Y.Doc and persisted to SQLite — not in the JSONL transcript — so the
 * prompt only carries stubs; call this tool to get the full conversations. */
const listThreadsTool = tool(
	'list_threads',
	'Return all open comment threads for a workspace tab, with every message in each. The prompt shows only thread ids and anchor quotes. Call this to read the full conversation before replying.',
	{
		file_path: z
			.string()
			.describe('Workspace-relative tab id or absolute path to the tab file.')
	},
	async ({ file_path }) => {
		if (isScratchPath(file_path)) {
			return toolError('list_threads cannot be used on scratch paths — only on workspace tab files.');
		}
		const tabId = resolveTabFromPath(file_path);
		if (!tabId || !isOpenTab(tabId)) {
			return toolError(`${file_path} is not an open tab. Open it first via the file tree.`);
		}
		const ws = getHocuspocus();
		if (!ws) {
			return toolError('WebSocket server not initialized — Y.Doc sync is offline.');
		}
		const direct = await ws.openDirectConnection(tabId);
		let result = '';
		try {
			await direct.transact((document) => {
				const commentsMap = getCommentsMap(document as unknown as Y.Doc);
				const threads: CommentThread[] = [];
				commentsMap.forEach((t) => { if (!t.resolved) threads.push(t); });
				threads.sort((a, b) => a.createdAt - b.createdAt);
				if (threads.length === 0) {
					result = `No open threads on ${file_path}.`;
					return;
				}
				const lines: string[] = [`${threads.length} open thread${threads.length === 1 ? '' : 's'} on ${file_path}:\n`];
				for (const thread of threads) {
					lines.push(`Thread \`${thread.id}\` — anchor: "${thread.anchor.quote.slice(0, 120)}${thread.anchor.quote.length > 120 ? '…' : ''}"`);
					for (const msg of thread.messages) {
						const role = msg.author === 'agent' ? 'you' : 'user';
						lines.push(`  [${role}] ${msg.text}`);
						if (msg.proposedEdit) {
							lines.push(`    proposed_edit: "${msg.proposedEdit.oldString}" → "${msg.proposedEdit.newString}"`);
						}
					}
					lines.push('');
				}
				result = lines.join('\n');
			});
		} finally {
			await direct.disconnect();
		}
		return { content: [{ type: 'text', text: result }] };
	}
);

export const docToolsMcp = createSdkMcpServer({
	name: 'docwriter-doc',
	version: '0.0.1',
	tools: [editDocTool, readDocTool, writeDocTool, commentDocTool, replyToCommentTool, listThreadsTool]
});

/** SDK-namespaced tool names (what appears in stream events). */
export const EDIT_DOC_TOOL_NAME = 'mcp__docwriter-doc__edit_doc';
export const READ_DOC_TOOL_NAME = 'mcp__docwriter-doc__read_doc';
export const WRITE_DOC_TOOL_NAME = 'mcp__docwriter-doc__write_doc';
export const COMMENT_DOC_TOOL_NAME = 'mcp__docwriter-doc__comment_doc';
export const REPLY_TO_COMMENT_TOOL_NAME = 'mcp__docwriter-doc__reply_to_comment';
export const LIST_THREADS_TOOL_NAME = 'mcp__docwriter-doc__list_threads';
