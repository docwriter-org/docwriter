/**
 * Provider-agnostic tool definitions. Each provider adapter imports these
 * and wraps them in its SDK's native tool format. The document tools come
 * from `DOC_TOOLS` in mcp-doc-tools.ts, the same definitions Claude uses, so
 * every provider gets the same descriptions, schemas and handlers.
 */
import type { ToolDefinition, ToolResult } from './types';
import { z } from 'zod';
import { DOC_TOOLS, ensureWorkspaceTabOpen } from '$lib/server/mcp-doc-tools';
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

/** Optional arguments sometimes arrive as null from models that fill every
 *  field; treat those as omitted before validating. */
function dropNullFields(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== null));
}

/** Adapt a `docwriter-doc` MCP tool to the provider-agnostic shape, so every
 *  provider sees the same description and schema and runs the same handler. */
function docToolDefinition(def: (typeof DOC_TOOLS)[number]): ToolDefinition {
	const schema = z.object(def.inputSchema);
	const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
	return {
		name: def.name,
		description: def.description,
		inputSchema,
		execute: async (input) => {
			const parsed = schema.safeParse(dropNullFields(input));
			if (!parsed.success) {
				return errorResult(`${def.name} received invalid arguments: ${z.prettifyError(parsed.error)}`);
			}
			const handler = def.handler as (args: unknown, extra: unknown) => ReturnType<typeof def.handler>;
			return toToolResult(await handler(parsed.data, undefined));
		}
	};
}

/** Tools that only the non-Claude providers get from this module. Claude
 *  gets its versions from the `docwriter` MCP server in providers/claude.ts. */
function otherToolDefinitions(): ToolDefinition[] {
	return [
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
		}
	];
}

/** The order the tools are offered in, unchanged from when each provider
 *  had its own copy of the document tools. */
const TOOL_ORDER = [
	'edit_doc',
	'read_doc',
	'write_doc',
	'read_skill',
	'add_skill',
	'review_action',
	'propose_rule',
	'propose_hook',
	'comment_doc',
	'reply_to_comment',
	'list_threads'
];

export function buildToolDefinitions(): ToolDefinition[] {
	const docTools = new Map(DOC_TOOLS.map((def) => [def.name, docToolDefinition(def)] as const));
	const otherTools = new Map(otherToolDefinitions().map((def) => [def.name, def] as const));
	return TOOL_ORDER.map((name) => docTools.get(name) ?? otherTools.get(name)).filter(
		(def): def is ToolDefinition => def !== undefined
	);
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
