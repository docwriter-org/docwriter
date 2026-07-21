import type { Rule } from '$lib/types';

/** Writing-rule prefix that marks a frozen passage. Reuses the existing
 * rules pipeline (persist, prompt injection) so a freeze is just a rule
 * the agent must not touch — with UI that makes the passage visible. */
export const FREEZE_PREFIX = 'Freeze: ';

export function isFreezeRule(rule: Rule): boolean {
	return rule.text.startsWith(FREEZE_PREFIX);
}

export function freezeQuoteFromRule(rule: Rule): string {
	return rule.text.slice(FREEZE_PREFIX.length).trim();
}

export function makeFreezeRuleText(quote: string): string {
	return FREEZE_PREFIX + quote.trim();
}

/** True when `editText` overlaps a frozen quote (substring either way). */
export function overlapsFrozenQuote(editText: string, quote: string): boolean {
	const a = editText.trim();
	const b = quote.trim();
	if (!a || !b) return false;
	return a.includes(b) || b.includes(a);
}

export function findOverlappingFreeze(
	editTexts: string[],
	rules: Rule[]
): Rule | null {
	for (const rule of rules) {
		if (!isFreezeRule(rule)) continue;
		const quote = freezeQuoteFromRule(rule);
		if (!quote) continue;
		if (editTexts.some((t) => overlapsFrozenQuote(t, quote))) return rule;
	}
	return null;
}
