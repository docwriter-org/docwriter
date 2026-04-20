/**
 * Custom MCP tools the agent uses in place of built-in `Edit` / `Read` /
 * `Write` for tab files. These tools route on path:
 *
 *   - **Scratch path** (`.docwriter/agent/scratch/...`) → plain filesystem
 *     I/O. Nothing the user sees; no Y.Doc involvement.
 *   - **Open tab** (workspace-relative id or absolute path to the real file)
 *     → Hocuspocus `openDirectConnection` + `document.transact(...,
 *     AGENT_ORIGIN)`. Mutating the registry Y.Doc wouldn't reach the browser
 *     because Hocuspocus copies state into its own internal `Document` on
 *     first load; the live Document is the only authoritative copy.
 *   - **Unknown path** → isError:true with a clear message. `write_doc`
 *     never creates new tabs.
 *
 * The replacement + review-round map write happen inside one
 * `document.transact(..., AGENT_ORIGIN)` so clients receive them as a single
 * Yjs update — the content change and the pending review card land atomically.
 *
 * Coarse full-replace delta: rather than trying to convert a string offset
 * into a ProseMirror position, we bind a headless Tiptap editor (the same
 * `collaborativeExtensions`-equivalent used elsewhere on the server) to the
 * live document and call `setContent(newMd, { emitUpdate: false })`. The
 * ySyncPlugin translates the PM diff into the minimal Yjs ops inside our
 * transact. That's coarser than an in-place splice but correct — user ops
 * outside the changed region are preserved by the CRDT's item-level merge.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Document } from '@hocuspocus/server';

import '$lib/server/dom-shim';
import { AGENT_ORIGIN } from './ydoc-registry';
import { serializeYDocToMarkdown } from './ydoc-markdown';
import { markdownBaseExtensions, plainBaseExtensions } from '$lib/editor-extensions';
import { tabKind } from './document-files';
import { isScratchPath, resolveTabFromPath, isOpenTab } from './path-router';
import { classifyRoundKind } from '$lib/review-diff';
import type { PendingReviewRound } from '$lib/types';

const FRAGMENT_NAME = 'default';
const REVIEW_MAP_NAME = 'review';

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

/** Run a write-transaction against the live Hocuspocus Document for `tabId`.
 * `mutator` receives (currentMd, kind) and returns the new markdown string,
 * or null to abort (no write, no review round). Any work the mutator wants
 * to do on the live document happens via the returned newMd — we then bind
 * a headless Collaboration editor to the document and `setContent(newMd)`,
 * wrapping that in `document.transact(..., AGENT_ORIGIN)` alongside the
 * review-map update so clients receive one atomic update. */
