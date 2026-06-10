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
import { randomUUID } from 'node:crypto';

let sdkLoaded = false;
let Agent: any = null;
let run: any = null;
let tool: any = null;
let MemorySession: any = null;

async function loadSdk() {
	if (sdkLoaded) return;
	try {
		const sdk = await import('@openai/agents');
		Agent = sdk.Agent;
		run = sdk.run;
		tool = sdk.tool;
		const core = await import('@openai/agents-core');
		MemorySession = core.MemorySession;
		sdkLoaded = true;
	} catch (err) {
		throw new Error(
			'@openai/agents is not installed. Run: npm install @openai/agents\n' +
			(err as Error).message
		);
	}
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
	private session: any = null;
	// Stable across renders for this provider instance so the persisted
	// transcript (conversation_events) accumulates under one session id and
	// `/api/history` can read it back. The SDK's StreamedRunResult has no
	// usable id of its own.
	private sessionId: string | null = null;

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadSdk();

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();

		// Tool results aren't echoed in the raw model stream, so the execute
		// wrapper pushes them here; the event loop drains the queue and yields
		// them with the SDK call_id so the client can correlate to the call.
		const resultQueue: ProviderEvent[] = [];
		const agentTools = buildAgentTools(allTools, (callId, _name, text, isError) => {
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

		if (!this.session) {
			this.session = new MemorySession();
		}

		// Establish/reuse a stable session id and surface it BEFORE streaming so
		// the render endpoint persists every event under the same id the viewer
		// later reads. Prefer a resumed id from runtime state if one was passed.
		if (!this.sessionId) {
			this.sessionId = options.sessionId || `openai-${randomUUID()}`;
		}
		yield { type: 'session', sessionId: this.sessionId };

		const streamResult = await run(agent, options.prompt, {
			stream: true,
			session: this.session,
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

		for await (const event of streamResult) {
			// Flush any tool results produced since the last event.
			while (resultQueue.length) yield resultQueue.shift()!;

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
				if (callId && !started.has(callId)) {
					started.add(callId);
					yield { type: 'tool_call_start', tool_name: ci.name ?? 'unknown', tool_use_id: callId };
				}
			} else if (t === 'response.output_item.done' && inner.item?.type === 'function_call') {
				const ci = inner.item;
				const callId = ci.call_id || ci.id;
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

					if (toolName === 'propose_rule') {
						yield {
							type: 'rule_proposal',
							text: typeof input.text === 'string' ? input.text : '',
							reason: typeof input.reason === 'string' ? input.reason : undefined
						};
					} else if (toolName === 'propose_hook') {
						yield {
							type: 'hook_proposal',
							event: typeof input.event === 'string' ? input.event : 'PostToolUse',
							matcher: typeof input.matcher === 'string' ? input.matcher : undefined,
							command: typeof input.command === 'string' ? input.command : '',
							reason: typeof input.reason === 'string' ? input.reason : undefined
						};
					}
				}
			}
		}

		// Drain any results that landed after the final stream event.
		while (resultQueue.length) yield resultQueue.shift()!;

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
