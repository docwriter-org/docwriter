/**
 * OpenAI Codex SDK provider adapter.
 *
 * Uses @openai/codex-sdk's thread-based model: Codex → startThread() →
 * thread.runStreamed(). Tools are provided to the Codex CLI process which
 * handles tool calling internally.
 */
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';
import { buildToolDefinitions } from './tool-handlers';

let Codex: any = null;

async function loadCodexSdk() {
	if (Codex) return;
	try {
		const sdk = await import('@openai/codex-sdk');
		Codex = sdk.Codex;
	} catch (err) {
		throw new Error(
			'@openai/codex-sdk is not installed. Run: npm install @openai/codex-sdk\n' +
			(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'codex-mini-latest', label: 'Codex Mini', provider: 'openai' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
	{ id: 'o4-mini', label: 'o4-mini', provider: 'openai' },
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' }
];

export class CodexProvider implements AgentProvider {
	readonly id = 'openai' as const;
	private codex: any = null;
	private thread: any = null;
	private threadId: string | null = null;

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadCodexSdk();

		if (!this.codex) {
			this.codex = new Codex({
				...(options.model ? { config: { model: options.model } } : {})
			});
		}

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();

		// Build tool handlers map for intercepting tool calls
		const toolMap = new Map(allTools.map((t) => [t.name, t]));

		if (options.sessionId && !this.thread) {
			try {
				this.thread = this.codex.resumeThread(options.sessionId);
				this.threadId = options.sessionId;
			} catch {
				// Fall through to creating a new thread
			}
		}

		if (!this.thread) {
			this.thread = this.codex.startThread({
				workingDirectory: process.cwd()
			});
			this.threadId = null;
		}

		const fullPrompt = options.systemPrompt
			? `${options.systemPrompt}\n\n${options.prompt}`
			: options.prompt;

		const input = options.images && options.images.length > 0
			? [
				{ type: 'text', text: fullPrompt },
				...options.images.map((img) => ({
					type: 'local_image',
					path: `data:${img.mediaType};base64,${img.data}`
				}))
			]
			: fullPrompt;

		let toolCallCounter = 0;

		try {
			for await (const event of this.thread.runStreamed(input)) {
				// Capture thread ID from the first event
				if (!this.threadId && event.thread_id) {
					this.threadId = event.thread_id;
					yield { type: 'session', sessionId: event.thread_id };
				}

				if (event.type === 'item.completed' && event.item) {
					const item = event.item;

					if (item.type === 'message' && item.role === 'assistant') {
						const content = item.content;
						if (Array.isArray(content)) {
							for (const block of content) {
								if (block.type === 'output_text') {
									yield { type: 'assistant_text', text: block.text };
								} else if (block.type === 'refusal') {
									yield { type: 'assistant_text', text: `[Refused: ${block.refusal}]` };
								}
							}
						}
					}

					if (item.type === 'function_call' || item.type === 'tool_use') {
						const callId = item.call_id || item.id || `codex_tool_${++toolCallCounter}`;
						const toolName = item.name || item.function?.name || 'unknown';
						let toolInput: Record<string, unknown> = {};
						try {
							const rawArgs = item.arguments || item.function?.arguments;
							toolInput = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
						} catch { /* ignore */ }

						yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
						yield { type: 'tool_call', tool_name: toolName, tool_use_id: callId, input: toolInput };

						// Execute the tool if we have a handler
						const handler = toolMap.get(toolName);
						if (handler) {
							try {
								const result = await handler.execute(toolInput);
								const text = result.content.map((c) => c.text).join('\n');
								yield { type: 'tool_result', tool_use_id: callId, is_error: !!result.isError, text };

								// Emit proposals
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
							} catch (err) {
								yield { type: 'tool_result', tool_use_id: callId, is_error: true, text: (err as Error).message };
							}
						}
					}
				}

				if (event.type === 'turn.completed') {
					if (event.usage) {
						yield {
							type: 'cost',
							usage: event.usage,
							numTurns: 1
						};
					}
				}
			}
		} catch (err) {
			// If it's an abort, that's expected (plan mode)
			if ((err as Error).name === 'AbortError') return;
			throw err;
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		// OpenAI doesn't have an easy models.list() for Codex-compatible models
		// in the SDK. Return the fallback list.
		return FALLBACK_MODELS;
	}
}
