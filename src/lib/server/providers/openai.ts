/**
 * OpenAI Agents SDK provider adapter.
 *
 * Uses @openai/agents with Agent + run() + streaming against the standard
 * OpenAI API. Requires OPENAI_API_KEY. The ChatGPT/Codex login path lives in
 * the separate `codex` provider (codex.ts) — this provider is pure agents-SDK.
 */
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';
import { buildToolDefinitions } from './tool-handlers';
import { emitProposalEvents, makeLazySdkLoader, wrapToolsForProvider } from './shared';
import { randomUUID } from 'node:crypto';
import { DocWriterOpenAISession } from './openai-session';

let Agent: any = null;
let run: any = null;
let tool: any = null;

const importAgentsSdk = makeLazySdkLoader(
	() => import('@openai/agents'),
	'@openai/agents is not installed. Run: npm install @openai/agents'
);

async function loadSdk() {
	// importAgentsSdk (makeLazySdkLoader) already memoizes the dynamic import,
	// so re-destructuring here on a warm cache is idempotent and cheap.
	const sdk = await importAgentsSdk();
	Agent = sdk.Agent;
	run = sdk.run;
	tool = sdk.tool;
}

// Current OpenAI frontier + reasoning models (newest first), per
// developers.openai.com/api/docs/models as of 2026-06.
const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'codex-mini', label: 'Codex Mini', provider: 'openai' },
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
	{ id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', provider: 'openai' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'openai' },
	{ id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', provider: 'openai' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai' },
	{ id: 'o3', label: 'o3', provider: 'openai' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' }
];

/** Called after each tool finishes, with the SDK call_id for correlation. */
type ToolResultSink = (callId: string, name: string, text: string, isError: boolean) => void;

function buildAgentTools(defs: ToolDefinition[], onResult: ToolResultSink): any[] {
	return defs.map((def) =>
		tool({
			name: def.name,
			description: def.description,
			parameters: def.inputSchema,
			strict: false,
			// The SDK passes (input, runContext, details); details.toolCall.call_id
			// lets us correlate the result back to the streamed tool_call.
			execute: async (input: any, _ctx?: any, details?: any) => {
				const callId = details?.toolCall?.call_id ?? details?.toolCall?.id ?? '';
				const result = await def.execute(input);
				const text = result.content.map((c) => c.text).join('\n');
				onResult(callId, def.name, text, !!result.isError);
				if (result.isError) throw new Error(text);
				return text;
			}
		})
	);
}

export class OpenAIAgentsProvider implements AgentProvider {
	readonly id = 'openai' as const;

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadSdk();

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();
		// Filter to options.allowedTools and gate each execute through
		// options.canUseTool before registering with the Agents SDK (plan-mode
		// mutation-tool blocking + scratch-only Edit/Write guard).
		const providerTools = wrapToolsForProvider(allTools, options);

		// Tool results aren't echoed in the raw model stream, so the execute
		// wrapper pushes them here; the event loop drains the queue and yields
		// them with the SDK call_id so the client can correlate to the call.
		const resultQueue: ProviderEvent[] = [];
		const agentTools = buildAgentTools(providerTools, (callId, _name, text, isError) => {
			resultQueue.push({ type: 'tool_result', tool_use_id: callId, is_error: isError, text });
		});

		const model = options.model || 'gpt-5.5';

		const instructions = options.systemPrompt
			? options.systemPrompt
			: 'You are a helpful writing assistant.';

		const agent = new Agent({
			name: 'docwriter',
			model,
			instructions,
			tools: agentTools
		});

		// Establish/reuse a stable session id and surface it BEFORE streaming so
		// the render endpoint persists every event under the same id the viewer
		// later reads. Prefer a resumed id from runtime state if one was passed.
		const sessionId = options.sessionId || `openai-${randomUUID()}`;
		const session = new DocWriterOpenAISession(sessionId);
		yield { type: 'session', sessionId };

		const streamResult = await run(agent, options.prompt, {
			stream: true,
			session,
			// SDK default is 10; a read→edit→verify writing loop blows past that.
			maxTurns: 50
		});

		// On the ChatGPT/Codex backend the SDK never delivers the high-level
		// `run_item_stream_event`s — only `raw_model_stream_event`s wrapping the
		// OpenAI Responses SSE event (in `data.event`). So we derive tool calls,
		// assistant text, and reasoning from the raw stream directly. This also
		// works on the public OpenAI API, which streams the same raw events.
		const started = new Set<string>(); // call_ids we've emitted tool_call_start for
		const completed = new Set<string>(); // call_ids we've emitted tool_call for
		const toolCallAliases = new Map<string, string>(); // response item id -> call_id

		function normalizeQueuedEvent(event: ProviderEvent): ProviderEvent {
			if (event.type !== 'tool_result') return event;
			return {
				...event,
				tool_use_id: toolCallAliases.get(event.tool_use_id) ?? event.tool_use_id
			};
		}

		for await (const event of streamResult) {
			if (options.abortSignal?.aborted) {
				yield { type: 'error', error: 'Aborted' };
				return;
			}
			// Flush any tool results produced since the last event.
			while (resultQueue.length) yield normalizeQueuedEvent(resultQueue.shift()!);

			if (event.type !== 'raw_model_stream_event') continue;
			const inner = (event as any).data?.event; // the OpenAI Responses SSE event
			const t = inner?.type;
			if (!t) continue;

			if (t === 'response.output_text.delta' && inner.delta) {
				yield { type: 'assistant_text', text: inner.delta };
			} else if (
				(t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') &&
				inner.delta
			) {
				yield { type: 'assistant_thinking', text: inner.delta };
			} else if (t === 'response.output_item.added' && inner.item?.type === 'function_call') {
				const ci = inner.item;
				const callId = ci.call_id || ci.id;
				if (ci.id && callId) toolCallAliases.set(ci.id, callId);
				if (ci.call_id && callId) toolCallAliases.set(ci.call_id, callId);
				if (callId && !started.has(callId)) {
					started.add(callId);
					yield { type: 'tool_call_start', tool_name: ci.name ?? 'unknown', tool_use_id: callId };
				}
			} else if (t === 'response.output_item.done' && inner.item?.type === 'function_call') {
				const ci = inner.item;
				const callId = ci.call_id || ci.id;
				if (ci.id && callId) toolCallAliases.set(ci.id, callId);
				if (ci.call_id && callId) toolCallAliases.set(ci.call_id, callId);
				const toolName = ci.name ?? 'unknown';
				let input: Record<string, unknown> = {};
				try {
					input = typeof ci.arguments === 'string' ? JSON.parse(ci.arguments || '{}') : ci.arguments || {};
				} catch { /* malformed args — leave empty */ }

				if (callId && !started.has(callId)) {
					started.add(callId);
					yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
				}
				if (callId && !completed.has(callId)) {
					completed.add(callId);
					yield { type: 'tool_call', tool_name: toolName, tool_use_id: callId, input };

					for (const proposal of emitProposalEvents(toolName, input)) yield proposal;
				}
			}
		}

		// Drain any results that landed after the final stream event.
		while (resultQueue.length) yield normalizeQueuedEvent(resultQueue.shift()!);

		// Emit cost/usage info from the final result
		try {
			const finalResult = await streamResult;
			if (finalResult?.usage) {
				yield {
					type: 'cost',
					usage: finalResult.usage,
					numTurns: finalResult.rawResponses?.length ?? 1
				};
			}
		} catch {
			// Stream already consumed
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		return FALLBACK_MODELS;
	}
}
