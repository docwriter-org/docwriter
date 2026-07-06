import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProvider, listAllModels } from '$lib/server/providers';
import type { ProviderId } from '$lib/server/providers/types';
import { isMultiTenant } from '$lib/server/deploy-mode';
import { hostedClaudeDefault, isClaudeModelBlocked } from '$lib/shared/claude-models';

export type ModelOption = { id: string; label: string; provider?: string };

const cache = new Map<string, { models: ModelOption[]; defaultModel: string }>();

export const GET: RequestHandler = async ({ url }) => {
	const hostedProviderLocked = isMultiTenant();
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

		// In hosted mode only the selectable Claude set leaves the server —
		// the client then doesn't need its own disable/coerce logic.
		if (hostedProviderLocked) {
			models = models.filter((m) => !isClaudeModelBlocked(m.id, true, m.label));
		}

		if (models.length === 0) {
			return json({ models: [], defaultModel: 'opus' });
		}

		const defaultModel = hostedProviderLocked
			? hostedClaudeDefault(models)
			: (models.find((m) => m.id.includes('opus'))?.id ?? models[0]?.id ?? 'opus');
		const result = { models, defaultModel };
		cache.set(cacheKey, result);
		return json(result);
	} catch {
		return json({ models: [], defaultModel: 'opus' });
	}
};
