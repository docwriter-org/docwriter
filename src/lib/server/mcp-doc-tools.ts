/**
 * Custom MCP tools the agent uses in place of built-in `Edit` / `Read` /
 * `Write` for tab files. These tools route on path:
 *
 *   - **Scratch path** (`.docwriter/agent/scratch/...`) → plain filesystem
 *     I/O. Nothing the user sees; no Y.Doc involvement.
 *   - **Open tab** (workspace-relative id or absolute path to the real file)
 *     → Hocuspocus `openDirectConnection` + write the proposal into the live
 *     document as insertion / deletion marks owned by a comment thread
 *     (see `$lib/shared/proposals.ts`). The committed text does NOT change
 *     until the user accepts the thread.
 *   - **Unknown path** → isError:true with a clear message. `write_doc`
 *     never creates new tabs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, relative } from 'path';
import * as Y from 'yjs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Document } from '@hocuspocus/server';

import { matchImportedComment, updateFeedbackDisposition, getFeedbackImport } from './feedback-import';
import {
	readCommentThreads,
	getCommentsMap,
	getThread,
	putThread,
	appendThreadMessage,
	setThreadResolved,
	AGENT_ORIGIN,
	normalizeTypography,
	nthIndexOf
} from '$lib/shared/ydoc-codec';
import {
	proposedText,
	proposeReplacement,
	proposeText,
	setCommentMarkByViewOffsets,
	summarizeThreadMarks,
	type ReplaceResult
} from '$lib/shared/proposals';
import { isScratchPath, resolveTabFromPath, isOpenTab } from './path-router';
import type { CommentMessage, CommentThread } from '$lib/types';
import { formatListedThreads } from '$lib/shared/list-threads';
import { isValidTabId, isBinaryTabPath, tabFile, WORKSPACE_ROOT } from './document-files';
import { resolveWorkspacePath } from './workspace-path';
import { getRules } from './runtime-state';
import { openDocument } from './documents-store';
import { tabHasPersistedUpdates } from './ydoc-persistence';
import { flushTabMarkdownNow } from './ws-server';
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

export interface TabWriteResult {
	beforeMd: string;
	afterMd: string;
	/** True when the edit was tossed because its target thread was already
	 * resolved (no proposal created). */
	discarded?: boolean;
	/** True when the write left the proposed text identical (after typography
	 * normalization), so nothing is pending. The tool result must say so:
	 * reporting it as applied is how the agent ends up telling the author an
	 * edit landed when nothing changed. */
	noop?: boolean;
	/** The comment thread the proposal belongs to. */
	threadId?: string;
}

export type TabWriteFailure = {
	error: string;
	code?: 'not-found' | 'ambiguous' | 'overlap' | 'reply-first';
	hits?: number;
	otherThreadId?: string;
};

export type WriteOp =
	| { kind: 'edit'; oldString: string; newString: string; replaceAll?: boolean }
	| { kind: 'write'; content: string };

export function currentProposalText(doc: Y.Doc): string {
	return proposedText(doc);
}

/**
 * Per-render state, held in an AsyncLocalStorage scope rather than at module
 * scope. These values are ambient inputs to `runTabWrite`,
 * `createAgentEditThread`, `createAgentCommentThread` and
 * `applyReplyToComment` — functions shared by every provider, so passing them
 * as parameters would mean threading them through every call site.
 *
 * They MUST NOT be module globals: a second render starting while the first
 * is still streaming would overwrite them, and whichever render finished
 * first would clear them to null. Concretely, that misattributed a critique
 * pass's findings to another reviewer (or to none), and pointed a
 * feedback-import reply at the wrong thread. This is the same bug class as
 * the `docwriter-doc` MCP server once being a module singleton — per-render
 * state kept at module scope.
 *
 * The scope flows through awaits, so every tool call the render makes reads
 * its own values. Calls that arrive outside any render (a direct API route
 * that has not opened a scope) fall back to a process-wide default.
 */
interface RenderScope {
	feedbackThreadId: string | null;
	reviewerId: string | null;
}

const renderScopeStore = new AsyncLocalStorage<RenderScope>();
const fallbackScope: RenderScope = {
	feedbackThreadId: null,
	reviewerId: null
};

