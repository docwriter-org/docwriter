const HIDDEN_CLAUDE_MODEL_PATTERNS = [/fable/i, /mythos/i];

const ONE_M_CONTEXT_CLAUDE_MODEL_PREFIXES = [
	'claude-opus-4-8',
	'claude-sonnet-4-6'
];

export const HOSTED_CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';
export const HOSTED_CLAUDE_MODEL_NOTE = 'Other models are available when self-hosting DocWriter.';

export function isHiddenClaudeModel(id: string, label = id): boolean {
	return HIDDEN_CLAUDE_MODEL_PATTERNS.some((pattern) => pattern.test(id) || pattern.test(label));
}

export function isHostedSelectableClaudeModel(id: string): boolean {
	return id.startsWith('claude-sonnet-') || id.startsWith('claude-haiku-');
}

/** The ONE policy check for whether a Claude model may be offered or used:
 * hidden models are blocked everywhere; on hosted deployments only the
 * hosted-selectable set is allowed. */
export function isClaudeModelBlocked(id: string, hostedLocked: boolean, label = id): boolean {
	return isHiddenClaudeModel(id, label) || (hostedLocked && !isHostedSelectableClaudeModel(id));
}

/** Coerce a model request on the hosted deployment: the first allowed
 * candidate wins, else the hosted default constant. */
export function resolveHostedClaudeModel(
	...candidates: Array<string | undefined | null>
): string {
	for (const id of candidates) {
		if (id && !isClaudeModelBlocked(id, true)) return id;
	}
	return HOSTED_CLAUDE_DEFAULT_MODEL;
}

/** Hosted default-model ladder: the configured default when present, else any
 * selectable sonnet, else any selectable model, else the constant. */
export function hostedClaudeDefault(models: Array<{ id: string }>): string {
	return (
		models.find((m) => m.id === HOSTED_CLAUDE_DEFAULT_MODEL)?.id ??
		models.find((m) => isHostedSelectableClaudeModel(m.id) && m.id.includes('sonnet'))?.id ??
		models.find((m) => isHostedSelectableClaudeModel(m.id))?.id ??
		HOSTED_CLAUDE_DEFAULT_MODEL
	);
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
