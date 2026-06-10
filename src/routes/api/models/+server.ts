import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProvider, listAllModels } from '$lib/server/providers';
import type { ProviderId, ProviderModelOption } from '$lib/server/providers/types';

export type ModelOption = { id: string; label: string; provider?: string };

const cache = new Map<string, { models: ModelOption[]; defaultModel: string }>();

function defaultModelFor(models: ModelOption[]): string {
	return models.find((m) => m.id.includes('opus'))?.id ?? models[0]?.id ?? 'opus';
}

export const GET: RequestHandler = async ({ url }) => {
	const providerParam = url.searchParams.get('provider');
	const allProviders = url.searchParams.get('all') === 'true';
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

		const result = { models, defaultModel: defaultModelFor(models) };
		cache.set(cacheKey, result);
		return json(result);
	} catch {
		return json({ models: [], defaultModel: 'opus' });
	}
};
