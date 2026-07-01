import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProvider, listAllModels } from '$lib/server/providers';
import type { ProviderId, ProviderModelOption } from '$lib/server/providers/types';
import {
	HOSTED_CLAUDE_DEFAULT_MODEL,
	isHostedSelectableClaudeModel
} from '$lib/shared/claude-models';

export type ModelOption = { id: string; label: string; provider?: string };

const cache = new Map<string, { models: ModelOption[]; defaultModel: string }>();

function isHostedProviderLocked(): boolean {
	return process.env.DOCWRITER_HOSTED === '1' || process.env.PUBLIC_DOCWRITER_HOSTED === '1';
}

function defaultModelFor(models: ModelOption[], hostedProviderLocked: boolean): string {
	if (hostedProviderLocked) {
		return (
			models.find((m) => m.id === HOSTED_CLAUDE_DEFAULT_MODEL)?.id ??
			models.find((m) => isHostedSelectableClaudeModel(m.id) && m.id.includes('sonnet'))?.id ??
			models.find((m) => isHostedSelectableClaudeModel(m.id))?.id ??
			HOSTED_CLAUDE_DEFAULT_MODEL
		);
	}
	return models.find((m) => m.id.includes('opus'))?.id ?? models[0]?.id ?? 'opus';
}

export const GET: RequestHandler = async ({ url }) => {
	const hostedProviderLocked = isHostedProviderLocked();
	const providerParam = hostedProviderLocked ? 'claude' : url.searchParams.get('provider');
	const allProviders = !hostedProviderLocked && url.searchParams.get('all') === 'true';
	const cacheKey = allProviders ? '__all__' : (providerParam || 'claude');

	if (cache.has(cacheKey)) return json(cache.get(cacheKey));

	try {
		let models: ModelOption[];
		if (allProviders) {
			const allModels = await listAllModels();
			models = allModels.map(({ id, label, provider }) => ({ id, label, provider }));
		} else {
			const providerId = (providerParam || 'claude') as ProviderId;
			const provider = await getProvider(providerId);
			const providerModels = await provider.listModels();
			models = providerModels.map(({ id, label, provider: p }) => ({ id, label, provider: p }));
		}

		if (models.length === 0) {
			return json({ models: [], defaultModel: 'opus' });
		}

		const result = { models, defaultModel: defaultModelFor(models, hostedProviderLocked) };
		cache.set(cacheKey, result);
		return json(result);
	} catch {
		return json({ models: [], defaultModel: 'opus' });
	}
};
