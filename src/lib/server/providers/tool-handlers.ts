/**
 * Provider-agnostic tool definitions. Each provider adapter imports these
 * and wraps them in its SDK's native tool format. The actual mutation logic
 * lives in mcp-doc-tools.ts; this module only defines the schema + handler
 * shape.
 */
import type { ToolDefinition, ToolResult } from './types';
import {
	runTabWrite,
	runCommentWrite,
	setActiveFeedbackThreadId,
	countOccurrences,
	getHocuspocus,
	ensureWorkspaceTabOpen,
	readScratch,
	writeScratch,
	editScratch,
	pathToTabId,
	cryptoRandomId,
	currentProposalText,
	toolError,
	toolText
} from '$lib/server/mcp-doc-tools';
import { isScratchPath, resolveTabFromPath, isOpenTab } from '$lib/server/path-router';
import { readFileSync, existsSync } from 'fs';
import * as Y from 'yjs';
import {
	getCommentsMap,
	AGENT_ORIGIN
} from '$lib/shared/ydoc-codec';
import type {
	CommentMessage,
	CommentThread
} from '$lib/types';
import { resolveWorkspacePath } from '$lib/server/workspace-path';

function toToolResult(r: any): ToolResult {
	const textContent = (r.content ?? [])
		.filter((c: any) => c.type === 'text' && typeof c.text === 'string')
		.map((c: any) => ({ type: 'text' as const, text: c.text as string }));
	return { content: textContent, isError: r.isError };
}

