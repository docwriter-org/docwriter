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
import { getEffectiveDocwriterDir, getEffectiveRoot } from '$lib/server/document-files';
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition,
	ToolResult
} from './types';
import { buildToolDefinitions } from './tool-handlers';
import { emitProposalEvents, makeLazySdkLoader, wrapToolsForProvider } from './shared';

type CodexCtor = new (options?: any) => any;
let Codex: CodexCtor | null = null;

const importCodexSdk = makeLazySdkLoader(
	() => import('@openai/codex-sdk'),
	'@openai/codex-sdk is not installed. Run: npm install @openai/codex-sdk'
);

async function loadSdk(): Promise<void> {
	if (Codex) return;
	const sdk = await importCodexSdk();
	Codex = sdk.Codex as CodexCtor;
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
			description: 'Final text to show me when no more tool calls are needed.'
		},
		tool_calls: {
			type: 'array',
			description: 'DocWriter tool calls to execute before the next turn.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					// JSON-encoded arguments. Strict structured outputs forbid
					// open-ended objects (additionalProperties:true), so the tool
					// input travels as a string and is parsed on this side.
					input: { type: 'string', description: 'JSON-encoded object of tool arguments.' }
				},
				required: ['name', 'input'],
				additionalProperties: false
			}
		}
	},
	required: ['assistant_text', 'tool_calls'],
	additionalProperties: false
} as const;

type ToolCallRequest = { name: string; input: unknown };

/** Tool input arrives as a JSON-encoded string (strict-schema requirement). */
function parseToolInput(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
		} catch {
			// fall through to empty
		}
	}
	return {};
}
type ToolLoopOutput = {
	assistant_text?: string;
	tool_calls?: ToolCallRequest[];
};

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
		'When you are done, return an empty `tool_calls` array and put the response meant for me in `assistant_text`.',
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

	private async createClient(): Promise<any> {
		await loadSdk();
		if (!Codex) throw new Error('Codex SDK failed to load.');
		const codexHome = join(getEffectiveDocwriterDir(), 'codex');
		await mkdir(codexHome, { recursive: true });
		// Prefer CODEX_API_KEY, but allow OPENAI_API_KEY for CI and local setups
		// where Codex uses the same OpenAI credential.
		return new Codex({
			apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined,
			env: { ...process.env, CODEX_HOME: codexHome }
		});
	}

	private async getThread(options: ProviderQueryOptions): Promise<any> {
		const client = await this.createClient();
		const threadOptions = {
			workingDirectory: getEffectiveRoot(),
			skipGitRepoCheck: true,
			sandboxMode: 'read-only',
			approvalPolicy: 'never',
			...(options.model ? { model: options.model } : {}),
			...(options.effort ? { modelReasoningEffort: options.effort } : {}),
			webSearchMode: options.allowedTools?.includes('WebSearch') ? 'live' : 'disabled'
		};

		return options.sessionId
			? client.resumeThread(options.sessionId, threadOptions)
			: client.startThread(threadOptions);
	}

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		const allTools = tools.length > 0 ? tools : buildToolDefinitions();
		const availableTools = wrapToolsForProvider(allTools, options);
		const toolMap = new Map(availableTools.map((toolDef) => [toolDef.name, toolDef]));
		const thread = await this.getThread(options);
		const images = await materializeImages(options.images);
		let threadId = options.sessionId ?? null;

		if (threadId) {
			yield { type: 'session', sessionId: threadId };
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
						threadId = event.thread_id;
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
					const originalInput = parseToolInput(call.input);
					yield { type: 'tool_call_start', tool_name: call.name, tool_use_id: toolUseId };
					yield { type: 'tool_call', tool_name: call.name, tool_use_id: toolUseId, input: originalInput };
					for (const event of emitProposalEvents(call.name, originalInput)) yield event;

					if (!toolDef) {
						const text = `Tool "${call.name}" is not available in this DocWriter mode.`;
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: true, text };
						pendingResults.push({ id: toolUseId, name: call.name, input: originalInput, is_error: true, text });
						continue;
					}

					// `toolDef.execute` is gated by wrapToolsForProvider: a denied
					// permission returns an error ToolResult carrying the deny
					// message; an allowed one runs with any updatedInput.
					try {
						const result = await toolDef.execute(originalInput);
						const text = toolResultText(result);
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: !!result.isError, text };
						pendingResults.push({ id: toolUseId, name: call.name, input: originalInput, is_error: !!result.isError, text });
					} catch (err) {
						const text = (err as Error).message;
						yield { type: 'tool_result', tool_use_id: toolUseId, is_error: true, text };
						pendingResults.push({ id: toolUseId, name: call.name, input: originalInput, is_error: true, text });
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
