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
import {
	combinePrompt,
	emitProposalEvents,
	makeLazySdkLoader,
	staleSessionEvent,
	wrapToolsForProvider
} from './shared';
import { getEffectiveRoot } from '$lib/server/document-files';
import { DocWriterCursorLocalAgentStore } from './cursor-store';

/** Cursor wraps custom-tool results in a synthetic-MCP envelope, e.g.
 * `{status, value:{content:[{text:{text:"…"}}], isError}}` or
 * `{content:[{type:'text', text:"…"}]}`. Pull the readable text out so the
 * transcript/history show the tool output instead of a JSON blob. */
function extractCursorResultText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	const r = result as Record<string, any>;
	const value = r.value ?? r;
	const content = value?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c: any) => (typeof c?.text === 'string' ? c.text : c?.text?.text ?? ''))
			.filter(Boolean)
			.join('\n');
		if (text) return text;
	}
	if (typeof value?.text === 'string') return value.text;
	return JSON.stringify(result);
}

let Agent: any = null;
let Cursor: any = null;

const importCursorSdk = makeLazySdkLoader(
	() => import('@cursor/sdk'),
	'@cursor/sdk is not installed. Run: npm install @cursor/sdk'
);

async function loadCursorSdk() {
	if (Agent) return;
	const sdk = await importCursorSdk();
	Agent = sdk.Agent;
	Cursor = sdk.Cursor ?? sdk;
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'composer-2.5', label: 'Composer 2.5', provider: 'cursor' },
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

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadCursorSdk();

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();
		// Filter to options.allowedTools and gate each execute through
		// options.canUseTool before registering as Cursor custom tools.
		const providerTools = wrapToolsForProvider(allTools, options);

		const toolCallResults: Array<{ name: string; input: Record<string, unknown>; result: any }> = [];
		const customTools = buildCustomTools(providerTools, (name, input, result) => {
			toolCallResults.push({ name, input, result });
		});

		const model = options.model || 'composer-2.5';
		const cwd = getEffectiveRoot();
		const store = new DocWriterCursorLocalAgentStore();
		const agentOptions = {
			apiKey: process.env.CURSOR_API_KEY,
			model: { id: model },
			local: {
				cwd,
				store,
				customTools
			}
		};

		let agent: any = null;
		let resumeFailed = false;
		if (options.sessionId) {
			try {
				agent = await Agent.resume(options.sessionId, agentOptions);
			} catch {
				resumeFailed = true;
			}
		}
		if (!agent) agent = await Agent.create(agentOptions);

		const fullPrompt = combinePrompt(options);

		if (resumeFailed) {
			yield staleSessionEvent('Cursor agent');
		}
		yield { type: 'session', sessionId: agent.agentId };

		const run = await agent.send(fullPrompt, {
			model: { id: model },
			local: { customTools }
		});

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
					// Cursor routes our custom tools through a synthetic MCP server,
					// so the event arrives as name:"mcp" with the real tool in
					// args.toolName and the real input in args.args. Unwrap it so
					// downstream sees edit_doc / read_doc / propose_rule etc.
					const rawArgs =
						event.args && typeof event.args === 'object' ? (event.args as Record<string, any>) : {};
					const isMcp = event.name === 'mcp' && typeof rawArgs.toolName === 'string';
					const toolName: string = isMcp ? rawArgs.toolName : event.name;
					const toolInput: Record<string, unknown> = isMcp
						? rawArgs.args && typeof rawArgs.args === 'object'
							? rawArgs.args
							: {}
						: (rawArgs as Record<string, unknown>);

					if (event.status === 'running') {
						yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
						yield { type: 'tool_call', tool_name: toolName, tool_use_id: callId, input: toolInput };
					} else if (event.status === 'completed' || event.status === 'error') {
						const resultVal = event.result as any;
						const text = extractCursorResultText(resultVal);
						const isError = event.status === 'error' || resultVal?.value?.isError === true || resultVal?.isError === true;
						yield {
							type: 'tool_result',
							tool_use_id: callId,
							is_error: isError,
							text
						};
						// Emit rule/hook proposals if the tool was propose_rule or propose_hook
						for (const proposal of emitProposalEvents(toolName, toolInput)) yield proposal;
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
