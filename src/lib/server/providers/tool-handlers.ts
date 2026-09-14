/**
 * Provider-agnostic tool definitions. Each provider adapter imports these
 * and wraps them in its SDK's native tool format. The actual mutation logic
 * lives in mcp-doc-tools.ts; this module only defines the schema + handler
 * shape.
 */
import type { ToolDefinition, ToolResult } from './types';
import {
	runCommentWrite,
	editOpenTab,
	writeOpenTab,
	createAgentCommentThread,
	getHocuspocus,
	ensureWorkspaceTabOpen,
	readScratch,
	writeScratch,
	editScratch,
	pathToTabId,
	currentProposalText,
	applyReplyToComment,
	listTabThreads
} from '$lib/server/mcp-doc-tools';
import { isScratchPath, resolveTabFromPath, isOpenTab } from '$lib/server/path-router';
import { readFileSync, existsSync } from 'fs';
import * as Y from 'yjs';
import { normalizeTypography } from '$lib/shared/ydoc-codec';
import { formatListedThreads } from '$lib/shared/list-threads';
import { resolveWorkspacePath } from '$lib/server/workspace-path';
import { addCustomSkill, readEnabledSkill } from '$lib/server/skills-config';
import {
	resolveAllTabThreads,
	resolveTabThread,
	flushTabMarkdownNow,
	setThreadResolution
} from '$lib/server/ws-server';

function toToolResult(r: any): ToolResult {
	const textContent = (r.content ?? [])
		.filter((c: any) => c.type === 'text' && typeof c.text === 'string')
		.map((c: any) => ({ type: 'text' as const, text: c.text as string }));
	return { content: textContent, isError: r.isError };
}

function errorResult(text: string): ToolResult {
	return { isError: true, content: [{ type: 'text' as const, text }] };
}

function textResult(text: string): ToolResult {
	return { content: [{ type: 'text' as const, text }] };
}

export const REVIEW_ACTIONS = [
	'accept_thread',
	'accept_all',
	'reject_thread',
	'reject_all',
	'resolve_thread',
	'reopen_thread'
] as const;

export async function executeReviewAction(input: unknown): Promise<ToolResult> {
	const { file_path: path, action, thread_id } = input as {
		file_path?: string;
		action?: string;
		thread_id?: string;
	};
	if (!path) return errorResult('review_action requires `file_path`.');
	const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
	if (!opened.ok) return toToolResult(opened.error);
	const tabId = opened.tabId;

	try {
		if (action === 'accept_thread' || action === 'reject_thread') {
			if (!thread_id) return errorResult(`${action} requires \`thread_id\`.`);
			const outcome = action === 'accept_thread' ? 'accepted' : 'rejected';
			const result = await resolveTabThread(tabId, thread_id, outcome);
			if (!result.ok) return errorResult(`Thread "${thread_id}" was not found in ${path}.`);
			if (outcome === 'accepted') {
				try { flushTabMarkdownNow(tabId); } catch { /* best effort */ }
			}
			return textResult(
				result.hadProposal
					? `${outcome === 'accepted' ? 'Accepted' : 'Rejected'} the proposal on thread ${thread_id} in ${path}.`
					: `Thread ${thread_id} in ${path} had no pending proposal; it is now resolved.`
			);
		}
		if (action === 'accept_all' || action === 'reject_all') {
			const outcome = action === 'accept_all' ? 'accepted' : 'rejected';
			const result = await resolveAllTabThreads(tabId, outcome);
			if (outcome === 'accepted') {
				try { flushTabMarkdownNow(tabId); } catch { /* best effort */ }
			}
			return textResult(
				`${outcome === 'accepted' ? 'Accepted' : 'Rejected'} ${result.count} proposal${result.count === 1 ? '' : 's'} in ${path}.`
			);
		}
		if (action === 'resolve_thread' || action === 'reopen_thread') {
			if (!thread_id) return errorResult(`${action} requires \`thread_id\`.`);
			const result = await setThreadResolution(tabId, thread_id, action === 'resolve_thread');
			if (!result.ok) return errorResult(`Thread "${thread_id}" was not found in ${path}.`);
			return textResult(
				`${action === 'resolve_thread' ? 'Dismissed' : 'Reopened'} thread ${thread_id} in ${path}.`
			);
		}
		return errorResult(
			'Unknown review action. Use accept_thread, accept_all, reject_thread, reject_all, resolve_thread, or reopen_thread.'
		);
	} catch (err) {
		return errorResult(`review_action failed: ${(err as Error).message}`);
	}
}