function renderScope(): RenderScope {
	return renderScopeStore.getStore() ?? fallbackScope;
}

/** `{ reviewerId }` when a critique pass is running, `{}` otherwise. Spread
 * onto agent comments so the gutter can attribute them to the reviewer
 * instead of the plain agent. */
function reviewerStamp(): { reviewerId?: string } {
	const id = renderScope().reviewerId;
	return id ? { reviewerId: id } : {};
}

/** Run `fn` with its own isolated copy of the per-render state. Everything
 * the render awaits inside sees these values and nothing outside can see or
 * clobber them, so no explicit teardown is needed. */
export function runWithRenderScope<T>(scope: Partial<RenderScope>, fn: () => T): T {
	return renderScopeStore.run({ feedbackThreadId: null, reviewerId: null, ...scope }, fn);
}

/** Thread id the NEXT proposal should attach to. Set transiently by
 * `edit_doc` for the duration of a single call when the agent passes an
 * explicit `thread_id` (and restored after), so attachment is per-edit and
 * intentional — NOT a render-wide default. Null means "no thread": the
 * proposal opens its own fresh thread (`createAgentEditThread`). This is what
 * lets a thread revision and an unrelated directive edit in the same turn
 * land in different threads. */
export function setActiveFeedbackThreadId(id: string | null) {
	renderScope().feedbackThreadId = id;
}
export function getActiveFeedbackThreadId(): string | null {
	return renderScope().feedbackThreadId;
}

/** The text every provider hands back for a write on an open tab. One
 * source so the wording stays honest everywhere: an edit_doc / write_doc
 * call lands a PENDING proposal, never a change to the document, and a
 * replacement that leaves the text identical lands nothing at all. The
 * old "Edit applied to X." made the agent tell the author the edit was in
 * when the author still had to Accept it — or when nothing had happened. */
export function describeTabWrite(
	filePath: string,
	result: TabWriteResult,
	opts: { kind: 'edit' | 'write'; replaceAll?: boolean; hits?: number; created?: boolean; chars?: number }
): string {
	const hits = opts.hits ?? 1;
	const occurrences = `${hits} occurrence${hits === 1 ? '' : 's'}`;
	if (result.noop) {
		return opts.kind === 'edit'
			? `No change proposed for ${filePath}: new_string leaves the text identical to old_string once typography is normalized (curly quotes, dashes and ellipses are stored as plain ASCII), so there is nothing for me to review. Nothing is pending. Do not report this as an edit; propose a different replacement if you meant to change something.`
			: `No change proposed for ${filePath}: the content is identical to the current document once typography is normalized, so there is nothing for me to review. Nothing is pending.`;
	}
	const thread = result.threadId ? ` on thread ${result.threadId}` : '';
	const tail = ` It changes the document only when I accept it in the gutter, so do not tell me it has been applied.`;
	if (opts.kind === 'edit') {
		return `Proposed the edit as a pending diff${thread} in ${filePath}${opts.replaceAll ? ` (${occurrences} replaced)` : ''}.${tail}`;
	}
	return opts.created
		? `Created ${filePath} and proposed its content (${opts.chars ?? 0} chars) as a pending diff${thread}.${tail}`
		: `Proposed a rewrite of ${filePath} (${opts.chars ?? 0} chars) as a pending diff${thread}.${tail}`;
}

/** The enforcement promise interpolated into the system prompt's "Announce
 * edits on a thread" section. Defined here, beside the runTabWrite gate
 * that enforces it, so the prompt and the enforcement can't drift apart —
 * change the gate's behavior and this sentence in the same place. */
export const REPLY_BEFORE_EDIT_PROMPT_NOTE =
	"This is enforced: while a thread's latest message is mine, edit_doc and write_doc targeting it fail until you have replied.";

/** Reviewer running the current critique pass, if any. Set by /api/render
 * for the duration of a critique render (same lifecycle as
 * `activeFeedbackThreadId`) and stamped onto every agent-authored comment
 * the pass creates, so the gutter can attribute them to the reviewer
 * instead of the plain agent. */
