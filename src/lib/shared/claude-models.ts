const HIDDEN_CLAUDE_MODEL_PATTERNS = [/fable/i, /mythos/i];

export const DEFAULT_CLAUDE_MODEL_PREFIX = 'claude-opus-5-5';

/** Pick the default model: Opus 5.5 if listed, then any Opus, then the first model. */
export function pickDefaultClaudeModel(ids: string[]): string {
	return (
		ids.find((id) => id.startsWith(DEFAULT_CLAUDE_MODEL_PREFIX)) ??
		ids.find((id) => id.includes('opus')) ??
		ids[0] ??
		DEFAULT_CLAUDE_MODEL_PREFIX
	);
}

const ONE_M_CONTEXT_CLAUDE_MODEL_PREFIXES = [
	'claude-opus-5-5',
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
