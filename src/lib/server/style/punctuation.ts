/**
 * First-class punctuation analysis with false-positive exclusions.
 */
import type { NormalizedDocument } from './schemas';

export type PunctOccurrence = {
	char: string;
	kind: 'terminal' | 'clause_boundary' | 'enclosure' | 'sequence';
	offset: number;
	spanId: string;
	leftClauseLen: number;
	rightClauseLen: number;
	sentencePosition: number;
	followingConjunction: string | null;
	nesting: number;
	functionHint: string;
};

export type PunctuationMetrics = {
	perThousand: Record<string, number>;
	occurrences: PunctOccurrence[];
	counts: Record<string, number>;
};

const TERMINAL = new Set(['.', '?', '!', '…']);
const CLAUSE = new Set([',', ';', ':', '—', '–']);
const ENCLOSURE_OPEN = new Set(['(', '[', '{', '"', "'", '“', '‘']);
const ENCLOSURE_CLOSE = new Set([')', ']', '}', '"', "'", '”', '’']);

function isUrlColon(text: string, i: number): boolean {
	// http: https: or path://
	const left = text.slice(Math.max(0, i - 5), i).toLowerCase();
	return /https?$/.test(left) || text.slice(i, i + 3) === '://';
}

function isTimeColon(text: string, i: number): boolean {
	return /\d$/.test(text[i - 1] ?? '') && /^\d/.test(text[i + 1] ?? '');
}

function isDecimalPeriod(text: string, i: number): boolean {
	return /\d$/.test(text[i - 1] ?? '') && /^\d/.test(text[i + 1] ?? '');
}

function isAbbreviationPeriod(text: string, i: number): boolean {
	// e.g., i.e., et al., U.S.
	const before = text.slice(Math.max(0, i - 4), i);
	return /(?:^|[^A-Za-z])(?:e\.g|i\.e|etc|al|Mr|Ms|Dr|Prof|U\.S)$/i.test(before + (text[i] === '.' ? '' : ''));
}

function isCitationPunct(text: string, i: number): boolean {
	// (Author, 2024) or [12]
	const window = text.slice(Math.max(0, i - 20), Math.min(text.length, i + 20));
	return /\[[0-9,\s–-]+\]|\([A-Z][A-Za-z-]+(?:\s+et\s+al\.)?,?\s*\d{4}\)/.test(window);
}

function isHyphenInWord(text: string, i: number): boolean {
	const c = text[i];
	if (c !== '-' && c !== '‑') return false;
	return /[A-Za-z]$/.test(text[i - 1] ?? '') && /^[A-Za-z]/.test(text[i + 1] ?? '');
}

function sentenceForOffset(doc: NormalizedDocument, offset: number) {
	return doc.sentences.find((s) => offset >= s.start && offset < s.end);
}

function clauseLens(doc: NormalizedDocument, offset: number): { left: number; right: number } {
	const clause = doc.clauses.find((c) => offset >= c.start && offset <= c.end);
	if (!clause) return { left: 0, right: 0 };
	const rel = offset - clause.start;
	const left = clause.text.slice(0, rel).trim().split(/\s+/).filter(Boolean).length;
	const right = clause.text.slice(rel + 1).trim().split(/\s+/).filter(Boolean).length;
	return { left, right };
}

function followingConjunction(text: string, i: number): string | null {
	const m = text.slice(i + 1).match(/^\s+(and|but|or|so|yet|nor)\b/i);
	return m ? m[1].toLowerCase() : null;
}