export function setActiveReviewerId(id: string | null) {
	renderScope().reviewerId = id;
}

/** The message the agent gets when its edit would touch a line another
 * thread already holds. One passage, one thread. */
export function describeOverlap(filePath: string, otherThreadId: string): string {
	return (
		`That passage of ${filePath} is under thread ${otherThreadId}, which already holds a proposal or comment there. ` +
		`One passage has one thread: call edit_doc with thread_id="${otherThreadId}" to revise that thread's proposal ` +
		`(reply there first with reply_to_comment if you have not explained the change), or leave the passage alone.`
	);
}

function describeWriteFailure(filePath: string, failure: TabWriteFailure): string {
	switch (failure.code) {
		case 'not-found':
			return `old_string not found in ${filePath}. The text may have changed since your last read — read_doc to see the current state and retry.`;
		case 'ambiguous':
			return `old_string matches ${failure.hits} locations in ${filePath}. Make it more specific (add surrounding context), or pass replace_all: true to replace every occurrence.`;
		case 'overlap':
			return describeOverlap(filePath, failure.otherThreadId ?? '');
		default:
			return failure.error;
	}
}

/** Write an agent proposal into the live document for `tabId`. The op is
 * matched against the proposed view (what `read_doc` returns) and lands as
 * marks on a thread: the explicit render-scope thread, or a fresh one the
 * proposal opens for itself. */
export async function runTabWrite(
	tabId: string,
	op: WriteOp
): Promise<TabWriteResult | TabWriteFailure> {
	if (isBinaryTabPath(tabId)) {
		return { error: `${tabId} is a binary file — it has no editable document.` };
	}
	const ws = getHocuspocus();
	if (!ws) {
		return { error: 'WebSocket server not initialized — Y.Doc sync is offline.' };
	}
	const direct = await ws.openDirectConnection(tabId);
	let result: TabWriteResult | TabWriteFailure | null = null;
	try {
		await direct.transact((document) => {
			result = applyTabWrite(document as unknown as Y.Doc, op);
		});
	} finally {
		await direct.disconnect();
	}
	return result ?? { error: 'DirectConnection.transact returned with no result' };
}

/** The transactional core of `runTabWrite`, on an already-open doc. */
export function applyTabWrite(doc: Y.Doc, op: WriteOp): TabWriteResult | TabWriteFailure {
	const beforeMd = proposedText(doc);
	const targetThreadId = renderScope().feedbackThreadId ?? undefined;
	const commentsMap = getCommentsMap(doc);
	if (targetThreadId) {
		const thread = getThread(commentsMap, targetThreadId);
		// (1) The user already RESOLVED the thread (e.g. while the agent was
		// still thinking): they are done with it — toss the edit instead of
		// reviving the thread with a new proposal. (2) The prompt's
		// "Announce edits on a thread" contract: if the thread's latest
		// message is the user's, the agent hasn't said anything about this
		// proposal yet, and letting it land would show a bare diff with no
		// explanation. Bounce the write with instructions; the agent replies
		// on the thread and retries. The error string is the whole contract
		// because every provider path surfaces it verbatim.
		if (thread?.resolved) return { beforeMd, afterMd: beforeMd, discarded: true, threadId: targetThreadId };
		const lastMessage = thread?.messages[thread.messages.length - 1];
		if (lastMessage?.author === 'user') {
			return {
				code: 'reply-first',
				error:
					`the latest message on thread "${targetThreadId}" is the author's and has ` +
					`no reply from you yet, so this proposal would land as a bare diff with no ` +
					`explanation. First reply on that thread with reply_to_comment — one or two ` +
					`first-person sentences, addressed to the author as "you", on what you make ` +
					`of the feedback and what you are changing — then retry this exact call.`
			};
		}
	}
	const threadId = targetThreadId ?? 'thread_' + cryptoRandomId();
	let outcome: ReplaceResult = { ok: true, noop: true };
	doc.transact(() => {
		outcome =
			op.kind === 'edit'
				? proposeReplacement(doc, threadId, op.oldString, op.newString, op.replaceAll === true)
				: proposeText(doc, threadId, op.content);
		if (outcome.ok && !outcome.noop && !targetThreadId) {
			// No explicit thread → open one so EVERY proposal lives under a
			// thread (the thread is the parent; there are no standalone edit
			// cards). Its position in the document is the marks it now owns.
			createAgentEditThread(doc, threadId);
		}
	}, AGENT_ORIGIN);
	const o = outcome as ReplaceResult;
	if (!o.ok) {
		if (o.reason === 'overlap') {
			return { error: `overlap with thread ${o.otherThreadId}`, code: 'overlap', otherThreadId: o.otherThreadId };
		}
		return { error: o.reason, code: o.reason, hits: o.hits };
	}
	const afterMd = proposedText(doc);
	if (o.noop) return { beforeMd, afterMd, noop: true, threadId: targetThreadId };
	return { beforeMd, afterMd, threadId };
}

