/**
 * Claude Agent SDK provider adapter.
 *
 * Wraps `query()` from @anthropic-ai/claude-agent-sdk and normalizes its
 * streaming events into ProviderEvents. This is a direct extraction of the
 * event processing loop that was previously inline in /api/render.
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	CanUseToolFn
} from './types';
import { emitProposalEvents } from './shared';
import {
	docToolsMcp,
	EDIT_DOC_TOOL_NAME,
	WRITE_DOC_TOOL_NAME
} from '$lib/server/mcp-doc-tools';
import {
	createProviderSessionStore,
	hasProviderSessionEntries
} from '$lib/server/provider-session-store';
import {
	readHooks,
	type Hook
} from '$lib/server/hooks-config';
import { runHookCommand, type HookRunEmitter } from '$lib/server/hook-runner';
import { addCustomSkill } from '$lib/server/skills-config';
import { executeReviewAction } from './tool-handlers';
import {
	formatClaudeModelLabel,
	isHiddenClaudeModel
} from '$lib/shared/claude-models';

const PROPOSE_RULE_TOOL_NAME = 'mcp__docwriter__propose_rule';
const PROPOSE_HOOK_TOOL_NAME = 'mcp__docwriter__propose_hook';

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'claude' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'claude' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'claude' }
];

/** Build the in-process MCP server for propose_rule / propose_hook. */
function buildDocwriterMcp() {
	const tools: any[] = [
		tool(
			'propose_rule',
			'Propose a writing rule for the user to review. Follow the Proposing rules section: at most one per turn, and only with evidence.',
			{
				text: z.string().describe('The rule, a short imperative.'),
				reason: z.string().optional().describe('The evidence in one sentence, e.g. "you removed em dashes in three edits today".'),
				example_violation: z.string().optional().describe('A verbatim passage that breaks the rule, ideally from this session (a rejected edit, a sentence the user flagged). Stored with the rule as a few-shot example.')
			},
			async () => ({ content: [{ type: 'text', text: 'Rule proposal sent to the user for review.' }] })
		),
		tool(
			'propose_hook',
			'Propose a shell hook for the user to review.',
			{
				event: z.enum(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'Notification']).describe('When the hook fires.'),
				matcher: z.string().optional().describe('Regex over the tool name.'),
				command: z.string().describe('The shell command.'),
				reason: z.string().optional().describe('Explanation.')
			},
			async () => ({ content: [{ type: 'text', text: 'Hook proposal sent to the user for review.' }] })
		),
		tool(
			'add_skill',
			'Add an Agent Skill to DocWriter from a GitHub repository URL or local skill path.',
			{
				source: z.string().describe('A GitHub repository URL, local skill directory, or local SKILL.md path.')
			},
			async ({ source }) => {
				try {
					addCustomSkill(source);
					return {
						content: [{
							type: 'text',
							text: `Added skill from ${source}. It is now enabled and synced to native skill folders.`
						}]
					};
				} catch (err) {
					return {
						content: [{
							type: 'text',
							text: `add_skill failed: ${(err as Error).message}`
						}],
						isError: true
					};
				}
			}
		),
		tool(
			'review_action',
			'Accept or reject pending edits, or resolve or reopen comment threads, only when the user\'s current message explicitly asks for that action. This mutates document review state.',
			{
				file_path: z.string().describe('Workspace-relative path or absolute path inside the workspace.'),
				action: z.enum(['accept_round', 'accept_all', 'reject_round', 'reject_all', 'resolve_thread', 'reopen_thread']).describe('The explicit review action requested by the user.'),
				round_id: z.string().optional().describe('Required for accept_round or reject_round.'),
				thread_id: z.string().optional().describe('Required for resolve_thread or reopen_thread.')
			},
			async (input) => {
				const result = await executeReviewAction(input);
				return {
					content: result.content.map((c) => ({ type: 'text' as const, text: c.text })),
					...(result.isError ? { isError: true } : {})
				};
			}
		)
	];

	return createSdkMcpServer({
		name: 'docwriter',
		version: '0.0.1',
		tools
	});
}

