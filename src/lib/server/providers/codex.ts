/**
 * Codex SDK provider adapter.
 *
 * Uses @openai/codex-sdk as a separate provider from the OpenAI Agents SDK.
 * The Codex SDK does not accept arbitrary JS tool definitions, so this adapter
 * runs a small structured-output tool loop: Codex asks for DocWriter tool
 * calls as JSON, this adapter executes the existing provider-agnostic tools,
 * then Codex receives the results on the next turn.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition,
	ToolResult
} from './types';
import { buildToolDefinitions } from './tool-handlers';

type CodexCtor = new (options?: any) => any;
let Codex: CodexCtor | null = null;

async function loadSdk(): Promise<void> {
	if (Codex) return;
	try {
		const sdk = await import('@openai/codex-sdk');
		Codex = sdk.Codex as CodexCtor;
	} catch (err) {
		throw new Error(
			'@openai/codex-sdk is not installed. Run: npm install @openai/codex-sdk\n' +
				(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'codex' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'codex' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'codex' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'codex' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'codex' }
];

const TOOL_LOOP_SCHEMA = {
	type: 'object',
	properties: {
		assistant_text: {
			type: 'string',
			description: 'Final text to show the user when no more tool calls are needed.'
		},
		tool_calls: {
			type: 'array',
			description: 'DocWriter tool calls to execute before the next turn.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					input: { type: 'object', additionalProperties: true }
				},
				required: ['name', 'input'],
				additionalProperties: false
			}
		}
	},
	required: ['assistant_text', 'tool_calls'],
	additionalProperties: false
} as const;

type ToolCallRequest = { name: string; input: Record<string, unknown> };
type ToolLoopOutput = {
	assistant_text?: string;
	tool_calls?: ToolCallRequest[];
};

function allowedToolDefinitions(tools: ToolDefinition[], allowedTools?: string[]): ToolDefinition[] {
	if (!allowedTools || allowedTools.length === 0) return tools;
	const allowed = new Set(allowedTools);
	return tools.filter((toolDef) => allowed.has(toolDef.name));
}

function toolResultText(result: ToolResult): string {
	return result.content.map((c) => c.text).join('\n');
}

function parseToolLoopOutput(text: string): ToolLoopOutput | null {
	const trimmed = text.trim();
	const candidates = [
		trimmed,
		trimmed.match(/```json\s*([\s\S]*?)```/)?.[1],
		trimmed.match(/```\s*([\s\S]*?)```/)?.[1],
		trimmed.match(/\{[\s\S]*\}/)?.[0]
	].filter(Boolean) as string[];

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as ToolLoopOutput;
			if (parsed && typeof parsed === 'object') return parsed;
		} catch {
			// Try next candidate.
		}
	}
	return null;
}

function buildToolProtocolPrompt(
	options: ProviderQueryOptions,
	tools: ToolDefinition[]
): string {
	const toolSpecs = tools.map((toolDef) => ({
		name: toolDef.name,
		description: toolDef.description,
		input_schema: toolDef.inputSchema
	}));

	return [
		options.systemPrompt ? `DocWriter system instructions:\n${options.systemPrompt}` : '',
		'',
		'You are running inside DocWriter through the Codex SDK provider.',
		'Do not edit files directly. Use the DocWriter tools below by returning JSON `tool_calls`.',
		'If you need tool results before answering, return one or more tool calls and leave `assistant_text` empty.',
		'When you are done, return an empty `tool_calls` array and put the user-facing response in `assistant_text`.',
		'For document edits, prefer `edit_doc` for focused replacements and `write_doc` for whole-file proposals. These create reviewable pending edits in DocWriter.',
		options.planMode
			? 'Plan-first mode is active: do not call mutation tools such as edit_doc or write_doc. Return the plan in assistant_text.'
			: '',
		'',
		`Available DocWriter tools:\n${JSON.stringify(toolSpecs, null, 2)}`,
		'',
		`User request and current DocWriter context:\n${options.prompt}`
	].filter(Boolean).join('\n');
}

function buildToolResultPrompt(results: Array<Record<string, unknown>>): string {
	return [
		'DocWriter executed the tool calls you requested.',
		'Use these results to continue. Return more `tool_calls` if needed; otherwise return final `assistant_text` and an empty `tool_calls` array.',
		'',
		`Tool results:\n${JSON.stringify(results, null, 2)}`
	].join('\n');
}

function emitProposalEvents(call: ToolCallRequest): ProviderEvent[] {
	if (call.name === 'propose_rule') {
		return [{
			type: 'rule_proposal',
			text: typeof call.input.text === 'string' ? call.input.text : '',
			reason: typeof call.input.reason === 'string' ? call.input.reason : undefined
		}];
	}
	if (call.name === 'propose_hook') {
		return [{
			type: 'hook_proposal',
			event: typeof call.input.event === 'string' ? call.input.event : 'PostToolUse',
			matcher: typeof call.input.matcher === 'string' ? call.input.matcher : undefined,
			command: typeof call.input.command === 'string' ? call.input.command : '',
			reason: typeof call.input.reason === 'string' ? call.input.reason : undefined
		}];
	}
	return [];
}

function extensionForMedia(mediaType: string): string {
	switch (mediaType) {
		case 'image/jpeg': return '.jpg';
		case 'image/gif': return '.gif';
		case 'image/webp': return '.webp';
		case 'image/png':
		default:
			return '.png';
	}
}

async function materializeImages(
	images: ProviderQueryOptions['images']
): Promise<{ inputs: Array<{ type: 'local_image'; path: string }>; cleanup: () => Promise<void> }> {
	if (!images?.length) return { inputs: [], cleanup: async () => {} };
	const dir = join(tmpdir(), `docwriter-codex-images-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const inputs: Array<{ type: 'local_image'; path: string }> = [];
	await Promise.all(images.map(async (image, i) => {
		const path = join(dir, `image-${i + 1}${extensionForMedia(image.mediaType)}`);
		await writeFile(path, Buffer.from(image.data, 'base64'));
		inputs.push({ type: 'local_image', path });
	}));
	return {
		inputs,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		}
	};
}

function codexInput(prompt: string, images: Array<{ type: 'local_image'; path: string }>) {
	if (images.length === 0) return prompt;
	return [{ type: 'text' as const, text: prompt }, ...images];
}

function usageEvent(usage: unknown): ProviderEvent {
	return { type: 'cost', usage, numTurns: 1 };
}

export class CodexProvider implements AgentProvider {
	readonly id = 'codex' as const;
	private client: any = null;
	private thread: any = null;
	private threadId: string | null = null;

	private async getClient(): Promise<any> {
		await loadSdk();
		if (!this.client) {
			if (!Codex) throw new Error('Codex SDK failed to load.');
			this.client = new Codex({
				apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined
			});
		}
		return this.client;
	}

	private async getThread(options: ProviderQueryOptions): Promise<any> {
		const client = await this.getClient();
		const threadOptions = {
			workingDirectory: process.cwd(),
			skipGitRepoCheck: true,
			sandboxMode: 'read-only',
			approvalPolicy: 'never',
			...(options.model ? { model: options.model } : {}),
			...(options.effort ? { modelReasoningEffort: options.effort } : {}),
			webSearchMode: options.allowedTools?.includes('WebSearch') ? 'live' : 'disabled'
		};

		if (options.sessionId && options.sessionId !== this.threadId) {
			this.thread = client.resumeThread(options.sessionId, threadOptions);
			this.threadId = options.sessionId;
			return this.thread;
		}
		if (!this.thread) {
			this.thread = client.startThread(threadOptions);
		}
		return this.thread;
	}

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		const allTools = tools.length > 0 ? tools : buildToolDefinitions();
		const availableTools = allowedToolDefinitions(allTools, options.allowedTools);
		const toolMap = new Map(availableTools.map((toolDef) => [toolDef.name, toolDef]));
		const thread = await this.getThread(options);
		const images = await materializeImages(options.images);

		if (this.threadId) {
			yield { type: 'session', sessionId: this.threadId };
		}

		try {
			let prompt = buildToolProtocolPrompt(options, availableTools);
			const maxToolRounds = 8;
			for (let round = 0; round < maxToolRounds; round += 1) {
				let finalText = '';
				const pendingResults: Array<Record<string, unknown>> = [];
				const { events } = await thread.runStreamed(codexInput(prompt, round === 0 ? images.inputs : []), {
					outputSchema: TOOL_LOOP_SCHEMA,
					signal: options.abortSignal
				});

				for await (const event of events) {
					if (event.type === 'thread.started') {
						this.threadId = event.thread_id;
						yield { type: 'session', sessionId: event.thread_id };
					} else if (event.type === 'item.completed') {
						const item = event.item as any;
						if (item.type === 'agent_message') {
							finalText = item.text || '';
						} else if (item.type === 'reasoning' && item.text) {
							yield { type: 'assistant_thinking', text: item.text };
						} else if (item.type === 'command_execution') {
							yield {
								type: 'sdk_status',
								status: item.status,
								error: item.status === 'failed' ? item.aggregated_output : undefined,
								compactResult: item.status === 'completed' ? item.command : undefined
							};
						} else if (item.type === 'error') {
							yield { type: 'sdk_status', status: 'error', error: item.message };
						}
					} else if (event.type === 'turn.completed') {
						yield usageEvent(event.usage);
					} else if (event.type === 'turn.failed') {
						throw new Error(event.error?.message || 'Codex turn failed');
					} else if (event.type === 'error') {
						throw new Error(event.message || 'Codex stream failed');
					}
				}

				const parsed = parseToolLoopOutput(finalText);
				if (!parsed) {
					if (finalText.trim()) yield { type: 'assistant_text', text: finalText.trim() };
					return;
				}

				const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
				if (calls.length === 0) {
					const text = parsed.assistant_text?.trim();
					if (text) yield { type: 'assistant_text', text };
					return;
				}

				for (let i = 0; i < calls.length; i += 1) {
					const call = calls[i];
					const toolUseId = `codex_tool_${round + 1}_${i + 1}`;
					const toolDef = toolMap.get(call.name);
					const originalInput = call.input && typeof call.input === 'object' ? call.input : {};
					yield { type: 'tool_call_start', tool_name: call.name, tool_use_id: toolUseId };
					yield { type: 'tool_call', tool_name: call.name, tool_use_id: toolUseId, input: originalInput };
					for (const event of emitProposalEvents({ ...call, input: originalInput })) yield event;

					if (!toolDef) {
						const text = `Tool "${call.name}" is not available in this DocWriter mode.`;
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: true, text };
						pendingResults.push({ id: toolUseId, name: call.name, input: originalInput, is_error: true, text });
						continue;
					}

					const permission = await options.canUseTool?.(call.name, originalInput);
					if (permission?.behavior === 'deny') {
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: true, text: permission.message };
						pendingResults.push({ id: toolUseId, name: call.name, input: originalInput, is_error: true, text: permission.message });
						continue;
					}

					const input = permission?.behavior === 'allow' && permission.updatedInput
						? permission.updatedInput
						: originalInput;
					try {
						const result = await toolDef.execute(input);
						const text = toolResultText(result);
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: !!result.isError, text };
						pendingResults.push({ id: toolUseId, name: call.name, input, is_error: !!result.isError, text });
					} catch (err) {
						const text = (err as Error).message;
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: true, text };
						pendingResults.push({ id: toolUseId, name: call.name, input, is_error: true, text });
					}
				}

				prompt = buildToolResultPrompt(pendingResults);
			}

			yield {
				type: 'assistant_text',
				text: 'I stopped because the Codex provider reached the tool-round limit before producing a final response.'
			};
		} finally {
			await images.cleanup();
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		return FALLBACK_MODELS;
	}
}
