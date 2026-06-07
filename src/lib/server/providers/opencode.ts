import type {
	AgentProvider,
	ProviderEvent,
	ProviderModelOption,
	ProviderQueryOptions,
	ToolDefinition
} from './types';

let sdkLoaded = false;
let createOpencode: any = null;
let createOpencodeClient: any = null;

async function loadSdk() {
	if (sdkLoaded) return;
	try {
		const sdk = await import('@opencode-ai/sdk');
		createOpencode = sdk.createOpencode;
		createOpencodeClient = sdk.createOpencodeClient;
		sdkLoaded = true;
	} catch (err) {
		throw new Error(
			'@opencode-ai/sdk is not installed. Run: npm install @opencode-ai/sdk\n' +
			(err as Error).message
		);
	}
}

const FALLBACK_MODELS: ProviderModelOption[] = [
	{ id: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (OpenCode)', provider: 'opencode' },
	{ id: 'openai/gpt-4o', label: 'GPT-4o (OpenCode)', provider: 'opencode' },
	{ id: 'anthropic/claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5 (OpenCode)', provider: 'opencode' }
];

let daemonInstance: { client: any; server: { url: string; close(): void } } | null = null;

async function getDaemon() {
	if (daemonInstance) return daemonInstance;
	daemonInstance = await createOpencode({
		timeout: 15000,
		config: {
			permission: {
				edit: 'allow' as const,
				bash: 'allow' as const,
				webfetch: 'allow' as const
			}
		}
	});
	return daemonInstance!;
}

export class OpenCodeProvider implements AgentProvider {
	readonly id = 'opencode' as const;
	private sessionId: string | null = null;

	async *query(
		options: ProviderQueryOptions,
		_tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent> {
		await loadSdk();

		const { client } = await getDaemon();

		const sessionResult = await client.session.create({
			body: { title: 'DocWriter session' }
		});
		const sessionId = sessionResult.data.id;
		this.sessionId = sessionId;

		yield { type: 'session', sessionId };

		const eventResult = await client.event.subscribe();
		const stream: AsyncGenerator<any> = eventResult.stream;

		let modelSpec: { providerID: string; modelID: string } | undefined;
		if (options.model) {
			if (options.model.includes('/')) {
				const [providerID, modelID] = options.model.split('/', 2);
				modelSpec = { providerID, modelID };
			} else {
				modelSpec = { providerID: 'anthropic', modelID: options.model };
			}
		}

		const parts: any[] = [];
		if (options.systemPrompt) {
			parts.push({ type: 'text', text: options.systemPrompt, synthetic: true });
		}
		parts.push({ type: 'text', text: options.prompt });

		await client.session.promptAsync({
			path: { id: sessionId },
			body: {
				model: modelSpec,
				parts
			}
		});

		const seenToolCalls = new Map<string, string>();
		let toolCallCounter = 0;

		for await (const event of stream) {
			if (!event || !event.type) continue;

			if (event.type === 'message.part.updated') {
				const part = event.properties?.part;
				const delta = event.properties?.delta;
				if (!part || part.sessionID !== sessionId) continue;

				switch (part.type) {
					case 'text': {
						if (delta) {
							yield { type: 'assistant_text', text: delta };
						}
						break;
					}
					case 'reasoning': {
						if (delta) {
							yield { type: 'assistant_thinking', text: delta };
						} else if (part.text) {
							yield { type: 'assistant_thinking', text: part.text };
						}
						break;
					}
					case 'tool': {
						const toolName = part.tool || 'unknown';
						const callId = part.callID || `oc_tool_${++toolCallCounter}`;
						const state = part.state;

						if (state?.status === 'running' && !seenToolCalls.has(callId)) {
							seenToolCalls.set(callId, toolName);
							yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
							yield {
								type: 'tool_call',
								tool_name: toolName,
								tool_use_id: callId,
								input: state.input ?? {}
							};

							if (toolName === 'propose_rule') {
								yield {
									type: 'rule_proposal',
									text: typeof state.input?.text === 'string' ? state.input.text : '',
									reason: typeof state.input?.reason === 'string' ? state.input.reason : undefined
								};
							} else if (toolName === 'propose_hook') {
								yield {
									type: 'hook_proposal',
									event: typeof state.input?.event === 'string' ? state.input.event : 'PostToolUse',
									matcher: typeof state.input?.matcher === 'string' ? state.input.matcher : undefined,
									command: typeof state.input?.command === 'string' ? state.input.command : '',
									reason: typeof state.input?.reason === 'string' ? state.input.reason : undefined
								};
							}
						}

						if (state?.status === 'completed') {
							if (!seenToolCalls.has(callId)) {
								seenToolCalls.set(callId, toolName);
								yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
								yield {
									type: 'tool_call',
									tool_name: toolName,
									tool_use_id: callId,
									input: state.input ?? {}
								};
							}
							yield {
								type: 'tool_result',
								tool_use_id: callId,
								is_error: false,
								text: state.output ?? ''
							};
						}

						if (state?.status === 'error') {
							if (!seenToolCalls.has(callId)) {
								seenToolCalls.set(callId, toolName);
								yield { type: 'tool_call_start', tool_name: toolName, tool_use_id: callId };
								yield {
									type: 'tool_call',
									tool_name: toolName,
									tool_use_id: callId,
									input: state.input ?? {}
								};
							}
							yield {
								type: 'tool_result',
								tool_use_id: callId,
								is_error: true,
								text: state.error ?? 'Unknown error'
							};
						}
						break;
					}
					case 'step-finish': {
						if (part.cost || part.tokens) {
							yield {
								type: 'cost',
								totalCostUsd: part.cost,
								usage: part.tokens,
								numTurns: 1
							};
						}
						break;
					}
				}
			}

			if (event.type === 'message.updated') {
				const info = event.properties?.info;
				if (info?.sessionID !== sessionId) continue;

				if (info?.role === 'assistant' && info.cost) {
					yield {
						type: 'cost',
						totalCostUsd: info.cost,
						usage: info.tokens,
						numTurns: 1
					};
				}

				if (info?.error) {
					yield {
						type: 'assistant_text',
						text: `\n\n**Error:** ${info.error.data?.message || info.error.name}\n`
					};
				}
			}

			if (event.type === 'session.idle') {
				if (event.properties?.sessionID === sessionId) {
					break;
				}
			}

			if (event.type === 'session.error') {
				if (!event.properties?.sessionID || event.properties.sessionID === sessionId) {
					const errMsg = event.properties?.error?.data?.message || 'Unknown session error';
					yield { type: 'assistant_text', text: `\n\n**Error:** ${errMsg}\n` };
					break;
				}
			}
		}
	}

	async listModels(): Promise<ProviderModelOption[]> {
		try {
			await loadSdk();
			const { client } = await getDaemon();
			const result = await client.config.providers();
			if (result.data?.providers) {
				const models: ProviderModelOption[] = [];
				for (const provider of result.data.providers) {
					for (const [modelId, model] of Object.entries(provider.models ?? {})) {
						const m = model as any;
						models.push({
							id: `${provider.id}/${modelId}`,
							label: `${m.name || modelId} (OpenCode)`,
							provider: 'opencode'
						});
					}
				}
				if (models.length > 0) return models;
			}
		} catch {
			// Fall through to defaults
		}
		return FALLBACK_MODELS;
	}
}
