import { describe, expect, it } from 'vitest';
import { pickDefaultClaudeModel } from './claude-models';

describe('pickDefaultClaudeModel', () => {
	it('prefers Claude Opus 5.5 over other Opus models', () => {
		expect(pickDefaultClaudeModel(['claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5-5'])).toBe(
			'claude-opus-5-5'
		);
	});

	it('falls back to the first Opus model when Opus 5.5 is not listed', () => {
		expect(pickDefaultClaudeModel(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7'])).toBe(
			'claude-opus-4-8'
		);
	});

	it('falls back to the first model when no Opus model is listed', () => {
		expect(pickDefaultClaudeModel(['gpt-5.5', 'gpt-5.4'])).toBe('gpt-5.5');
	});

	it('returns Opus 5.5 when the list is empty', () => {
		expect(pickDefaultClaudeModel([])).toBe('claude-opus-5-5');
	});
});
