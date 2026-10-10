import { describe, expect, it } from 'vitest';
import {
	CLAUDE_FALLBACK_MODELS,
	CODEX_FALLBACK_MODELS,
	CURSOR_FALLBACK_MODELS,
	OPENAI_FALLBACK_MODELS,
	PI_FALLBACK_MODELS
} from './fallback-models';

const LISTS = {
	claude: CLAUDE_FALLBACK_MODELS,
	openai: OPENAI_FALLBACK_MODELS,
	codex: CODEX_FALLBACK_MODELS,
	cursor: CURSOR_FALLBACK_MODELS,
	pi: PI_FALLBACK_MODELS
};

describe('fallback model lists', () => {
	for (const [provider, models] of Object.entries(LISTS)) {
		it(`labels every ${provider} model with its provider and has no duplicate IDs`, () => {
			expect(models.length).toBeGreaterThan(0);
			expect(models.every((m) => m.provider === provider)).toBe(true);
			expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
		});
	}

	it('lists Claude Opus 5.5 first', () => {
		expect(CLAUDE_FALLBACK_MODELS[0].id).toBe('claude-opus-5-5');
	});
});

describe('Pi fallback models', () => {
	it('uses IDs that the installed pi-ai catalog has', async () => {
		const { getModel } = await import('@earendil-works/pi-ai/compat');
		const cataloged = PI_FALLBACK_MODELS.filter((m) =>
			/^(anthropic|openai|google)\//.test(m.id)
		);
		expect(cataloged.length).toBeGreaterThan(0);
		for (const { id } of cataloged) {
			const slash = id.indexOf('/');
			const model = getModel(id.slice(0, slash) as never, id.slice(slash + 1) as never);
			expect(model?.id, id).toBe(id.slice(slash + 1));
		}
	});
});
