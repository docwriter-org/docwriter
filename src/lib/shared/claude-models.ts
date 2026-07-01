const HIDDEN_CLAUDE_MODEL_PATTERNS = [/fable/i, /mythos/i];

const ONE_M_CONTEXT_CLAUDE_MODEL_PREFIXES = [
	'claude-opus-4-8',
	'claude-sonnet-4-6'
];

export function isHiddenClaudeModel(id: string, label = id): boolean {
	return HIDDEN_CLAUDE_MODEL_PATTERNS.some((pattern) => pattern.test(id) || pattern.test(label));
}

export function isOneMillionContextClaudeModel(
	id: string,
	maxInputTokens?: number | null
): boolean {
	if (typeof maxInputTokens === 'number' && maxInputTokens >= 1_000_000) return true;
	return ONE_M_CONTEXT_CLAUDE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function usesAdaptiveThinkingClaudeModel(id: string): boolean {
	if (id.startsWith('claude-sonnet-4-6')) return true;

	const opusMatch = id.match(/^claude-opus-4-(\d+)/);
	if (!opusMatch) return false;
	return Number(opusMatch[1]) >= 6;
}

export function formatClaudeModelLabel(
	id: string,
	label: string,
	maxInputTokens?: number | null
): string {
	if (!isOneMillionContextClaudeModel(id, maxInputTokens) || /1m context/i.test(label)) {
		return label;
	}
	return `${label} (1M context)`;
}
