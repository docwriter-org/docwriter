/**
 * OpenAI Agents SDK provider adapter.
 *
 * Uses @openai/agents with Agent + run() + streaming. Tools are registered
 * as FunctionTools on the Agent. The SDK handles the agent loop, tool
 * calling, and streaming events natively.
 */
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';
import { buildToolDefinitions } from './tool-handlers';

let sdkLoaded = false;
let Agent: any = null;
let run: any = null;
let tool: any = null;

async function loadSdk() {
	if (sdkLoaded) return;
	try {
		const sdk = await import('@openai/agents');
		Agent = sdk.Agent;
		run = sdk.run;
		tool = sdk.tool;
		sdkLoaded = true;
	} catch (err) {
		throw new Error(
			'@openai/agents is not installed. Run: npm install @openai/agents\n' +
			(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
	{ id: 'o4-mini', label: 'o4-mini', provider: 'openai' },
	{ id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' }
];

function buildAgentTools(defs: ToolDefinition[]): any[] {
	return defs.map((def) =>
		tool({
			name: def.name,
			description: def.description,
			parameters: def.inputSchema,
			execute: async (_ctx: any, args: any) => {
				const result = await def.execute(args);
				const text = result.content.map((c) => c.text).join('\n');
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
		const agentTools = buildAgentTools(allTools);

		const model = options.model || 'gpt-4o';

		const instructions = options.systemPrompt
			? options.systemPrompt
			: 'You are a helpful writing assistant.';

		const agent = new Agent({
			name: 'docwriter',
			model,
			instructions,
			tools: agentTools
		});

		const streamResult = await run(agent, options.prompt, { stream: true });

		if (streamResult.id) {
			yield { type: 'session', sessionId: streamResult.id };
		}

		let toolCallCounter = 0;

		for await (const event of streamResult) {
			if (event.type === 'run_item_stream_event') {
				const item = event.item;
				const name = event.name;

				if (item.type === 'message_output_item') {
					const content = item.rawItem?.content;
					if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === 'output_text' && block.text) {
								yield { type: 'assistant_text', text: block.text };
							}
						}
					}
				}

				if (item.type === 'tool_call_item') {
					const callId = item.rawItem?.call_id || item.rawItem?.id || `oai_tool_${++toolCallCounter}`;
					const toolName = item.rawItem?.name || 'unknown';
					let toolInput: Record<string, unknown> = {};
					try {
						const rawArgs = item.rawItem?.arguments;
						toolInput = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
					} catch { /* ignore */ }

					if (name === 'tool_called') {
						yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
						yield { type: 'tool_call', tool_name: toolName, tool_use_id: callId, input: toolInput };

						if (toolName === 'propose_rule') {
							yield {
								type: 'rule_proposal',
								text: typeof toolInput.text === 'string' ? toolInput.text : '',
								reason: typeof toolInput.reason === 'string' ? toolInput.reason : undefined
							};
						} else if (toolName === 'propose_hook') {
							yield {
								type: 'hook_proposal',
								event: typeof toolInput.event === 'string' ? toolInput.event : 'PostToolUse',
								matcher: typeof toolInput.matcher === 'string' ? toolInput.matcher : undefined,
								command: typeof toolInput.command === 'string' ? toolInput.command : '',
								reason: typeof toolInput.reason === 'string' ? toolInput.reason : undefined
							};
						}
					}
				}

				if (item.type === 'tool_call_output_item') {
					const callId = item.rawItem?.call_id || `oai_tool_${toolCallCounter}`;
					const output = item.rawItem?.output;
					const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
					yield {
						type: 'tool_result',
						tool_use_id: callId,
						is_error: false,
						text
					};
				}

				if (item.type === 'reasoning_item') {
					const text = item.rawItem?.summary
						?? (Array.isArray(item.rawItem?.content)
							? item.rawItem.content.map((c: any) => c.text ?? '').join('')
							: '');
					if (text) {
						yield { type: 'assistant_thinking', text };
					}
				}
			}

			if (event.type === 'raw_model_stream_event') {
				const data = event.data;
				if (data?.type === 'response.output_text.delta' && data.delta) {
					yield { type: 'assistant_text', text: data.delta };
				}
			}
		}

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
