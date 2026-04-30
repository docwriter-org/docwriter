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

import {
	serializeYDoc,
	getReviewArray,
	readReviewRounds,
	getCommentsMap,
	AGENT_ORIGIN
} from '$lib/shared/ydoc-codec';
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
import { getTabsState, setTabsState } from './runtime-state';
import { writeTextAtomic } from './file-utils';

function toolError(message: string): CallToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: message }]
	};
}

function toolText(message: string): CallToolResult {
	return {
		content: [{ type: 'text', text: message }]
	};
}

function countOccurrences(haystack: string, needle: string): number {
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
function getHocuspocus(): { openDirectConnection: (name: string) => Promise<{ transact: (cb: (doc: Document) => void | Promise<void>) => Promise<void>; disconnect: () => Promise<void> }> } | null {
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

function currentProposalText(doc: Y.Doc): string {
	return materializePendingReviewText(serializeYDoc(doc), readReviewRounds(doc));
}

/** Run a write-transaction against the live Hocuspocus Document for `tabId`.
 * `mutator` receives the current proposal text (latest pending `afterMd`, or
 * the committed live doc if no proposal is pending) and returns the next
 * proposal string, or null to abort. */
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
			const normalizedOperation =
				operation.type === 'write'
					? (narrowWriteOperation(beforeMd, afterMd) ?? operation)
					: operation;
			doc.transact(() => {
				const reviewArr = getReviewArray(doc);
				const round: PendingReviewRound = {
					id: cryptoRandomId(),
					operation: normalizedOperation,
					baseHash:
						normalizedOperation.type === 'write'
							? reviewTextHash(beforeMd)
							: undefined,
					trigger,
					timestamp: Date.now(),
					kind: classifyRoundKind(beforeMd, afterMd),
					stepCount: 1
				};
				reviewArr.push([round]);
			}, AGENT_ORIGIN);
			result = { beforeMd, afterMd };
		});
	} finally {
		await direct.disconnect();
	}
	return result ?? { error: 'DirectConnection.transact returned with no result' };
}

