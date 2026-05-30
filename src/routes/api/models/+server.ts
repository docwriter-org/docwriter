import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Anthropic from '@anthropic-ai/sdk';

/** One selectable model in the Settings → Model menu. `id` is the full Claude
 * API model ID (e.g. `claude-opus-4-8`) sent straight to `query()`. */
export type ModelOption = { id: string; label: string };

/** Used when the Models API can't be reached (no `ANTHROPIC_API_KEY`, offline,
 * Claude-subscription OAuth without a key, etc.). Kept newest-first; bump this
 * when a new family member ships and the live list is unavailable. */
const FALLBACK_MODELS: ModelOption[] = [
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
	{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }
];

/** Pick the default: the newest Opus in the (newest-first) list, falling back
 * to the first entry, then to the bare `opus` alias. */
function defaultModelFor(models: ModelOption[]): string {
	return models.find((m) => m.id.includes('opus'))?.id ?? models[0]?.id ?? 'opus';
}

// Module-scope cache: the model catalog changes rarely, so we fetch it once per
// server process and reuse it across requests.
let cache: { models: ModelOption[]; defaultModel: string } | null = null;

export const GET: RequestHandler = async () => {
	if (cache) return json(cache);

	try {
		// `new Anthropic()` throws synchronously if no API key is configured, and
		// `models.list()` rejects on auth/network failure — both land in catch.
		const client = new Anthropic();
		const collected: Array<{ id: string; label: string; created: number }> = [];
		for await (const m of client.models.list({ limit: 1000 })) {
			if (!m.id.startsWith('claude-')) continue;
			collected.push({
				id: m.id,
				label: m.display_name || m.id,
				created: Date.parse(m.created_at) || 0
			});
		}
		if (collected.length === 0) throw new Error('no models returned');

		// Newest-first. The API already returns this order, but sort defensively.
		collected.sort((a, b) => b.created - a.created);
		const models = collected.map(({ id, label }) => ({ id, label }));
		cache = { models, defaultModel: defaultModelFor(models) };
		return json(cache);
	} catch {
		// Don't cache the fallback — a later request may succeed once auth/network
		// recovers.
		return json({
			models: FALLBACK_MODELS,
			defaultModel: defaultModelFor(FALLBACK_MODELS)
		});
	}
};