export function analyzePunctuation(doc: NormalizedDocument): PunctuationMetrics {
	const text = doc.text;
	const wordCount = Math.max(1, doc.tokens.length);
	const counts: Record<string, number> = {};
	const occurrences: PunctOccurrence[] = [];
	let nesting = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		// double hyphen as em-dash proxy
		if (ch === '-' && next === '-') {
			if (!isHyphenInWord(text, i)) {
				const key = '--';
				counts[key] = (counts[key] ?? 0) + 1;
				const sent = sentenceForOffset(doc, i);
				const { left, right } = clauseLens(doc, i);
				occurrences.push({
					char: '--',
					kind: 'clause_boundary',
					offset: i,
					spanId: sent?.id ?? `b_${doc.sourceId}_0`,
					leftClauseLen: left,
					rightClauseLen: right,
					sentencePosition: sent ? (i - sent.start) / Math.max(1, sent.text.length) : 0,
					followingConjunction: followingConjunction(text, i + 1),
					nesting,
					functionHint: 'aside_or_break'
				});
			}
			i++;
			continue;
		}

		if (ch === '-' || ch === '‑') {
			if (isHyphenInWord(text, i)) continue;
		}

		if (ch === ':') {
			if (isUrlColon(text, i) || isTimeColon(text, i)) continue;
		}
		if (ch === '.') {
			if (isDecimalPeriod(text, i) || isAbbreviationPeriod(text, i)) continue;
			// ellipsis ...
			if (next === '.' && text[i + 2] === '.') {
				counts['…'] = (counts['…'] ?? 0) + 1;
				const sent = sentenceForOffset(doc, i);
				occurrences.push({
					char: '…',
					kind: 'terminal',
					offset: i,
					spanId: sent?.id ?? `b_${doc.sourceId}_0`,
					leftClauseLen: 0,
					rightClauseLen: 0,
					sentencePosition: sent ? (i - sent.start) / Math.max(1, sent.text.length) : 1,
					followingConjunction: null,
					nesting,
					functionHint: 'ellipsis'
				});
				i += 2;
				continue;
			}
		}

		// sequences !! ?! ...
		if ((ch === '!' || ch === '?') && (next === '!' || next === '?')) {
			const seq = ch + next;
			counts[seq] = (counts[seq] ?? 0) + 1;
			const sent = sentenceForOffset(doc, i);
			occurrences.push({
				char: seq,
				kind: 'sequence',
				offset: i,
				spanId: sent?.id ?? `b_${doc.sourceId}_0`,
				leftClauseLen: 0,
				rightClauseLen: 0,
				sentencePosition: 1,
				followingConjunction: null,
				nesting,
				functionHint: 'emphasis_sequence'
			});
			i++;
			continue;
		}

		let kind: PunctOccurrence['kind'] | null = null;
		if (TERMINAL.has(ch)) kind = 'terminal';
		else if (CLAUSE.has(ch) || ch === '-') {
			if (isCitationPunct(text, i) && (ch === ',' || ch === '.')) continue;
			kind = 'clause_boundary';
		} else if (ENCLOSURE_OPEN.has(ch) || ENCLOSURE_CLOSE.has(ch)) {
			kind = 'enclosure';
			if (ENCLOSURE_OPEN.has(ch)) nesting++;
			if (ENCLOSURE_CLOSE.has(ch)) nesting = Math.max(0, nesting - 1);
		} else {
			continue;
		}

		counts[ch] = (counts[ch] ?? 0) + 1;
		const sent = sentenceForOffset(doc, i);
		const { left, right } = clauseLens(doc, i);
		occurrences.push({
			char: ch,
			kind,
			offset: i,
			spanId: sent?.id ?? `b_${doc.sourceId}_0`,
			leftClauseLen: left,
			rightClauseLen: right,
			sentencePosition: sent ? (i - sent.start) / Math.max(1, sent.text.length) : 0,
			followingConjunction: kind === 'clause_boundary' ? followingConjunction(text, i) : null,
			nesting,
			functionHint:
				kind === 'terminal'
					? ch === '?'
						? 'question'
						: ch === '!'
							? 'exclaim'
							: 'period'
					: kind === 'enclosure'
						? 'enclosure'
						: 'clause_boundary'
		});
	}

	const perThousand: Record<string, number> = {};
	for (const [k, v] of Object.entries(counts)) {
		perThousand[k] = (v / wordCount) * 1000;
	}

	return { perThousand, occurrences, counts };
}