function cryptoRandomId(): string {
	// Node 22+ has globalThis.crypto per Web Crypto API.
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return 'round-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---- Auto-open-as-tab -----------------------------------------------------

/** Convert a user-supplied `path` (absolute or relative) into a workspace-
 * relative tabId, validating it and ensuring it doesn't escape the workspace
 * root. Returns null if the path can't be made into a valid tabId. */
function pathToTabId(path: string): string | null {
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
function ensureWorkspaceTabOpen(
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

function readScratch(path: string): CallToolResult {
	try {
		const content = readFileSync(path, 'utf8');
		return { content: [{ type: 'text', text: content }] };
	} catch (err) {
		return toolError(`Failed to read ${path}: ${(err as Error).message}`);
	}
}

function writeScratch(path: string, content: string): CallToolResult {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf8');
		return toolText(`Wrote ${content.length} chars to ${path}.`);
	} catch (err) {
		return toolError(`Failed to write ${path}: ${(err as Error).message}`);
	}
}

function editScratch(
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
	'Replace `old_string` with `new_string` in the given file. For an open tab, this creates or updates a pending review proposal; the live document changes only after the user accepts it. For a file under `.docwriter/agent/scratch/` it writes plain text. By default `old_string` must match exactly once; pass `replace_all: true` to replace every occurrence as a single proposal.',
	{
		path: z
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
			)
	},
	async ({ path, old_string, new_string, replace_all }) => {
		const replaceAll = replace_all === true;
		if (isScratchPath(path)) return editScratch(path, old_string, new_string, replaceAll);

		const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
		if (!opened.ok) return opened.error;
		const tabId = opened.tabId;

		let failure: string | null = null;
		let appliedHits = 0;
		const result = await runTabWrite(tabId, 'agent_edit_doc', (currentMd) => {
			const hits = countOccurrences(currentMd, old_string);
			if (hits === 0) {
				failure = `old_string not found in ${path}. The user may have edited this area — read_doc to see the current state and retry.`;
				return null;
			}
			if (hits > 1 && !replaceAll) {
				failure = `old_string matches ${hits} locations in ${path}. Make it more specific (add surrounding context), or pass replace_all: true to replace every occurrence.`;
				return null;
			}
			appliedHits = hits;
			const afterMd = replaceAll
				? currentMd.split(old_string).join(new_string)
				: currentMd.replace(old_string, new_string);
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
		if (failure) return toolError(failure);
		if ('error' in result) {
			if (result.error === 'mutator-aborted') {
				// A mutator-level abort that didn't set `failure` is a bug; surface it.
				return toolError(`edit_doc aborted without a reason for ${path}.`);
			}
			return toolError(`edit_doc failed for ${path}: ${result.error}`);
		}
		return toolText(
			replaceAll
				? `Edit applied to ${path} (replaced ${appliedHits} occurrence${appliedHits === 1 ? '' : 's'}).`
				: `Edit applied to ${path}.`
		);
	}
);

const readDocTool = tool(
	'read_doc',
	'Read the current content of an open tab or a scratch file. For tabs, returns the latest review-aware content: the newest pending proposal if one exists, otherwise the committed live document.',
	{
		path: z
			.string()
			.describe(
				'Workspace-relative tab id, absolute path to an open tab file, or absolute path inside .docwriter/agent/scratch/.'
			)
	},
	async ({ path }) => {
		if (isScratchPath(path)) return readScratch(path);

		const tabId = resolveTabFromPath(path);
		if (!tabId || !isOpenTab(tabId)) {
			return toolError(
				`${path} is not an open tab or a scratch path. Use the built-in Read tool for other files in the project.`
			);
		}

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
			return toolError(`Failed to read ${path}: ${(err as Error).message}`);
		} finally {
			await direct.disconnect();
		}
	}
);

const writeDocTool = tool(
	'write_doc',
	'Replace the full content of a workspace file or scratch file. For a path that already exists on disk (whether the tab is open or not), this creates a pending review proposal; the committed document only changes on Accept. For a path that does NOT exist, write_doc creates the file with the given content and opens it as a new tab — no review round is needed because there is nothing to compare against. For scratch paths (under .docwriter/agent/scratch/), it just writes the file directly.',
	{
		path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-2.md"), an absolute path inside the workspace, or an absolute path under .docwriter/agent/scratch/. If the file does not exist, write_doc creates it and opens it as a new tab.'
			),
		content: z.string().describe('The new full content of the file.')
	},
	async ({ path, content }) => {
		if (isScratchPath(path)) return writeScratch(path, content);

		const opened = ensureWorkspaceTabOpen(path, { createIfMissing: true });
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
			return toolError(`write_doc failed for ${path}: ${result.error}`);
		}
		const verb = opened.existedOnDisk ? 'Wrote' : 'Created';
		return toolText(`${verb} ${content.length} chars to ${path}.`);
	}
);

// ---- post_comment -------------------------------------------------------

/** Write a comment thread (new or reply) onto a tab's Y.Map('comments').
 * Runs inside a DirectConnection transaction so the update streams to all
 * connected browsers via Hocuspocus and persists through `yjs_updates`. */