async function* buildImagePrompt(
	textPrompt: string,
	images: Array<{ mediaType: string; data: string }>
): AsyncGenerator<SDKUserMessage> {
	const imageBlocks: ImageBlockParam[] = images.map((img) => ({
		type: 'image',
		source: { type: 'base64', media_type: img.mediaType as any, data: img.data }
	}));
	yield {
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'text', text: textPrompt }, ...imageBlocks]
		},
		parent_tool_use_id: null
	};
}

export class ClaudeProvider implements AgentProvider {
	readonly id = 'claude' as const;

	async *query(
		options: ProviderQueryOptions,
		_tools: any[]
	): AsyncIterable<ProviderEvent> {
		const docwriterMcp = buildDocwriterMcp();

		const canUseToolCb = options.canUseTool;

		const effectiveModel = options.model;
		const sessionStore = createProviderSessionStore('claude');
		const resumeSessionId =
			options.sessionId && hasProviderSessionEntries('claude', options.sessionId)
				? options.sessionId
				: undefined;
		const effort = options.effort || 'low';

		const queryOptions: any = {
			allowedTools: options.allowedTools,
			mcpServers: { docwriter: docwriterMcp, 'docwriter-doc': docToolsMcp },
			settingSources: ['user', 'project'],
			permissionMode: options.planMode ? 'plan' : 'acceptEdits',
			includePartialMessages: true,
			agentProgressSummaries: true,
			effort,
			// Sonnet 4.6+ reject thinking.type.enabled; adaptive is required.
			thinking: { type: 'adaptive' },
			...(options.abortSignal ? { abortController: { signal: options.abortSignal, abort() { /* unused */ } } } : {}),
			...(options.hooks ? { hooks: options.hooks } : {}),
			...(canUseToolCb ? {
				canUseTool: async (toolName: string, toolInput: any) => {
					const result = await canUseToolCb(toolName, toolInput);
					if (!result) return { behavior: 'allow' as const, updatedInput: toolInput };
					return result;
				}
			} : {}),
			...(effectiveModel ? { model: effectiveModel } : {}),
			sessionStore,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {})
		};

		const promptArg =
			options.images && options.images.length > 0
				? buildImagePrompt(options.prompt, options.images)
				: options.prompt;

		let currentToolName = '';
		let currentToolId = '';
		let toolInputAccum = '';