export function buildToolDefinitions(): ToolDefinition[] {
	return [
		{
			name: 'edit_doc',
			description:
				'Replace `old_string` with `new_string` in the given file. Creates a pending review proposal for open tabs.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative tab id, absolute path, or scratch path.' },
					old_string: { type: 'string', description: 'Exact substring to replace.' },
					new_string: { type: 'string', description: 'The replacement string.' },
					replace_all: { type: 'boolean', description: 'Replace all occurrences.' },
					thread_id: { type: 'string', description: 'Attach this edit to an existing comment thread.' }
				},
				required: ['path', 'old_string', 'new_string']
			},
			execute: async (input) => {
				const { path, old_string, new_string, replace_all, thread_id } = input as {
					path: string; old_string: string; new_string: string;
					replace_all?: boolean; thread_id?: string;
				};
				const replaceAll = replace_all === true;
				if (isScratchPath(path)) return toToolResult(editScratch(path, old_string, new_string, replaceAll));

				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const tabId = opened.tabId;

				if (typeof thread_id === 'string' && thread_id) {
					setActiveFeedbackThreadId(thread_id);
				}
				let failure: string | null = null;
				let appliedHits = 0;
				const result = await runTabWrite(tabId, 'agent_edit_doc', (currentMd) => {
					const hits = countOccurrences(currentMd, old_string);
					if (hits === 0) {
						failure = `old_string not found in ${path}. The user may have edited this area — read_doc to see the current state and retry.`;
						return null;
					}
					if (hits > 1 && !replaceAll) {
						failure = `old_string matches ${hits} locations in ${path}. Make it more specific or pass replace_all: true.`;
						return null;
					}
					appliedHits = hits;
					const afterMd = replaceAll
						? currentMd.split(old_string).join(new_string)
						: currentMd.replace(old_string, () => new_string);
					return {
						operation: { type: 'edit' as const, oldString: old_string, newString: new_string, ...(replaceAll ? { replaceAll: true } : {}) },
						afterMd
					};
				});
				if (typeof thread_id === 'string' && thread_id) {
					setActiveFeedbackThreadId(null);
				}
				if (failure) return { isError: true, content: [{ type: 'text' as const, text: failure }] };
				if ('error' in result) {
					return { isError: true, content: [{ type: 'text' as const, text: `edit_doc failed: ${result.error}` }] };
				}
				if (result.discarded) {
					return { content: [{ type: 'text' as const, text: `Edit discarded for ${path}: the user resolved this feedback thread.` }] };
				}
				return {
					content: [{
						type: 'text' as const,
						text: replaceAll
							? `Edit applied to ${path} (replaced ${appliedHits} occurrence${appliedHits === 1 ? '' : 's'}).`
							: `Edit applied to ${path}.`
					}]
				};
			}
		},
		{
			name: 'read_doc',
			description: 'Read the current content of an open tab or a scratch file.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Tab id, absolute path, or scratch path.' }
				},
				required: ['path']
			},
			execute: async (input) => {
				const { path } = input as { path: string };
				if (isScratchPath(path)) return toToolResult(readScratch(path));
				const tabId = resolveTabFromPath(path);
				if (tabId && isOpenTab(tabId)) {
					const ws = getHocuspocus();
					if (!ws) return { isError: true, content: [{ type: 'text' as const, text: 'WebSocket server not initialized.' }] };
					const direct = await ws.openDirectConnection(tabId);
					try {
						let content = '';
						await direct.transact((document) => {
							content = currentProposalText(document as unknown as Y.Doc);
						});
						return { content: [{ type: 'text' as const, text: content }] };
					} catch (err) {
						return { isError: true, content: [{ type: 'text' as const, text: `Failed to read ${path}: ${(err as Error).message}` }] };
					} finally {
						await direct.disconnect();
					}
				}
				const candidateTabId = tabId ?? pathToTabId(path);
				if (candidateTabId) {
					let absPath: string;
					try { absPath = resolveWorkspacePath(candidateTabId); } catch (err) {
						return { isError: true, content: [{ type: 'text' as const, text: `${path} cannot be read: ${(err as Error).message}` }] };
					}
					if (!existsSync(absPath)) {
						return { isError: true, content: [{ type: 'text' as const, text: `${path} does not exist.` }] };
					}
					try {
						return { content: [{ type: 'text' as const, text: readFileSync(absPath, 'utf8') }] };
					} catch (err) {
						return { isError: true, content: [{ type: 'text' as const, text: `Failed to read ${path}: ${(err as Error).message}` }] };
					}
				}
				return { isError: true, content: [{ type: 'text' as const, text: `${path} is not a valid workspace path or scratch path.` }] };
			}
		},
		{
			name: 'write_doc',
			description: 'Replace the full content of a workspace file or scratch file.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path or scratch path.' },
					content: { type: 'string', description: 'The new full content.' }
				},
				required: ['path', 'content']
			},
			execute: async (input) => {
				const { path, content } = input as { path: string; content: string };
				if (isScratchPath(path)) return toToolResult(writeScratch(path, content));
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: true });
				if (!opened.ok) return toToolResult(opened.error);
				const result = await runTabWrite(opened.tabId, 'agent_write_doc', () => ({
					operation: { type: 'write' as const, content },
					afterMd: content
				}));
				if ('error' in result) {
					return { isError: true, content: [{ type: 'text' as const, text: `write_doc failed: ${result.error}` }] };
				}
				return { content: [{ type: 'text' as const, text: `${opened.existedOnDisk ? 'Wrote' : 'Created'} ${content.length} chars to ${path}.` }] };
			}
		},
		{
			name: 'propose_rule',
			description: 'Propose a writing rule for the user to review.',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'The rule text.' },
					reason: { type: 'string', description: 'Why you are proposing this rule.' }
				},
				required: ['text']
			},
			execute: async () => ({ content: [{ type: 'text' as const, text: 'Rule proposal sent to the user for review.' }] })
		},
		{
			name: 'propose_hook',
			description: 'Propose a shell hook for the user to review.',
			inputSchema: {
				type: 'object',
				properties: {
					event: { type: 'string', description: 'Hook event type.' },
					matcher: { type: 'string', description: 'Regex over tool name.' },
					command: { type: 'string', description: 'Shell command.' },
					reason: { type: 'string', description: 'Explanation.' }
				},
				required: ['event', 'command']
			},
			execute: async () => ({ content: [{ type: 'text' as const, text: 'Hook proposal sent to the user for review.' }] })
		},
		{
			name: 'reply_to_comment',
			description: 'Reply on an existing comment thread.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					thread_id: { type: 'string' },
					message: { type: 'string' },
					proposed_edit: {
						type: 'object',
						properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
						required: ['old_string', 'new_string']
					}
				},
				required: ['path', 'thread_id', 'message']
			},
			execute: async (input) => {
				const { path, thread_id, message: msg, proposed_edit } = input as {
					path: string; thread_id: string; message: string;
					proposed_edit?: { old_string: string; new_string: string };
				};
				if (isScratchPath(path)) return { isError: true, content: [{ type: 'text' as const, text: 'reply_to_comment cannot be used on scratch paths.' }] };
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const trimmedMessage = msg.trim();
				if (!trimmedMessage) return { isError: true, content: [{ type: 'text' as const, text: 'reply_to_comment requires a non-empty message.' }] };
				const outcome = await runCommentWrite(opened.tabId, (doc) => {
					const commentsMap = getCommentsMap(doc);
					const now = Date.now();
					const newMessage: CommentMessage = {
						id: 'msg_' + cryptoRandomId(),
						author: 'agent',
						text: trimmedMessage,
						timestamp: now,
						...(proposed_edit ? { proposedEdit: { oldString: proposed_edit.old_string, newString: proposed_edit.new_string } } : {})
					};
					const existing = commentsMap.get(thread_id);
					if (!existing) return { ok: false as const, error: `Thread "${thread_id}" does not exist on ${path}.` };
					const updated: CommentThread = { ...existing, resolved: false, messages: [...existing.messages, newMessage] };
					doc.transact(() => commentsMap.set(thread_id, updated), AGENT_ORIGIN);
					return { ok: true as const };
				});
				if (!outcome.ok) return { isError: true, content: [{ type: 'text' as const, text: outcome.error }] };
				return { content: [{ type: 'text' as const, text: `Replied on thread ${thread_id} (${path}).` }] };
			}
		},
		{
			name: 'list_threads',
			description: 'Return all open (unresolved) comment threads for a workspace tab.',
			inputSchema: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path']
			},
			execute: async (input) => {
				const { path } = input as { path: string };
				if (isScratchPath(path)) return { isError: true, content: [{ type: 'text' as const, text: 'list_threads cannot be used on scratch paths.' }] };
				const tabId = resolveTabFromPath(path);
				if (!tabId || !isOpenTab(tabId)) {
					return { isError: true, content: [{ type: 'text' as const, text: `${path} is not an open tab.` }] };
				}
				const ws = getHocuspocus();
				if (!ws) return { isError: true, content: [{ type: 'text' as const, text: 'WebSocket server not initialized.' }] };
				const direct = await ws.openDirectConnection(tabId);
				let result = '';
				try {
					await direct.transact((document) => {
						const commentsMap = getCommentsMap(document as unknown as Y.Doc);
						const threads: CommentThread[] = [];
						commentsMap.forEach((t) => { if (!t.resolved) threads.push(t); });
						threads.sort((a, b) => a.createdAt - b.createdAt);
						if (threads.length === 0) { result = `No open threads on ${path}.`; return; }
						const lines: string[] = [`${threads.length} open thread${threads.length === 1 ? '' : 's'} on ${path}:\n`];
						for (const thread of threads) {
							lines.push(`Thread \`${thread.id}\` — anchor: "${thread.anchor.quote.slice(0, 120)}${thread.anchor.quote.length > 120 ? '…' : ''}"`);
							for (const m of thread.messages) {
								const role = m.author === 'agent' ? 'you' : 'user';
								lines.push(`  [${role}] ${m.text}`);
								if (m.proposedEdit) lines.push(`    proposed_edit: "${m.proposedEdit.oldString}" → "${m.proposedEdit.newString}"`);
							}
							lines.push('');
						}
						result = lines.join('\n');
					});
				} finally {
					await direct.disconnect();
				}
				return { content: [{ type: 'text' as const, text: result }] };
			}
		}
	];
}

/** Tool name constants for all providers (non-namespaced). */
export const TOOL_NAMES = {
	EDIT_DOC: 'edit_doc',
	READ_DOC: 'read_doc',
	WRITE_DOC: 'write_doc',
	PROPOSE_RULE: 'propose_rule',
	PROPOSE_HOOK: 'propose_hook',
	REPLY_TO_COMMENT: 'reply_to_comment',
	LIST_THREADS: 'list_threads'
} as const;