async function runCommentWrite(
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

const postCommentTool = tool(
	'post_comment',
	'Post a comment on a tab file — either opening a NEW thread anchored to a passage, or REPLYING to an existing thread. Use this instead of `edit_doc` when the user\'s feedback is open-ended, exploratory, or unsure ("what do you think", "idk", "is this right?", "maybe X?"), or when they ask a question that doesn\'t demand an immediate edit. Say what you think, optionally sketch an edit in `proposed_edit` (the user can approve it to apply later). For new threads, `anchor_text` must match exactly once in the current live markdown; reply with `thread_id` when continuing a conversation.',
	{
		path: z
			.string()
			.describe(
				'Workspace-relative path (e.g. "drafts/chapter-1.md") or absolute path inside the workspace. Must be an existing file — comments can only be attached to a tab the user can open.'
			),
		thread_id: z
			.string()
			.optional()
			.describe(
				'When replying to an existing thread, pass its id (from the "Open comment threads" prompt block). Omit when opening a new thread.'
			),
		anchor_text: z
			.string()
			.optional()
			.describe(
				'Required when opening a new thread: the exact substring of the current live markdown the thread should anchor to. Must match once; pick a substring that identifies the passage uniquely. Ignored when `thread_id` is set.'
			),
		message: z
			.string()
			.describe(
				'Your comment. Speak in first person ("I\'d cut …", "I think …"), not as a narrator. Keep it shorter than an essay — a few sentences.'
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
	async ({ path, thread_id, anchor_text, message, proposed_edit }) => {
		if (isScratchPath(path)) {
			return toolError(
				'post_comment cannot be used on scratch paths — only on workspace tab files.'
			);
		}
		const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
		if (!opened.ok) return opened.error;

		const trimmedMessage = message.trim();
		if (!trimmedMessage) return toolError('post_comment requires a non-empty message.');

		const outcome = await runCommentWrite(opened.tabId, (doc) => {
			const commentsMap = getCommentsMap(doc);
			const now = Date.now();
			const newMessage: CommentMessage = {
				id: 'msg_' + cryptoRandomId(),
				author: 'agent',
				text: trimmedMessage,
				timestamp: now,
				...(proposed_edit
					? {
							proposedEdit: {
								oldString: proposed_edit.old_string,
								newString: proposed_edit.new_string
							}
						}
					: {})
			};

			if (thread_id) {
				const existing = commentsMap.get(thread_id);
				if (!existing) {
					return { ok: false, error: `Thread "${thread_id}" does not exist on ${path}.` };
				}
				const updated: CommentThread = {
					...existing,
					// Re-opening via a new reply un-resolves the thread so
					// the user sees the new message.
					resolved: false,
					messages: [...existing.messages, newMessage]
				};
				doc.transact(() => commentsMap.set(thread_id, updated), AGENT_ORIGIN);
				return { ok: true };
			}

			if (!anchor_text) {
				return {
					ok: false,
					error: 'Opening a new thread requires `anchor_text` — the passage to anchor to.'
				};
			}
			const liveText = serializeYDoc(doc);
			const matches = countOccurrences(liveText, anchor_text);
			if (matches === 0) {
				return {
					ok: false,
					error: `anchor_text was not found in ${path}. It must be a verbatim substring of the current live content.`
				};
			}
			const occurrenceIndex = 0; // anchor to first match; matches > 1 is fine — stable index.
			const threadId = 'thread_' + cryptoRandomId();
			const thread: CommentThread = {
				id: threadId,
				anchor: {
					quote: anchor_text,
					occurrenceIndex
				},
				messages: [newMessage],
				resolved: false,
				createdAt: now
			};
			doc.transact(() => commentsMap.set(threadId, thread), AGENT_ORIGIN);
			return { ok: true };
		});

		if (!outcome.ok) return toolError(outcome.error);
		return toolText(
			thread_id
				? `Replied on thread ${thread_id} (${path}).`
				: `Opened a new thread on ${path}.`
		);
	}
);

export const docToolsMcp = createSdkMcpServer({
	name: 'docwriter-doc',
	version: '0.0.1',
	tools: [editDocTool, readDocTool, writeDocTool, postCommentTool]
});

/** SDK-namespaced tool names (what appears in stream events). */
export const EDIT_DOC_TOOL_NAME = 'mcp__docwriter-doc__edit_doc';
export const READ_DOC_TOOL_NAME = 'mcp__docwriter-doc__read_doc';
export const WRITE_DOC_TOOL_NAME = 'mcp__docwriter-doc__write_doc';
export const POST_COMMENT_TOOL_NAME = 'mcp__docwriter-doc__post_comment';
