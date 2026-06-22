import type { PendingReviewOperation, PendingReviewRound } from './types';
import { classifyRoundKind } from './review-diff';

export interface MaterializedPendingReviewRound extends PendingReviewRound {
	beforeMd: string;
	afterMd: string;
	kind: 'tiny' | 'big';
}

export interface AppliedReviewRound {
	nextText: string;
	stale: boolean;
	staleReason?: string;
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count += 1;
		idx += needle.length;
	}
	return count;
}

export function reviewTextHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function applyOperation(currentText: string, operation: PendingReviewOperation): AppliedReviewRound {
	if (operation.type === 'write') {
		return { nextText: operation.content, stale: false };
	}

	const hits = countOccurrences(currentText, operation.oldString);
	if (hits === 0) {
		return {
			nextText: currentText,
			stale: true,
			staleReason:
				'The original text is no longer present in the current document, so this edit needs to be regenerated.'
		};
	}
	if (hits > 1 && !operation.replaceAll) {
		return {
			nextText: currentText,
			stale: true,
			staleReason:
				'The original text now matches multiple locations, so this edit is ambiguous and needs to be regenerated.'
		};
	}
	// Function replacement so JS doesn't interpret `$` patterns ($&, $`, $',
	// $n) in newString. Without the function form, a $' anywhere in newString
	// substitutes the entire post-match text of the doc, silently duplicating
	// large chunks — catastrophic for LaTeX (math `$x'$`, derivatives) and
	// any other content with literal $-with-trailing-quote sequences. The
	// replaceAll path uses split/join which goes through a different code
	// path and isn't affected.
	const nextText = operation.replaceAll
		? currentText.split(operation.oldString).join(operation.newString)
		: currentText.replace(operation.oldString, () => operation.newString);
	return { nextText, stale: false };
}

export function applyPendingReviewRound(
	currentText: string,
	round: PendingReviewRound
): AppliedReviewRound {
	if (round.operation) {
		const applied = applyOperation(currentText, round.operation);
		if (
			round.operation.type === 'write' &&
			round.baseHash &&
			reviewTextHash(currentText) !== round.baseHash
		) {
			return {
				nextText: round.operation.content,
				stale: true,
				staleReason:
					'The document changed after this full-document rewrite was proposed, so accepting it now would overwrite newer edits.'
			};
		}
		return applied;
	}
	if (typeof round.afterMd === 'string') {
		return { nextText: round.afterMd, stale: false };
	}
	return {
		nextText: currentText,
		stale: true,
		staleReason: 'This proposal is missing its edit payload and cannot be replayed.'
	};
}

export function materializePendingReviewRounds(
	baseText: string,
	rounds: PendingReviewRound[]
): MaterializedPendingReviewRound[] {
	let currentText = baseText;
	return rounds.map((round) => {
		const beforeMd =
			typeof round.beforeMd === 'string' && !round.operation ? round.beforeMd : currentText;
		const applied = applyPendingReviewRound(currentText, round);
		const afterMd =
			typeof round.afterMd === 'string' && !round.operation ? round.afterMd : applied.nextText;
		const materialized: MaterializedPendingReviewRound = {
			...round,
			beforeMd,
			afterMd,
			kind: round.kind ?? classifyRoundKind(beforeMd, afterMd)
		};
		if (applied.stale) {
			materialized.stale = true;
			materialized.staleReason = applied.staleReason;
		}
		currentText = afterMd;
		return materialized;
	});
}

export function materializePendingReviewText(
	baseText: string,
	rounds: PendingReviewRound[]
): string {
	let currentText = baseText;
	for (const round of rounds) {
		const applied = applyPendingReviewRound(currentText, round);
		if (applied.stale) {
			// Stop cascading: once a round is stale, subsequent rounds likely
			// depend on it and would produce incorrect matches. Return the
			// current text (committed + successfully-applied rounds) so that
			// `read_doc` / `edit_doc` see a consistent snapshot rather than
			// a broken chain where some edits silently failed to apply.
			break;
		}
		currentText = applied.nextText;
	}
	return currentText;
}