export function cryptoRandomId(): string {
	// Node 22+ has globalThis.crypto per Web Crypto API.
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Open the thread a spontaneous proposal lives under, so it renders as a
 * thread card (with a conversation + Dismiss) instead of a bare edit. The
 * marks the proposal just wrote are the thread's position. Caller runs
 * inside the AGENT_ORIGIN transact. */
function createAgentEditThread(doc: Y.Doc, threadId: string): void {
	const now = Date.now();
	const thread: CommentThread = {
		id: threadId,
		messages: [
			{
				id: 'msg_' + cryptoRandomId(),
				author: 'agent',
				text: 'Suggested an edit.',
				timestamp: now,
				...reviewerStamp()
			}
		],
		resolved: false,
		createdAt: now
	};
	putThread(getCommentsMap(doc), thread);
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

/** Binary files (PDFs, images, …) have no editable document: materializing
 * a Y.Doc for one would seed the file's bytes into the CRDT log as UTF-8
 * mojibake. Every doc tool rejects them with a pointer to the built-in
 * Read, which handles PDFs and images natively. */
export function binaryTabError(path: string): CallToolResult {
	return toolError(
		`${path} is a binary file — it has no editable document and no doc tools. Use the built-in Read tool to view it.`
	);
}

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
	if (existingTabId && isBinaryTabPath(existingTabId)) {
		return { ok: false, error: binaryTabError(path) };
	}
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
	if (isBinaryTabPath(tabId)) {
		return { ok: false, error: binaryTabError(path) };
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
			if (tabHasPersistedUpdates(tabId)) {
				// File vanished externally but its Y.Doc history survives —
				// restore the file from the log instead of blanking both
				// (create-empty over history also armed the disk-wins reseed
				// on next load, since an empty file looks like an external
				// edit).
				flushTabMarkdownNow(tabId);
			} else {
				writeTextAtomic(absPath, '');
			}
		} catch (err) {
			return {
				ok: false,
				error: toolError(`Failed to create ${path}: ${(err as Error).message}`)
			};
		}
	}

	// Deliberately do NOT activate. The user may be mid-sentence on another
	// tab; silently yanking focus to a tab the agent just created is
	// disorienting. The new tab shows up in the bar with a pulsing dot
	// (driven by `freshAgentTabs` on the client) and the user opens it when
	// they're ready.
	openDocument(tabId, { activate: false });

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

// ---- Shared edit / write handlers ------------------------------------------

/** The whole `edit_doc` flow on an open tab after path routing, shared by
 * the Claude MCP tool and the provider-agnostic handlers so the two cannot
 * drift: freeze gate, explicit thread targeting, the write, the feedback
 * ledger upgrade, and the result text. */
export async function editOpenTab(
	filePath: string,
	tabId: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
	threadIdArg: string | undefined
): Promise<CallToolResult> {
	// Soft freeze gate: rules prefixed with "Freeze: " name passages the
	// agent must not edit. Reject before opening a proposal so the agent
	// can apologize / work around instead of proposing a no-op.
	const hit = findOverlappingFreeze([oldString, newString], getRules());
	if (hit) {
		const quote = freezeQuoteFromRule(hit);
		const preview = quote.length > 80 ? quote.slice(0, 77) + '…' : quote;
		return toolError(`Frozen: overlapping "${preview}" — leave this passage unchanged.`);
	}

	// An explicit thread_id on the call wins over the render-level default
	// (parsed from the triggering message). Restore the prior value after
	// so a single edit's targeting can't leak into later edits this turn.
	const priorThreadId = renderScope().feedbackThreadId;
	if (threadIdArg) setActiveFeedbackThreadId(threadIdArg);
	let result: TabWriteResult | TabWriteFailure;
	try {
		result = await runTabWrite(tabId, { kind: 'edit', oldString, newString, replaceAll });
	} finally {
		if (threadIdArg) setActiveFeedbackThreadId(priorThreadId);
	}
	if ('error' in result) return toolError(describeWriteFailure(filePath, result));
	if (result.discarded) {
		return toolText(
			`Edit discarded for ${filePath}: this feedback thread was resolved before the edit landed, so it was not applied. Do not retry.`
		);
	}
	if (threadIdArg && !result.noop) {
		const imp = getFeedbackImport();
		if (imp) {
			for (const c of imp.comments) {
				if (imp.commentToThread[c.id] === threadIdArg) {
					updateFeedbackDisposition(c.id, threadIdArg, 'applied');
					break;
				}
			}
		}
	}
	return toolText(describeTabWrite(filePath, result, { kind: 'edit', replaceAll }));
}

/** The `write_doc` flow on an open tab after path routing (see `editOpenTab`). */
export async function writeOpenTab(
	filePath: string,
	tabId: string,
	content: string,
	created: boolean
): Promise<CallToolResult> {
	const result = await runTabWrite(tabId, { kind: 'write', content });
	if ('error' in result) return toolError(describeWriteFailure(filePath, result));
	return toolText(describeTabWrite(filePath, result, { kind: 'write', created, chars: content.length }));
}

// ---- Tool definitions -----------------------------------------------------

const editDocTool = tool(
	'edit_doc',
	'Replace old_string with new_string in the given file. For a workspace file this creates or updates a pending proposal shown as tracked changes under a comment thread. The document changes only when I accept it. For a path under .docwriter/agent/scratch/ it writes plain text. old_string must match exactly once. Pass replace_all: true to replace every occurrence in one proposal, which suits renames and consistent term changes.',
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
				'The thread this edit belongs to: the id comment_doc returned for its announce comment, the thread_id of the feedback you are answering, or the thread whose pending proposal you are revising (a new proposal on a thread replaces its old one). A passage has one thread, so an edit on a passage another thread already holds must use that thread. Omit only when no thread is about this passage yet; the system then opens one.'
			)
	},
	async ({ file_path, old_string, new_string, replace_all, thread_id }) => {
		const replaceAll = replace_all === true;
		old_string = normalizeTypography(old_string);
		new_string = normalizeTypography(new_string);
		if (isScratchPath(file_path)) return editScratch(file_path, old_string, new_string, replaceAll);

		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: false });
		if (!opened.ok) return opened.error;
		return editOpenTab(
			file_path,
			opened.tabId,
			old_string,
			new_string,
			replaceAll,
			typeof thread_id === 'string' && thread_id ? thread_id : undefined
		);
	}
);

