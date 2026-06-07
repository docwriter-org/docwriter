/**
 * Cursor Agent SDK provider adapter.
 *
 * Uses @cursor/sdk's Agent.create() + agent.send() + run.stream() pattern.
 * Tools are registered via customTools on the local agent.
 */
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';
import { buildToolDefinitions } from './tool-handlers';

let Agent: any = null;
let Cursor: any = null;

async function loadCursorSdk() {
	if (Agent) return;
	try {
		const sdk = await import('@cursor/sdk');
		Agent = sdk.Agent;
		Cursor = sdk.Cursor ?? sdk;
	} catch (err) {
		throw new Error(
			'@cursor/sdk is not installed. Run: npm install @cursor/sdk\n' +
			(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'cursor' },
	{ id: 'gpt-4o', label: 'GPT-4o', provider: 'cursor' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'cursor' },
	{ id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', provider: 'cursor' },
	{ id: 'cursor-small', label: 'Cursor Small', provider: 'cursor' }
];

function buildCustomTools(
	tools: ToolDefinition[],
	onToolCall?: (name: string, input: Record<string, unknown>, result: any) => void
): Record<string, any> {
	const customTools: Record<string, any> = {};
	for (const t of tools) {
		customTools[t.name] = {
			description: t.description,
			inputSchema: t.inputSchema,
			async execute(input: Record<string, unknown>) {
				const result = await t.execute(input);
				onToolCall?.(t.name, input, result);
				const text = result.content.map((c) => c.text).join('\n');
				if (result.isError) {
					return { content: [{ type: 'text', text }], isError: true };
				}
				return text;
			}
		};
	}
	return customTools;
}

export class CursorProvider implements AgentProvider {
	readonly id = 'cursor' as const;
	private agent: any = null;
	private agentModel: string | null = null;

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadCursorSdk();

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();

		const toolCallResults: Array<{ name: string; input: Record<string, unknown>; result: any }> = [];
		const customTools = buildCustomTools(allTools, (name, input, result) => {
			toolCallResults.push({ name, input, result });
		});

		const model = options.model || 'composer-2.5';

		if (!this.agent || this.agentModel !== model) {
			this.agent = await Agent.create({
				apiKey: process.env.CURSOR_API_KEY,
				model: { id: model },
				local: {
					cwd: process.cwd(),
					customTools
				}
			});
			this.agentModel = model;
		}

		const fullPrompt = options.systemPrompt
			? `${options.systemPrompt}\n\n${options.prompt}`
			: options.prompt;

		const run = await this.agent.send(fullPrompt);

		if (run.id) {
			yield { type: 'session', sessionId: run.id };
		}

		let toolCallCounter = 0;
		for await (const event of run.stream()) {
			switch (event.type) {
				case 'assistant': {
					const content = event.message?.content;
					if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === 'text') {
								yield { type: 'assistant_text', text: block.text };
							}
						}
					}
					break;
				}
				case 'tool_call': {
					const callId = event.call_id || `cursor_tool_${++toolCallCounter}`;
					if (event.status === 'running') {
						yield { type: 'tool_call_start', tool_name: event.name, tool_use_id: callId };
						if (event.args) {
							const input = typeof event.args === 'object' ? event.args as Record<string, unknown> : {};
							yield { type: 'tool_call', tool_name: event.name, tool_use_id: callId, input };
						}
					} else if (event.status === 'completed' || event.status === 'error') {
						const text = typeof event.result === 'string'
							? event.result
							: JSON.stringify(event.result ?? '');
						yield {
							type: 'tool_result',
							tool_use_id: callId,
							is_error: event.status === 'error',
							text
						};
						// Emit rule/hook proposals if the tool was propose_rule or propose_hook
						if (event.name === 'propose_rule' && event.args) {
							const args = event.args as any;
							yield {
								type: 'rule_proposal',
								text: typeof args.text === 'string' ? args.text : '',
								reason: typeof args.reason === 'string' ? args.reason : undefined
							};
						} else if (event.name === 'propose_hook' && event.args) {
							const args = event.args as any;
							yield {
								type: 'hook_proposal',
								event: typeof args.event === 'string' ? args.event : 'PostToolUse',
								matcher: typeof args.matcher === 'string' ? args.matcher : undefined,
								command: typeof args.command === 'string' ? args.command : '',
								reason: typeof args.reason === 'string' ? args.reason : undefined
							};
						}
					}
					break;
				}
				case 'thinking': {
					yield { type: 'assistant_thinking', text: event.text };
					break;
				}
				case 'status': {
					yield {
						type: 'sdk_status',
						status: event.status || 'unknown',
						error: event.message
					};
					break;
				}
				case 'task': {
					yield {
						type: 'task_event',
						taskId: event.taskId || 'unknown',
						phase: event.phase || 'unknown',
						description: event.description,
						summary: event.summary
					};
					break;
				}
			}
		}

		// Emit cost info if available
		if (run.durationMs) {
			yield { type: 'cost', durationMs: run.durationMs };
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		try {
			await loadCursorSdk();
			if (Cursor?.models?.list) {
				const models = await Cursor.models.list();
				return models.map((m: any) => ({
					id: m.id,
					label: m.displayName || m.id,
					provider: 'cursor' as const
				}));
			}
		} catch {
			// Fall through to fallback
		}
		return FALLBACK_MODELS;
	}
}