async function runTabWrite(
	tabId: string,
	trigger: PendingReviewRound['trigger'],
	mutator: (currentMd: string, kind: 'markdown' | 'plain') => string | null
): Promise<TabWriteResult | { error: string }> {
	const ws = getHocuspocus();
	if (!ws) {
		return { error: 'WebSocket server not initialized — Y.Doc sync is offline.' };
	}
	const kind = tabKind(tabId);
	const direct = await ws.openDirectConnection(tabId);
	let result: TabWriteResult | { error: string } | null = null;
	try {
		await direct.transact((document) => {
			const doc = document as unknown as Y.Doc;
			const beforeMd = serializeYDocToMarkdown(doc, kind);
			const afterMd = mutator(beforeMd, kind);
			if (afterMd === null) {
				result = { error: 'mutator-aborted' };
				return;
			}
			if (afterMd === beforeMd) {
				// No-op write. Still succeeds, but don't emit a review round.
				result = { beforeMd, afterMd };
				return;
			}
			doc.transact(() => {
				// Rebuild the default fragment from the new content via a
				// headless Collaboration editor. ySyncPlugin emits minimal
				// Yjs ops on the live document inside this transact so
				// everything carries AGENT_ORIGIN.
				const base = kind === 'plain' ? plainBaseExtensions() : markdownBaseExtensions();
				const headless = new Editor({
					extensions: [
						...base,
						Collaboration.configure({ document: doc, field: FRAGMENT_NAME })
					]
				});
				try {
					headless.commands.setContent(afterMd, { emitUpdate: false });
				} finally {
					headless.destroy();
				}

				// Append a pending review round in the same transact so the
				// browser receives content + review card as one update.
				const reviewMap = doc.getMap(REVIEW_MAP_NAME);
				const existing =
					(reviewMap.get('pendingRounds') as PendingReviewRound[] | undefined) ?? [];
				const round: PendingReviewRound = {
					id: cryptoRandomId(),
					beforeMd,
					afterMd,
					trigger,
					timestamp: Date.now(),
					kind: classifyRoundKind(beforeMd, afterMd),
					stepCount: 1
				};
				reviewMap.set('pendingRounds', [...existing, round]);
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

function editScratch(path: string, oldString: string, newString: string): CallToolResult {
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
	if (hits > 1) {
		return toolError(
			`old_string matches ${hits} locations in ${path}. Make it more specific (add surrounding context) so it matches exactly one place.`
		);
	}
	const next = current.replace(oldString, newString);
	try {
		writeFileSync(path, next, 'utf8');
	} catch (err) {
		return toolError(`Failed to write ${path}: ${(err as Error).message}`);
	}
	return toolText(`Edit applied to ${path}.`);
}

// ---- Tool definitions -----------------------------------------------------

const editDocTool = tool(
	'edit_doc',
	'Replace `old_string` with `new_string` in the given file. For an open tab (.md/plain file the user has open), this goes straight into the live Y.Doc as an atomic agent-origin change and a reviewable round appears in the outline. For a file under `.docwriter/agent/scratch/` it writes plain text. Fails if `old_string` is not found or matches more than once.',
	{
		path: z
			.string()
			.describe(
				'Either the workspace-relative tab id (e.g. "drafts/chapter-1.md"), the absolute path to the tab file, or an absolute path inside .docwriter/agent/scratch/.'
			),
		old_string: z.string().describe('Exact substring to replace. Must appear exactly once.'),
		new_string: z.string().describe('The replacement string. Can be empty to delete.')
	},
	async ({ path, old_string, new_string }) => {
		if (isScratchPath(path)) return editScratch(path, old_string, new_string);

		const tabId = resolveTabFromPath(path);
		if (!tabId || !isOpenTab(tabId)) {
			return toolError(
				`${path} is not an open tab or a scratch path. Ask the user to open the file, or write to a path under .docwriter/agent/scratch/.`
			);
		}

		let failure: string | null = null;
		const result = await runTabWrite(tabId, 'agent_edit_doc', (currentMd) => {
			const hits = countOccurrences(currentMd, old_string);
			if (hits === 0) {
				failure = `old_string not found in ${path}. The user may have edited this area — read_doc to see the current state and retry.`;
				return null;
			}
			if (hits > 1) {
				failure = `old_string matches ${hits} locations in ${path}. Make it more specific (add surrounding context).`;
				return null;
			}
			return currentMd.replace(old_string, new_string);
		});
		if (failure) return toolError(failure);
		if ('error' in result) {
			if (result.error === 'mutator-aborted') {
				// A mutator-level abort that didn't set `failure` is a bug; surface it.
				return toolError(`edit_doc aborted without a reason for ${path}.`);
			}
			return toolError(`edit_doc failed for ${path}: ${result.error}`);
		}
		return toolText(`Edit applied to ${path}.`);
	}
);

const readDocTool = tool(
	'read_doc',
	'Read the current content of an open tab or a scratch file. For tabs, returns the live Y.Doc content (matches what the user sees). For scratch, returns the file from disk.',
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
		const kind = tabKind(tabId);
		const direct = await ws.openDirectConnection(tabId);
		try {
			let content = '';
			await direct.transact((document) => {
				content = serializeYDocToMarkdown(document as unknown as Y.Doc, kind);
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
	'Replace the entire content of an open tab or a scratch file. For tabs, this lands as one atomic agent-origin change and emits a single reviewable round. write_doc does NOT create new tabs — the target must already be open.',
	{
		path: z
			.string()
			.describe(
				'Workspace-relative tab id, absolute path to an open tab file, or absolute path inside .docwriter/agent/scratch/.'
			),
		content: z.string().describe('The new full content of the file.')
	},
	async ({ path, content }) => {
		if (isScratchPath(path)) return writeScratch(path, content);

		const tabId = resolveTabFromPath(path);
		if (!tabId || !isOpenTab(tabId)) {
			return toolError(
				`${path} is not an open tab or a scratch path. write_doc does not create new tabs — ask the user to open the file first.`
			);
		}

		const result = await runTabWrite(tabId, 'agent_write_doc', () => content);
		if ('error' in result) {
			return toolError(`write_doc failed for ${path}: ${result.error}`);
		}
		return toolText(`Wrote ${content.length} chars to ${path}.`);
	}
);

export const docToolsMcp = createSdkMcpServer({
	name: 'docwriter-doc',
	version: '0.0.1',
	tools: [editDocTool, readDocTool, writeDocTool]
});

/** SDK-namespaced tool names (what appears in stream events). */
export const EDIT_DOC_TOOL_NAME = 'mcp__docwriter-doc__edit_doc';
export const READ_DOC_TOOL_NAME = 'mcp__docwriter-doc__read_doc';
export const WRITE_DOC_TOOL_NAME = 'mcp__docwriter-doc__write_doc';