const readDocTool = tool(
	'read_doc',
	'Read the current content of a workspace file or scratch file. For an open tab it returns the document with every pending proposal shown as if accepted, so what you read is what your edits build on.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative tab id, absolute path to an open tab file, or absolute path inside .docwriter/agent/scratch/.'
			)
	},
	async ({ file_path }) => {
		if (isScratchPath(file_path)) return readScratch(file_path);

		// Open tab → return the proposed view of the live document. This is
		// the path that lets the agent see its own pending proposals before
		// they land.
		const tabId = resolveTabFromPath(file_path);
		if (tabId && isBinaryTabPath(tabId)) {
			return binaryTabError(file_path);
		}
		if (tabId && isOpenTab(tabId)) {
			const ws = getHocuspocus();
			if (!ws) {
				return toolError('WebSocket server not initialized — Y.Doc sync is offline.');
			}
			const direct = await ws.openDirectConnection(tabId);
			try {
				let content = '';
				await direct.transact((document) => {
					content = proposedText(document as unknown as Y.Doc);
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
	'Replace the full content of a workspace or scratch file. If the file exists, the write lands as a pending proposal shown as tracked changes. If it does not exist, write_doc creates it and opens it as a new tab with the content pending. Scratch paths are written directly.',
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
		// For a new file the committed text is empty and the whole content
		// lands as inserted paragraphs.
		return writeOpenTab(file_path, opened.tabId, content, !opened.existedOnDisk);
	}
);

// ---- Comments -------------------------------------------------------------

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

/** Create a new agent-authored comment thread on a passage of the proposed
 * view (the text the agent read): a comment mark carrying the new thread's
 * id goes on `[start, start + anchorText.length)`. Shared by the Claude MCP
 * tool and the provider-agnostic handlers. Runs inside the caller's
 * `runCommentWrite` transaction. */
export function createAgentCommentThread(
	doc: Y.Doc,
	filePath: string,
	anchorText: string,
	occurrenceIndex: number | undefined,
	message: string,
	externalAuthor?: string
): { ok: true; threadId: string } | { ok: false; error: string } {
	const liveText = proposedText(doc);
	const hits = countOccurrences(liveText, anchorText);
	if (hits === 0) {
		return {
			ok: false,
			error: `anchor_text was not found in ${filePath}. Call read_doc and retry with exact current text.`
		};
	}
	if (hits > 1 && occurrenceIndex === undefined) {
		return {
			ok: false,
			error: `anchor_text matches ${hits} locations in ${filePath}. Pass occurrence_index to choose one.`
		};
	}
	const occurrence = occurrenceIndex ?? 0;
	if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= hits) {
		return {
			ok: false,
			error: `occurrence_index ${occurrence} is out of range; anchor_text appears ${hits} time${hits === 1 ? '' : 's'}.`
		};
	}
	const start = nthIndexOf(liveText, anchorText, occurrence);
	const threadId = 'thread_' + cryptoRandomId();
	const now = Date.now();
	const isExternal = !!externalAuthor;
	const thread: CommentThread = {
		id: threadId,
		messages: [
			{
				id: 'msg_' + cryptoRandomId(),
				author: isExternal ? 'external' : 'agent',
				text: message,
				timestamp: now,
				...(isExternal ? { externalAuthor } : {}),
				...reviewerStamp()
			}
		],
		resolved: false,
		createdAt: now
	};
	let marked: ReturnType<typeof setCommentMarkByViewOffsets> = { ok: false, reason: 'range' };
	doc.transact(() => {
		marked = setCommentMarkByViewOffsets(doc, threadId, { kind: 'proposed' }, start, start + anchorText.length);
		if (marked.ok) putThread(getCommentsMap(doc), thread);
	}, AGENT_ORIGIN);
	const m = marked as ReturnType<typeof setCommentMarkByViewOffsets>;
	if (!m.ok) {
		return {
			ok: false,
			error:
				m.reason === 'overlap'
					? describeOverlap(filePath, m.otherThreadId)
					: `anchor_text could not be marked in ${filePath}. Call read_doc and retry with exact current text.`
		};
	}

	if (isExternal) {
		const commentId = matchImportedComment(externalAuthor, message);
		if (commentId) {
			updateFeedbackDisposition(commentId, threadId, 'discussed');
		}
	}

	return { ok: true, threadId };
}

/** Reply on an existing thread, optionally moving its comment highlight onto
 * a new passage (`anchorText`, matched in the proposed view). Used by both
 * the Claude MCP tool and the provider-agnostic tool-handlers path. Caller
 * runs inside `runCommentWrite`. */
export function applyReplyToComment(
	doc: Y.Doc,
	threadId: string,
	filePath: string,
	message: string,
	options?: {
		anchorText?: string;
		occurrenceIndex?: number;
	}
): { ok: true; reanchored: boolean } | { ok: false; error: string } {
	const commentsMap = getCommentsMap(doc);
	const existing = getThread(commentsMap, threadId);
	if (!existing) {
		return { ok: false, error: `Thread "${threadId}" does not exist on ${filePath}.` };
	}

	let anchorStart = -1;
	const anchorText = options?.anchorText?.trim();
	if (anchorText) {
		const liveText = proposedText(doc);
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
		anchorStart = nthIndexOf(liveText, anchorText, occurrence);
	}

	const now = Date.now();
	const newMessage: CommentMessage = {
		id: 'msg_' + cryptoRandomId(),
		author: 'agent',
		text: message,
		timestamp: now,
		...reviewerStamp()
	};
	let overlap: string | null = null;
	let reanchored = false;
	// Field-level writes: the reply appends, the re-anchor touches only the
	// marks, and re-opening flips only the resolved flag — none of them can
	// clobber a concurrent write to the rest of the thread.
	doc.transact(() => {
		if (anchorText && anchorStart >= 0) {
			const marked = setCommentMarkByViewOffsets(
				doc,
				threadId,
				{ kind: 'proposed' },
				anchorStart,
				anchorStart + anchorText.length
			);
			if (!marked.ok) {
				overlap = marked.reason === 'overlap' ? marked.otherThreadId : '';
				return;
			}
			reanchored = true;
		}
		appendThreadMessage(commentsMap, threadId, newMessage, { reopen: true });
		setThreadResolved(commentsMap, threadId, false);
	}, AGENT_ORIGIN);
	if (overlap !== null) {
		return {
			ok: false,
			error: overlap
				? describeOverlap(filePath, overlap)
				: `anchor_text could not be marked in ${filePath}. Call read_doc and retry with exact current text.`
		};
	}
	return { ok: true, reanchored };
}

const commentDocTool = tool(
	'comment_doc',
	'Create a new comment thread anchored to existing text in a workspace document. Use it, at any autonomy level, as the announce thread before an edit proposal (see "Announce edits on a thread" in your instructions), then pass the thread id it returns to edit_doc. Unprompted observation comments are allowed only at Medium or High autonomy, or when I ask for a comment; at Low autonomy you may otherwise only reply on threads I opened. The comment appears in the document gutter and does not change document text. A passage has one thread: anchoring on text another thread already holds fails and names that thread.',
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
		external_author: z
			.string()
			.optional()
			.describe(
				'Name of an external commenter when importing feedback from outside the system. When set, the comment is attributed to that person rather than the agent.'
			)
	},
	async ({ file_path, anchor_text, message, occurrence_index, external_author }) => {
		if (isScratchPath(file_path)) {
			return toolError('comment_doc cannot be used on scratch paths — only on workspace files.');
		}
		const opened = ensureWorkspaceTabOpen(file_path, { createIfMissing: false });
		if (!opened.ok) return opened.error;

		const anchorText = normalizeTypography(anchor_text.trim());
		const trimmedMessage = message.trim();
		if (!anchorText) return toolError('comment_doc requires non-empty anchor_text.');
		if (!trimmedMessage) return toolError('comment_doc requires a non-empty message.');

		let threadId = '';
		const outcome = await runCommentWrite(opened.tabId, (doc) => {
			const created = createAgentCommentThread(
				doc,
				file_path,
				anchorText,
				occurrence_index,
				trimmedMessage,
				external_author
			);
			if (!created.ok) return created;
			threadId = created.threadId;
			return { ok: true };
		});

		if (!outcome.ok) return toolError(outcome.error);
		return toolText(
			`Commented on ${file_path} in thread ${threadId}. Pass thread_id="${threadId}" to edit_doc for the edit this comment announces.`
		);
	}
);

const replyToCommentTool = tool(
	'reply_to_comment',
	'Reply on an existing comment thread. Route per the "Where a response goes" rules in your instructions. Write in the first person and keep it to a few sentences. When the reply says what you would change, propose that change with edit_doc on the same thread in this turn; a reply is never a substitute for the diff, and there is no separate approval step. Pass optional anchor_text to move the thread onto a new passage (re-attach after the passage it was on is gone). To start a new thread, use comment_doc.',
	{
		file_path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-1.md") or absolute path inside the workspace. Must be an existing file — comments can only be attached to a tab I can open.'
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
				'Exact current document text to move this thread onto. Use when the passage it was on is gone (e.g. I accepted a neighboring proposal) and you need to re-attach the conversation to the corresponding current passage. Prefer a short unique sentence or clause.'
			),
		occurrence_index: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				'Zero-based occurrence to anchor when anchor_text appears more than once. Required only when anchor_text is not unique.'
			)
	},
	async ({ file_path, thread_id, message, anchor_text, occurrence_index }) => {
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
				anchorText: anchor_text ? normalizeTypography(anchor_text) : undefined,
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

/** Threads of an open tab with the passage each one sits on, for
 * `list_threads` and the prompt stubs. */
export function listTabThreads(doc: Y.Doc): { threads: CommentThread[]; quotes: Map<string, string> } {
	const quotes = new Map<string, string>();
	for (const s of summarizeThreadMarks(doc)) quotes.set(s.threadId, s.quote);
	return { threads: readCommentThreads(doc), quotes };
}

/** Read comment threads for a tab. Threads live on the Y.Doc (persisted via
 * `yjs_updates`), so the prompt only carries stubs; call this for the full
 * conversation. Dismissed threads stay on the map with `resolved: true` —
 * pass include_dismissed to read them, then review_action(reopen_thread) to
 * put one back in the gutter. */
const listThreadsTool = tool(
	'list_threads',
	'Return comment threads for a workspace tab, with every message in each. Defaults to open (visible) threads. The prompt shows only stubs. Set include_dismissed=true to read threads I dismissed — they stay on the document, hidden from the gutter. Then review_action({ action: "reopen_thread", thread_id }) brings one back.',
	{
		file_path: z
			.string()
			.describe('Workspace-relative tab id or absolute path to the tab file.'),
		include_dismissed: z
			.boolean()
			.optional()
			.describe(
				'If true, also return dismissed (hidden) threads so you can reopen one. Use when I ask about a thread that disappeared or want one brought back.'
			)
	},
	async ({ file_path, include_dismissed }) => {
		if (isScratchPath(file_path)) {
			return toolError('list_threads cannot be used on scratch paths — only on workspace tab files.');
		}
		const tabId = resolveTabFromPath(file_path);
		if (tabId && isBinaryTabPath(tabId)) {
			return binaryTabError(file_path);
		}
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
				const { threads, quotes } = listTabThreads(document as unknown as Y.Doc);
				result = formatListedThreads(file_path, threads, include_dismissed === true, quotes);
			});
		} finally {
			await direct.disconnect();
		}
		return { content: [{ type: 'text', text: result }] };
	}
);

