/**
 * Pi coding agent SDK provider adapter.
 *
 * Uses @earendil-works/pi-coding-agent with createAgentSession() +
 * session.prompt() + session.subscribe(). Tools are registered via
 * defineTool() with typebox schemas. The SDK handles the agent loop,
 * tool calling, and streaming events natively.
 */
import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';
import { buildToolDefinitions } from './tool-handlers';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getEffectiveDocwriterDir, getEffectiveRoot } from '$lib/server/document-files';

let sdkLoaded = false;
let createAgentSession: any = null;
let defineTool: any = null;
let SessionManager: any = null;
let AuthStorage: any = null;
let ModelRegistry: any = null;
let getModel: any = null;
let Type: any = null;

async function loadSdk() {
	if (sdkLoaded) return;
	try {
		const sdk = await import('@earendil-works/pi-coding-agent');
		createAgentSession = sdk.createAgentSession;
		defineTool = sdk.defineTool;
		SessionManager = sdk.SessionManager;
		AuthStorage = sdk.AuthStorage;
		ModelRegistry = sdk.ModelRegistry;

		const ai = await import('@earendil-works/pi-ai/compat');
		getModel = ai.getModel;

		const tb = await import('@sinclair/typebox');
		Type = tb.Type;

		sdkLoaded = true;
	} catch (err) {
		throw new Error(
			'@earendil-works/pi-coding-agent is not installed. Run: npm install @earendil-works/pi-coding-agent @earendil-works/pi-ai @sinclair/typebox\n' +
			(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'together/moonshotai/Kimi-K2.6', label: 'Kimi K2.6 (Together)', provider: 'pi' },
	{ id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'pi' },
	{ id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'pi' },
	{ id: 'anthropic/claude-haiku-3-5', label: 'Claude Haiku 3.5', provider: 'pi' },
	{ id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'pi' },
	{ id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', provider: 'pi' },
	{ id: 'openai/o4-mini', label: 'o4-mini', provider: 'pi' },
	{ id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'pi' },
	{ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'pi' },
	{ id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', provider: 'pi' },
	{ id: 'ollama/llama3.1', label: 'Llama 3.1 (Ollama)', provider: 'pi' },
	{ id: 'ollama/qwen3', label: 'Qwen 3 (Ollama)', provider: 'pi' }
];

function jsonSchemaToTypebox(schema: any): any {
	if (!schema || schema.type !== 'object') return Type.Object({});
	const props: Record<string, any> = {};
	for (const [key, val] of Object.entries(schema.properties ?? {})) {
		const s = val as any;
		const desc = s.description ? { description: s.description } : {};
		switch (s.type) {
			case 'string':
				props[key] = Type.String(desc);
				break;
			case 'boolean':
				props[key] = Type.Boolean(desc);
				break;
			case 'number':
			case 'integer':
				props[key] = Type.Number(desc);
				break;
			case 'object':
				props[key] = jsonSchemaToTypebox(s);
				break;
			default:
				props[key] = Type.String(desc);
		}
		if (!schema.required?.includes(key)) {
			props[key] = Type.Optional(props[key]);
		}
	}
	return Type.Object(props);
}

function buildPiTools(defs: ToolDefinition[]): any[] {
	return defs.map((def) =>
		defineTool({
			name: def.name,
			label: def.name,
			description: def.description,
			parameters: jsonSchemaToTypebox(def.inputSchema),
			execute: async (_toolCallId: string, params: any) => {
				const result = await def.execute(params);
				return {
					content: result.content,
					details: {}
				};
			}
		})
	);
}

/** Resolve a Pi model id via pi-ai's catalog, with small fallbacks for
 * models hosted by an inference API before pi-ai's generated list catches up. */
function resolvePiModel(provider: string, modelId: string) {
	const resolved = getModel(provider, modelId);
	if (resolved?.id) return resolved;
	// Together serves zai-org/GLM-5.2; pi-ai 0.80.x still lists only GLM-5.1.
	if (provider === 'together' && modelId === 'zai-org/GLM-5.2') {
		const template = getModel('together', 'zai-org/GLM-5.1');
		if (template?.id) {
			return { ...template, id: 'zai-org/GLM-5.2', name: 'GLM-5.2' };
		}
	}
	return undefined;
}

export class PiProvider implements AgentProvider {
	readonly id = 'pi' as const;

	async *query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadSdk();

		const allTools = tools.length > 0 ? tools : buildToolDefinitions();
		const piTools = buildPiTools(allTools);
		const cwd = getEffectiveRoot();
		const piDir = join(getEffectiveDocwriterDir(), 'pi');
		const sessionDir = join(piDir, 'sessions');
		await mkdir(sessionDir, { recursive: true });

		const authStorage = AuthStorage.create(join(piDir, 'auth.json'));
		const modelRegistry = ModelRegistry.create(authStorage, join(piDir, 'models.json'));
		let sessionManager: any;
		let resumeFailed = false;
		if (options.sessionId) {
			try {
				sessionManager = SessionManager.open(options.sessionId, sessionDir, cwd);
			} catch {
				resumeFailed = true;
			}
		}
		if (!sessionManager) {
			sessionManager = SessionManager.create(cwd, sessionDir);
		}

		const sessionOpts: any = {
			cwd,
			sessionManager,
			authStorage,
			modelRegistry,
			customTools: piTools,
			tools: ['read', ...allTools.map((toolDef) => toolDef.name)]
		};

		if (options.model) {
			try {
				// Split at the FIRST slash only: the remainder is the model id,
				// which may itself contain slashes (e.g. together/moonshotai/Kimi-K2.6
				// is the `together` provider serving model `moonshotai/Kimi-K2.6`).
				const slash = options.model.indexOf('/');
				const [provider, modelId] =
					slash === -1
						? ['anthropic', options.model]
						: [options.model.slice(0, slash), options.model.slice(slash + 1)];
				const resolved = resolvePiModel(provider, modelId);
				if (resolved?.id) sessionOpts.model = resolved;
			} catch {
				// Fall through to default model
			}
		}

		const { session } = await createAgentSession(sessionOpts);
		if (resumeFailed) {
			yield {
				type: 'sdk_status',
				status: 'cleared_stale_session',
				compactResult: 'Pi session was missing locally; starting a fresh conversation.'
			};
		}
		yield { type: 'session', sessionId: sessionManager.getSessionId() };

		const events: ProviderEvent[] = [];
		let resolveWait: (() => void) | null = null;
		let done = false;
		// A model-call failure (e.g. invalid GEMINI_API_KEY) surfaces only as a
		// message_end whose message has stopReason 'error'; session.prompt()
		// still resolves — without capturing it here the render completes as a
		// silent "made no edits" no-op.
		let streamError: Error | null = null;
		// Correlate tool start/end without wall-clock fallbacks (Date.now()
		// differs between the two events, breaking tool_use_id matching).
		let toolCounter = 0;
		const lastCallIdByTool = new Map<string, string>();

		const unsubscribe = session.subscribe((event: any) => {
			switch (event.type) {
				case 'message_update': {
					const ame = event.assistantMessageEvent;
					if (ame?.type === 'text_delta' && ame.delta) {
						events.push({ type: 'assistant_text', text: ame.delta });
					} else if (ame?.type === 'thinking_delta' && ame.delta) {
						events.push({ type: 'assistant_thinking', text: ame.delta });
					}
					break;
				}
				case 'message_end': {
					// A model-call failure (invalid API key, quota, network) ends the
					// assistant message with stopReason 'error' + errorMessage; the
					// prompt promise still RESOLVES, so this is the only signal.
					const msg = event.message;
					if (msg?.role === 'assistant' && msg?.stopReason === 'error') {
						const detail = msg.errorMessage;
						streamError = new Error(
							typeof detail === 'string' && detail
								? `Pi model error: ${detail.slice(0, 500)}`
								: 'Pi model call ended with an error.'
						);
					}
					break;
				}
				case 'tool_execution_start': {
					const callId = event.toolCallId || `pi_tool_${++toolCounter}`;
					lastCallIdByTool.set(event.toolName, callId);
					events.push({ type: 'tool_call_start', tool_name: event.toolName, tool_use_id: callId });
					events.push({
						type: 'tool_call',
						tool_name: event.toolName,
						tool_use_id: callId,
						input: event.args ?? {}
					});

					if (event.toolName === 'propose_rule') {
						events.push({
							type: 'rule_proposal',
							text: typeof event.args?.text === 'string' ? event.args.text : '',
							reason: typeof event.args?.reason === 'string' ? event.args.reason : undefined
						});
					} else if (event.toolName === 'propose_hook') {
						events.push({
							type: 'hook_proposal',
							event: typeof event.args?.event === 'string' ? event.args.event : 'PostToolUse',
							matcher: typeof event.args?.matcher === 'string' ? event.args.matcher : undefined,
							command: typeof event.args?.command === 'string' ? event.args.command : '',
							reason: typeof event.args?.reason === 'string' ? event.args.reason : undefined
						});
					}
					break;
				}
				case 'tool_execution_end': {
					const callId = event.toolCallId || lastCallIdByTool.get(event.toolName) || `pi_tool_${toolCounter}`;
					const text = event.result?.content
						?.map((c: any) => c.text)
						.join('\n') ?? '';
					events.push({
						type: 'tool_result',
						tool_use_id: callId,
						is_error: !!event.isError,
						text
					});
					break;
				}
				case 'agent_end':
					done = true;
					break;
			}
			if (resolveWait) resolveWait();
		});

		const fullPrompt = options.systemPrompt
			? `${options.systemPrompt}\n\n${options.prompt}`
			: options.prompt;

		let promptError: Error | null = null;
		const onAbort = () => {
			done = true;
			if (resolveWait) resolveWait();
		};
		options.abortSignal?.addEventListener('abort', onAbort, { once: true });

		const promptPromise = session.prompt(fullPrompt).catch((err: unknown) => {
			promptError = err instanceof Error ? err : new Error(String(err));
			done = true;
			if (resolveWait) resolveWait();
		});

		while (!done) {
			if (options.abortSignal?.aborted) {
				promptError = new Error('Render aborted');
				break;
			}
			if (events.length === 0) {
				await new Promise<void>((r) => { resolveWait = r; });
				resolveWait = null;
			}
			while (events.length > 0) {
				yield events.shift()!;
			}
		}
		// Drain remaining events
		while (events.length > 0) {
			yield events.shift()!;
		}

		options.abortSignal?.removeEventListener('abort', onAbort);
		unsubscribe();
		await promptPromise;
		session.dispose();
		// Surface a prompt failure (e.g. missing API key) or an in-stream model
		// error (e.g. invalid API key) so the render endpoint emits an `error`
		// event instead of completing as a silent no-op.
		if (promptError) throw promptError;
		if (streamError) throw streamError;
	}

	async listModels(): Promise<ProviderModelOption[]> {
		try {
			await loadSdk();
			const authStorage = AuthStorage.create();
			const registry = ModelRegistry.create(authStorage);
			const available = await registry.getAvailable();
			if (available?.length > 0) {
				return available.slice(0, 10).map((m: any) => ({
					id: m.id || m.name,
					label: m.label || m.name || m.id,
					provider: 'pi' as const
				}));
			}
		} catch {
			// Fall through to defaults
		}
		return FALLBACK_MODELS;
	}
}
