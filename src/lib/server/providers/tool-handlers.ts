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
	serializeYDoc,
	getCommentsMap,
	AGENT_ORIGIN,
	normalizeTypography,
	captureAnchorContext,
	nthIndexOf
} from '$lib/shared/ydoc-codec';
import type {
	CommentMessage,
	CommentThread
} from '$lib/types';
import { resolveWorkspacePath } from '$lib/server/workspace-path';
import { addCustomSkill, readEnabledSkill } from '$lib/server/skills-config';
import {
	acceptTabRounds,
	flushTabMarkdownNow,
	rejectTabRounds,
	setThreadResolution
} from '$lib/server/ws-server';

function toToolResult(r: any): ToolResult {
	const textContent = (r.content ?? [])
		.filter((c: any) => c.type === 'text' && typeof c.text === 'string')
		.map((c: any) => ({ type: 'text' as const, text: c.text as string }));
	return { content: textContent, isError: r.isError };
}

export async function executeReviewAction(input: unknown): Promise<ToolResult> {
	const { path, action, round_id, thread_id } = input as {
		path?: string;
		action?: string;
		round_id?: string;
		thread_id?: string;
	};
	if (!path) {
		return { isError: true, content: [{ type: 'text' as const, text: 'review_action requires `path`.' }] };
	}
	const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
	if (!opened.ok) return toToolResult(opened.error);
	const tabId = opened.tabId;

	try {
		if (action === 'accept_round' || action === 'accept_all') {
			if (action === 'accept_round' && !round_id) {
				return { isError: true, content: [{ type: 'text' as const, text: 'accept_round requires `round_id`.' }] };
			}
			const result = await acceptTabRounds(tabId, action === 'accept_round' ? round_id : undefined);
			try { flushTabMarkdownNow(tabId); } catch { /* best effort */ }
			return {
				content: [{
					type: 'text' as const,
					text: `Accepted ${result.acceptedCount} review edit${result.acceptedCount === 1 ? '' : 's'} in ${path}.`
				}]
			};
		}
		if (action === 'reject_round' || action === 'reject_all') {
			if (action === 'reject_round' && !round_id) {
				return { isError: true, content: [{ type: 'text' as const, text: 'reject_round requires `round_id`.' }] };
			}
			const result = await rejectTabRounds(tabId, action === 'reject_round' ? round_id : undefined);
			return {
				content: [{
					type: 'text' as const,
					text: `Rejected ${result.rejectedCount} review edit${result.rejectedCount === 1 ? '' : 's'} in ${path}.`
				}]
			};
		}
		if (action === 'resolve_thread' || action === 'reopen_thread') {
			if (!thread_id) {
				return { isError: true, content: [{ type: 'text' as const, text: `${action} requires \`thread_id\`.` }] };
			}
			const result = await setThreadResolution(tabId, thread_id, action === 'resolve_thread');
			if (!result.ok) {
				return { isError: true, content: [{ type: 'text' as const, text: `Thread "${thread_id}" was not found in ${path}.` }] };
			}
			return {
				content: [{
					type: 'text' as const,
					text: `${action === 'resolve_thread' ? 'Resolved' : 'Reopened'} thread ${thread_id} in ${path}.`
				}]
			};
		}
		return {
			isError: true,
			content: [{
				type: 'text' as const,
				text: 'Unknown review action. Use accept_round, accept_all, reject_round, reject_all, resolve_thread, or reopen_thread.'
			}]
		};
	} catch (err) {
		return {
			isError: true,
			content: [{
				type: 'text' as const,
				text: `review_action failed: ${(err as Error).message}`
			}]
		};
	}
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
				const normOld = normalizeTypography(old_string);
				const normNew = normalizeTypography(new_string);
				if (isScratchPath(path)) return toToolResult(editScratch(path, normOld, normNew, replaceAll));

				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const tabId = opened.tabId;

				if (typeof thread_id === 'string' && thread_id) {
					setActiveFeedbackThreadId(thread_id);
				}
				let failure: string | null = null;
				let appliedHits = 0;
				const result = await runTabWrite(tabId, 'agent_edit_doc', (currentMd) => {
					const hits = countOccurrences(currentMd, normOld);
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
						? currentMd.split(normOld).join(normNew)
						: currentMd.replace(normOld, () => normNew);
					return {
						operation: { type: 'edit' as const, oldString: normOld, newString: normNew, ...(replaceAll ? { replaceAll: true } : {}) },
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
				const normalized = normalizeTypography(content);
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: true });
				if (!opened.ok) return toToolResult(opened.error);
				const result = await runTabWrite(opened.tabId, 'agent_write_doc', () => ({
					operation: { type: 'write' as const, content: normalized },
					afterMd: normalized
				}));
				if ('error' in result) {
					return { isError: true, content: [{ type: 'text' as const, text: `write_doc failed: ${result.error}` }] };
				}
				return { content: [{ type: 'text' as const, text: `${opened.existedOnDisk ? 'Wrote' : 'Created'} ${content.length} chars to ${path}.` }] };
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
				if (!skill) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: `Skill "${name}" is not enabled or does not exist.` }]
					};
				}
				return {
					content: [{
						type: 'text' as const,
						text: `Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`
					}]
				};
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
					return {
						content: [{
							type: 'text' as const,
							text: `Added skill from ${source}. It is now enabled and synced to the native skill folders.`
						}]
					};
				} catch (err) {
					return {
						isError: true,
						content: [{
							type: 'text' as const,
							text: `add_skill failed: ${(err as Error).message}`
						}]
					};
				}
			}
		},
		{
			name: 'review_action',
			description:
				'Accept/reject pending review edits or resolve/reopen comment threads ONLY when the user explicitly asks you to do that action. This mutates document review state.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path or absolute path inside the workspace.' },
					action: {
						type: 'string',
						enum: ['accept_round', 'accept_all', 'reject_round', 'reject_all', 'resolve_thread', 'reopen_thread'],
						description: 'The explicit review action requested by the user.'
					},
					round_id: { type: 'string', description: 'Required for accept_round or reject_round.' },
					thread_id: { type: 'string', description: 'Required for resolve_thread or reopen_thread.' }
				},
				required: ['path', 'action']
			},
			execute: executeReviewAction
		},
		{
			name: 'propose_rule',
			description: 'Propose a writing rule for the user to review.',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'The rule text.' },
					reason: { type: 'string', description: 'Why you are proposing this rule.' },
					example_violation: {
						type: 'string',
						description:
							'A verbatim passage that breaks the rule, ideally from this session (a rejected edit, a sentence the user flagged). Stored with the rule as a few-shot example.'
					}
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
			name: 'comment_doc',
			description:
				'Create a new agent comment thread anchored to existing text in a workspace document. It does not change document text. In Medium autonomy, use this to create comment threads on your own, but do not propose edits unless asked.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative tab id or absolute path.' },
					anchor_text: { type: 'string', description: 'Exact current document text to anchor the comment to.' },
					message: { type: 'string', description: 'The comment text.' },
					occurrence_index: { type: 'number', description: 'Zero-based occurrence when anchor_text appears more than once.' },
					proposed_edit: {
						type: 'object',
						description:
							'Optional concrete edit the user can approve. Use only when the user directly asked for an edit or autonomy is High.',
						properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
						required: ['old_string', 'new_string']
					}
				},
				required: ['path', 'anchor_text', 'message']
			},
			execute: async (input) => {
				const { path, anchor_text, message: msg, occurrence_index, proposed_edit } = input as {
					path: string;
					anchor_text: string;
					message: string;
					occurrence_index?: number;
					proposed_edit?: { old_string: string; new_string: string };
				};
				if (isScratchPath(path)) return { isError: true, content: [{ type: 'text' as const, text: 'comment_doc cannot be used on scratch paths.' }] };
				const opened = ensureWorkspaceTabOpen(path, { createIfMissing: false });
				if (!opened.ok) return toToolResult(opened.error);
				const anchorText = anchor_text.trim();
				const trimmedMessage = msg.trim();
				if (!anchorText) return { isError: true, content: [{ type: 'text' as const, text: 'comment_doc requires non-empty anchor_text.' }] };
				if (!trimmedMessage) return { isError: true, content: [{ type: 'text' as const, text: 'comment_doc requires a non-empty message.' }] };
				let threadId = '';
				const outcome = await runCommentWrite(opened.tabId, (doc) => {
					const liveText = serializeYDoc(doc);
					const hits = countOccurrences(liveText, anchorText);
					if (hits === 0) {
						return { ok: false as const, error: `anchor_text was not found in ${path}.` };
					}
					if (hits > 1 && occurrence_index === undefined) {
						return { ok: false as const, error: `anchor_text matches ${hits} locations in ${path}. Pass occurrence_index to choose one.` };
					}
					const occurrence = occurrence_index ?? 0;
					if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= hits) {
						return { ok: false as const, error: `occurrence_index ${occurrence} is out of range; anchor_text appears ${hits} time${hits === 1 ? '' : 's'}.` };
					}
					const commentsMap = getCommentsMap(doc);
					const now = Date.now();
					threadId = 'thread_' + cryptoRandomId();
					// Snapshot the anchor's surroundings (same as the Claude-path
					// comment tools) so the client's quote fallback can tell "this
					// text came back" (undo) apart from "the same string appears
					// somewhere else" once the passage is deleted.
					const anchorIdx = nthIndexOf(liveText, anchorText, occurrence);
					const thread: CommentThread = {
						id: threadId,
						anchor: {
							quote: anchorText,
							occurrenceIndex: occurrence,
							...(anchorIdx >= 0
								? captureAnchorContext(liveText, anchorIdx, anchorText.length)
								: {})
						},
						messages: [{
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
						}],
						resolved: false,
						createdAt: now
					};
					doc.transact(() => commentsMap.set(threadId, thread), AGENT_ORIGIN);
					return { ok: true as const };
				});
				if (!outcome.ok) return { isError: true, content: [{ type: 'text' as const, text: outcome.error }] };
				return { content: [{ type: 'text' as const, text: `Commented on ${path} in thread ${threadId}.` }] };
			}
		},
		{
			name: 'reply_to_comment',
			description:
				'Reply on an existing comment thread. Include proposed_edit only when the user directly asked for an edit or autonomy is High.',
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
	READ_SKILL: 'read_skill',
	ADD_SKILL: 'add_skill',
	REVIEW_ACTION: 'review_action',
	PROPOSE_RULE: 'propose_rule',
	PROPOSE_HOOK: 'propose_hook',
	COMMENT_DOC: 'comment_doc',
	REPLY_TO_COMMENT: 'reply_to_comment',
	LIST_THREADS: 'list_threads'
} as const;