/** Build a FRESH `docwriter-doc` MCP server for one `query()` call.
 *
 * This must NOT be a module-level singleton. An in-process SDK MCP server
 * binds to the query that connects it, so sharing one instance across
 * overlapping renders leaves the second render without any document tools:
 * `edit_doc` / `read_doc` / `comment_doc` and friends silently vanish from
 * its tool list. The agent then falls back to the built-in `Edit`, which
 * writes straight to the workspace file with no proposal, no thread and
 * no diff — the user's document changes with nothing to accept or
 * reject. (Its sibling `buildDocwriterMcp()` was already per-call, which is
 * why only these six tools disappeared.) */
export function buildDocToolsMcp() {
	return createSdkMcpServer({
		name: 'docwriter-doc',
		version: '0.0.1',
		tools: [editDocTool, readDocTool, writeDocTool, commentDocTool, replyToCommentTool, listThreadsTool]
	});
}

/** SDK-namespaced tool names (what appears in stream events). */
export const EDIT_DOC_TOOL_NAME = 'mcp__docwriter-doc__edit_doc';
export const READ_DOC_TOOL_NAME = 'mcp__docwriter-doc__read_doc';
export const WRITE_DOC_TOOL_NAME = 'mcp__docwriter-doc__write_doc';
export const COMMENT_DOC_TOOL_NAME = 'mcp__docwriter-doc__comment_doc';
export const REPLY_TO_COMMENT_TOOL_NAME = 'mcp__docwriter-doc__reply_to_comment';
export const LIST_THREADS_TOOL_NAME = 'mcp__docwriter-doc__list_threads';