		for await (const msg of query({ prompt: promptArg, options: queryOptions })) {
			if (msg.type === 'system' && (msg as any).session_id) {
				yield { type: 'session', sessionId: (msg as any).session_id };
			}

			if (msg.type === 'system') {
				const anyMsg = msg as any;
				if (anyMsg.subtype === 'status') {
					yield { type: 'sdk_status', status: anyMsg.status, compactResult: anyMsg.compact_result, error: anyMsg.compact_error };
				} else if (anyMsg.subtype === 'notification') {
					yield { type: 'sdk_notification', text: anyMsg.text, priority: anyMsg.priority };
				} else if (anyMsg.subtype === 'task_started') {
					yield { type: 'task_event', taskId: anyMsg.task_id, phase: 'started', description: anyMsg.description, taskType: anyMsg.task_type };
				} else if (anyMsg.subtype === 'task_progress') {
					yield { type: 'task_event', taskId: anyMsg.task_id, phase: 'progress', description: anyMsg.description, summary: anyMsg.summary, lastToolName: anyMsg.last_tool_name };
				} else if (anyMsg.subtype === 'task_updated') {
					yield { type: 'task_event', taskId: anyMsg.task_id, phase: 'updated', description: anyMsg.patch?.description, summary: anyMsg.patch?.error, taskType: anyMsg.patch?.status };
				} else if (anyMsg.subtype === 'task_notification' && !anyMsg.skip_transcript) {
					yield { type: 'task_event', taskId: anyMsg.task_id, phase: anyMsg.status, summary: anyMsg.summary };
				}
			}

			if (msg.type === 'tool_progress') {
				const anyMsg = msg as any;
				yield { type: 'tool_progress', tool_name: anyMsg.tool_name, elapsedSeconds: anyMsg.elapsed_time_seconds, taskId: anyMsg.task_id };
			}

			if (msg.type === 'result') {
				const anyMsg = msg as any;
				yield {
					type: 'cost',
					totalCostUsd: anyMsg.total_cost_usd,
					durationMs: anyMsg.duration_ms,
					durationApiMs: anyMsg.duration_api_ms,
					numTurns: anyMsg.num_turns,
					usage: anyMsg.usage,
					subtype: anyMsg.subtype
				};
				// Surface failed runs. The CLI does not always exit non-zero
				// after an error result (in which case query() never throws),
				// so without this the render ends looking successful and the
				// failure — e.g. an expired-OAuth 401 — is completely silent.
				if (anyMsg.is_error || (anyMsg.subtype && anyMsg.subtype !== 'success')) {
					const detail =
						(anyMsg.subtype === 'success'
							? anyMsg.result
							: Array.isArray(anyMsg.errors) && anyMsg.errors.length > 0
								? anyMsg.errors.map((e: unknown) => String(e)).join('\n')
								: anyMsg.result) || `run failed (${anyMsg.subtype ?? 'unknown error'})`;
					yield { type: 'error', error: String(detail) };
				}
			}

			if (msg.type === 'user') {
				const anyMsg = msg as any;
				const content = anyMsg?.message?.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (block?.type !== 'tool_result') continue;
						let text = '';
						if (typeof block.content === 'string') {
							text = block.content;
						} else if (Array.isArray(block.content)) {
							text = block.content
								.map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
								.filter(Boolean)
								.join('\n');
						}
						yield { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: !!block.is_error, text };
					}
				}
			}

			if (msg.type === 'stream_event') {
				const event = (msg as any).event;
				if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
					currentToolName = event.content_block.name;
					currentToolId = event.content_block.id;
					toolInputAccum = '';
					if (currentToolName !== PROPOSE_RULE_TOOL_NAME && currentToolName !== PROPOSE_HOOK_TOOL_NAME) {
						yield { type: 'tool_call_start', tool_name: currentToolName, tool_use_id: currentToolId };
					}
				} else if (event.type === 'content_block_delta') {
					if (event.delta.type === 'text_delta') {
						yield { type: 'assistant_text', text: event.delta.text };
					} else if (event.delta.type === 'thinking_delta') {
						const text = event.delta.thinking;
						if (typeof text === 'string' && text) {
							yield { type: 'assistant_thinking', text };
						}
					} else if (event.delta.type === 'input_json_delta') {
						toolInputAccum += event.delta.partial_json;
					}
				} else if (event.type === 'content_block_stop') {
					if (currentToolName) {
						let parsedInput: Record<string, unknown> = {};
						try { parsedInput = JSON.parse(toolInputAccum); } catch { /* ignore */ }
						const proposals = emitProposalEvents(currentToolName, parsedInput);
						if (proposals.length > 0) {
							for (const proposal of proposals) yield proposal;
						} else {
							yield { type: 'tool_call', tool_name: currentToolName, tool_use_id: currentToolId, input: parsedInput };
						}
						currentToolName = '';
						currentToolId = '';
						toolInputAccum = '';
					}
				}
			}
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		try {
			const client = new Anthropic();
			const collected: Array<{ id: string; label: string; created: number }> = [];
			for await (const m of client.models.list({ limit: 1000 })) {
				const label = m.display_name || m.id;
				if (!m.id.startsWith('claude-') || isHiddenClaudeModel(m.id, label)) continue;
				collected.push({
					id: m.id,
					label: formatClaudeModelLabel(m.id, label, m.max_input_tokens),
					created: Date.parse(m.created_at) || 0
				});
			}
			if (collected.length === 0) return FALLBACK_MODELS;
			collected.sort((a, b) => b.created - a.created);
			return collected.map(({ id, label }) => ({ id, label, provider: 'claude' as const }));
		} catch {
			return FALLBACK_MODELS;
		}
	}
}
