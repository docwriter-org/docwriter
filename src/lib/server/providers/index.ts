/**
 * Provider registry. Lazily instantiates provider adapters and provides
 * a lookup by ProviderId.
 */
import type { AgentProvider, ProviderId, ProviderModelOption } from './types';
import { ClaudeProvider } from './claude';

const providers = new Map<ProviderId, AgentProvider>();

async function createProvider(id: ProviderId): Promise<AgentProvider> {
	switch (id) {
		case 'claude':
			return new ClaudeProvider();
		case 'cursor': {
			const { CursorProvider } = await import('./cursor');
			return new CursorProvider();
		}
		case 'openai': {
			const { OpenAIAgentsProvider } = await import('./openai');
			return new OpenAIAgentsProvider();
		}
		case 'pi': {
			const { PiProvider } = await import('./pi');
			return new PiProvider();
		}
		case 'opencode': {
			const { OpenCodeProvider } = await import('./opencode');
			return new OpenCodeProvider();
		}
		default:
			throw new Error(`Unknown provider: ${id}`);
	}
}

export async function getProvider(id: ProviderId = 'claude'): Promise<AgentProvider> {
	let p = providers.get(id);
	if (p) return p;
	p = await createProvider(id);
	providers.set(id, p);
	return p;
}

export async function listAllModels(): Promise<ProviderModelOption[]> {
	const all: ProviderModelOption[] = [];
	for (const id of ['claude', 'openai', 'cursor', 'pi', 'opencode'] as ProviderId[]) {
		try {
			const p = await getProvider(id);
			const models = await p.listModels();
			all.push(...models);
		} catch {
			// Provider not available (SDK not installed), skip
		}
	}
	return all;
}

export type { ProviderId, AgentProvider, ProviderModelOption } from './types';
