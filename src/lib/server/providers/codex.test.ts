import { describe, expect, it } from 'vitest';
import { codexClientOptions, codexReasoningEffort } from './codex';

describe('codexClientOptions', () => {
	it('keeps Codex state in the workspace when an API key is set', () => {
		const options = codexClientOptions({ CODEX_API_KEY: 'codex-key', OPENAI_API_KEY: 'openai-key' }, '/ws/.docwriter');
		expect(options.apiKey).toBe('codex-key');
		expect(options.env.CODEX_HOME).toBe('/ws/.docwriter/codex');
	});

	it('falls back to OPENAI_API_KEY', () => {
		const options = codexClientOptions({ OPENAI_API_KEY: 'openai-key' }, '/ws/.docwriter');
		expect(options.apiKey).toBe('openai-key');
		expect(options.env.CODEX_HOME).toBe('/ws/.docwriter/codex');
	});

	it('uses the normal Codex home, where the CLI login is, when no API key is set', () => {
		expect(codexClientOptions({ HOME: '/home/me' }, '/ws/.docwriter').env.CODEX_HOME).toBeUndefined();
		expect(
			codexClientOptions({ CODEX_HOME: '/custom/codex', OPENAI_API_KEY: '' }, '/ws/.docwriter').env.CODEX_HOME
		).toBe('/custom/codex');
	});
});

describe('codexReasoningEffort', () => {
	it('uses at least medium effort', () => {
		expect(codexReasoningEffort(undefined)).toBe('medium');
		expect(codexReasoningEffort('low')).toBe('medium');
		expect(codexReasoningEffort('medium')).toBe('medium');
		expect(codexReasoningEffort('high')).toBe('high');
	});
});