export function buildToolDefinitions(): ToolDefinition[] {
	return [
		{
			name: 'edit_doc',
			description:
				'Replace `old_string` with `new_string` in the given file. For open tabs this lands as a pending proposal (tracked changes) under a comment thread; the document changes only when I accept it.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Workspace-relative tab id, absolute path, or scratch path.' },
					old_string: { type: 'string', description: 'Exact substring to replace.' },
					new_string: { type: 'string', description: 'The replacement string.' },
					replace_all: { type: 'boolean', description: 'Replace all occurrences.' },
					thread_id: {
						type: 'string',
						description:
							'The thread this edit belongs to: the id comment_doc returned, the feedback thread you are answering, or the thread whose proposal you are revising. A passage has one thread. Omit only when no thread is about this passage yet.'
					}
				},
				required: ['file_path', 'old_string', 'new_string']
			},
			execute: async (input) => {
				const { file_path: path, old_string, new_string, replace_all, thread_id } = input as {
					file_path: string; old_string: string; new_string: string;
					replace_all?: boolean; thread_id?: string;
				};
				if (!path) return errorResult('edit_doc requires `file_path`.');
				const replaceAll = replace_all === true;
				const normOld = normalizeTypography(old_string);
				const normNew = normalizeTypography(new_string);
				if (isScratchPath(path)) return toToolResult(editScratch(path, normOld, normNew, replaceAll));

				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				return toToolResult(
					await editOpenTab(
						path,
						opened.tabId,
						normOld,
						normNew,
						replaceAll,
						typeof thread_id === 'string' && thread_id ? thread_id : undefined
					)
				);
			}
		},
		{
			name: 'read_doc',
			description: 'Read the current content of an open tab (with pending proposals shown as if accepted) or a scratch file.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Tab id, absolute path, or scratch path.' }
				},
				required: ['file_path']
			},
			execute: async (input) => {
				const { file_path: path } = input as { file_path: string };
				if (!path) return errorResult('read_doc requires `file_path`.');
				if (isScratchPath(path)) return toToolResult(readScratch(path));
				const tabId = resolveTabFromPath(path);
				if (tabId && isOpenTab(tabId)) {
					const ws = getHocuspocus();
					if (!ws) return errorResult('WebSocket server not initialized.');
					const direct = await ws.openDirectConnection(tabId);
					try {
						let content = '';
						await direct.transact((document) => {
							content = currentProposalText(document as unknown as Y.Doc);
						});
						return textResult(content);
					} catch (err) {
						return errorResult(`Failed to read ${path}: ${(err as Error).message}`);
					} finally {
						await direct.disconnect();
					}
				}
				const candidateTabId = tabId ?? pathToTabId(path);
				if (candidateTabId) {
					let absPath: string;
					try { absPath = resolveWorkspacePath(candidateTabId); } catch (err) {
						return errorResult(`${path} cannot be read: ${(err as Error).message}`);
					}
					if (!existsSync(absPath)) return errorResult(`${path} does not exist.`);
					try {
						return textResult(readFileSync(absPath, 'utf8'));
					} catch (err) {
						return errorResult(`Failed to read ${path}: ${(err as Error).message}`);
					}
				}
				return errorResult(`${path} is not a valid workspace path or scratch path.`);
			}
		},
		{
			name: 'write_doc',
			description: 'Replace the full content of a workspace file (as a pending proposal) or scratch file.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Workspace-relative path or scratch path.' },
					content: { type: 'string', description: 'The new full content.' }
				},
				required: ['file_path', 'content']
			},
			execute: async (input) => {
				const { file_path: path, content } = input as { file_path: string; content: string };
				if (!path) return errorResult('write_doc requires `file_path`.');
				if (isScratchPath(path)) return toToolResult(writeScratch(path, content));
				const normalized = normalizeTypography(content);
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: true });
				if (!opened.ok) return toToolResult(opened.error);
				return toToolResult(await writeOpenTab(path, opened.tabId, normalized, !opened.existedOnDisk));
			}
		},
		{
			name: 'read_skill',
			description: 'Read the full instructions for an enabled DocWriter skill by name.',
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Skill name, e.g. plain-writing.' }
				},
				required: ['name']
			},
			execute: async (input) => {
				const { name } = input as { name: string };
				const skill = readEnabledSkill(name);
				if (!skill) return errorResult(`Skill "${name}" is not enabled or does not exist.`);
				return textResult(`Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`);
			}
		},
		{
			name: 'add_skill',
			description: 'Add an Agent Skill to DocWriter from a GitHub repository URL or local skill path.',
			inputSchema: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						description: 'A GitHub repository URL, local skill directory, or local SKILL.md path.'
					}
				},
				required: ['source']
			},
			execute: async (input) => {
				const { source } = input as { source: string };
				try {
					addCustomSkill(source);
					return textResult(
						`Added skill from ${source}. It is now enabled and synced to the native skill folders.`
					);
				} catch (err) {
					return errorResult(`add_skill failed: ${(err as Error).message}`);
				}
			}
		},
		{
			name: 'review_action',
			description:
				'Accept or reject a thread\'s pending proposal, or dismiss/reopen comment threads, ONLY when I explicitly ask. reopen_thread brings a dismissed thread back into the gutter — find its id with list_threads(include_dismissed=true).',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Workspace-relative path or absolute path inside the workspace.' },
					action: {
						type: 'string',
						enum: [...REVIEW_ACTIONS],
						description: 'The explicit review action I requested.'
					},
					thread_id: { type: 'string', description: 'Required for accept_thread, reject_thread, resolve_thread and reopen_thread.' }
				},
				required: ['file_path', 'action']
			},
			execute: executeReviewAction
		},
		{
			name: 'propose_rule',
			description: 'Propose a writing rule for me to review.',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'The rule text.' },
					reason: { type: 'string', description: 'Why you are proposing this rule.' },
					example_violation: {
						type: 'string',
						description:
							'A verbatim passage that breaks the rule, ideally from this session (a rejected edit, a sentence I flagged). Stored with the rule as a few-shot example.'
					}
				},
				required: ['text']
			},
			execute: async () => textResult('Rule proposal sent for review.')
		},
		{
			name: 'propose_hook',
			description: 'Propose a shell hook for me to review.',
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
			execute: async () => textResult('Hook proposal sent for review.')
		},
		{
			name: 'comment_doc',
			description:
				'Create a new agent comment thread anchored to existing text in a workspace document. It does not change document text. Use it as the announce thread before an edit proposal and pass the returned thread id to edit_doc; unprompted observations are allowed at Medium or High autonomy. A passage has one thread: anchoring on text another thread holds fails and names that thread.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string', description: 'Workspace-relative tab id or absolute path.' },
					anchor_text: { type: 'string', description: 'Exact current document text to anchor the comment to.' },
					message: { type: 'string', description: 'The comment text.' },
					occurrence_index: { type: 'number', description: 'Zero-based occurrence when anchor_text appears more than once.' },
					external_author: {
						type: 'string',
						description: 'Name of an external commenter when importing feedback. When set, the comment is attributed to that person.'
					}
				},
				required: ['file_path', 'anchor_text', 'message']
			},
			execute: async (input) => {
				const { file_path: path, anchor_text, message: msg, occurrence_index, external_author } = input as {
					file_path: string;
					anchor_text: string;
					message: string;
					occurrence_index?: number;
					external_author?: string;
				};
				if (!path) return errorResult('comment_doc requires `file_path`.');
				if (isScratchPath(path)) return errorResult('comment_doc cannot be used on scratch paths.');
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const anchorText = normalizeTypography(anchor_text.trim());
				const trimmedMessage = msg.trim();
				if (!anchorText) return errorResult('comment_doc requires non-empty anchor_text.');
				if (!trimmedMessage) return errorResult('comment_doc requires a non-empty message.');
				let threadId = '';
				const outcome = await runCommentWrite(opened.tabId, (doc) => {
					const created = createAgentCommentThread(
						doc,
						path,
						anchorText,
						occurrence_index,
						trimmedMessage,
						external_author
					);
					if (!created.ok) return created;
					threadId = created.threadId;
					return { ok: true as const };
				});
				if (!outcome.ok) return errorResult(outcome.error);
				return textResult(
					`Commented on ${path} in thread ${threadId}. Pass thread_id="${threadId}" to edit_doc for the edit this comment announces.`
				);
			}
		},
		{
			name: 'reply_to_comment',
			description:
				'Reply on an existing comment thread. When the reply says what you would change, propose that change with edit_doc on the same thread in this turn; a reply is never a substitute for the diff, and there is no separate approval step. Pass optional anchor_text to re-attach the thread to a new passage after the passage it was on is gone.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string' },
					thread_id: { type: 'string' },
					message: { type: 'string' },
					anchor_text: {
						type: 'string',
						description:
							'Exact current document text to move this thread onto. Use when the passage it was on is gone and you need to re-attach the conversation to the corresponding current passage.'
					},
					occurrence_index: {
						type: 'number',
						description: 'Zero-based occurrence when anchor_text appears more than once.'
					}
				},
				required: ['file_path', 'thread_id', 'message']
			},
			execute: async (input) => {
				const { file_path: path, thread_id, message: msg, anchor_text, occurrence_index } = input as {
					file_path: string; thread_id: string; message: string;
					anchor_text?: string;
					occurrence_index?: number;
				};
				if (!path) return errorResult('reply_to_comment requires `file_path`.');
				if (isScratchPath(path)) return errorResult('reply_to_comment cannot be used on scratch paths.');
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const trimmedMessage = msg.trim();
				if (!trimmedMessage) return errorResult('reply_to_comment requires a non-empty message.');
				let reanchored = false;
				const outcome = await runCommentWrite(opened.tabId, (doc) => {
					const result = applyReplyToComment(doc, thread_id, path, trimmedMessage, {
						anchorText: anchor_text ? normalizeTypography(anchor_text) : undefined,
						occurrenceIndex: occurrence_index
					});
					if (result.ok) reanchored = result.reanchored;
					return result;
				});
				if (!outcome.ok) return errorResult(outcome.error);
				return textResult(
					reanchored
						? `Replied on thread ${thread_id} (${path}) and re-attached it to the new passage.`
						: `Replied on thread ${thread_id} (${path}).`
				);
			}
		},
		{
			name: 'list_threads',
			description:
				'Return comment threads for a workspace tab, with every message in each. Defaults to open threads. Set include_dismissed=true to read threads I dismissed (they stay on the document, hidden from the gutter). Then review_action({ action: "reopen_thread", thread_id }) brings one back.',
			inputSchema: {
				type: 'object',
				properties: {
					file_path: { type: 'string' },
					include_dismissed: {
						type: 'boolean',
						description:
							'If true, also return dismissed (hidden) threads so you can reopen one. Use when I ask about a thread that disappeared or want one brought back.'
					}
				},
				required: ['file_path']
			},
			execute: async (input) => {
				const { file_path: path, include_dismissed } = input as {
					file_path: string;
					include_dismissed?: boolean;
				};
				if (!path) return errorResult('list_threads requires `file_path`.');
				if (isScratchPath(path)) return errorResult('list_threads cannot be used on scratch paths.');
				const tabId = resolveTabFromPath(path);
				if (!tabId || !isOpenTab(tabId)) return errorResult(`${path} is not an open tab.`);
				const ws = getHocuspocus();
				if (!ws) return errorResult('WebSocket server not initialized.');
				const direct = await ws.openDirectConnection(tabId);
				let result = '';
				try {
					await direct.transact((document) => {
						const { threads, quotes } = listTabThreads(document as unknown as Y.Doc);
						result = formatListedThreads(path, threads, include_dismissed === true, quotes);
					});
				} finally {
					await direct.disconnect();
				}
				return textResult(result);
			}
		}
	];
}

/** Tool name constants for all providers (non-namespaced). */
export const TOOL_NAMES = {
	EDIT_DOC: 'edit_doc',
	READ_DOC: 'read_doc',
	WRITE_DOC: 'write_doc',
	READ_SKILL: 'read_skill',
	ADD_SKILL: 'add_skill',
	REVIEW_ACTION: 'review_action',
	PROPOSE_RULE: 'propose_rule',
	PROPOSE_HOOK: 'propose_hook',
	COMMENT_DOC: 'comment_doc',
	REPLY_TO_COMMENT: 'reply_to_comment',
	LIST_THREADS: 'list_threads'
} as const;
