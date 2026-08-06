/**
 * Span-preserving normalization of plain text / light markup into NormalizedDocument.
 */
import type { NormalizedDocument, ReferenceRole, TextSpan } from './schemas';

const STOPWORDS = new Set(
	`a an the and or but if then else when while for of to in on at by from with as is are was were be been being
	this that these those it its i you he she we they them my your our their me him her us not no nor so than too
	very can could should would may might will just also into over under again further once here there all any both
	each few more most other some such only own same than too very`.split(/\s+/)
);

function makeId(prefix: string, sourceId: string, index: number): string {
	return `${prefix}_${sourceId}_${index}`;
}

function span(
	prefix: string,
	sourceId: string,
	index: number,
	start: number,
	end: number,
	text: string
): TextSpan {
	return { id: makeId(prefix, sourceId, index), sourceId, start, end, text };
}

/** Split into paragraphs on blank lines; preserve offsets into `text`. */
function findParagraphs(text: string, sourceId: string): TextSpan[] {
	const out: TextSpan[] = [];
	const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(text))) {
		const chunk = m[0].trimEnd();
		if (!chunk.trim()) continue;
		const start = m.index + (m[0].length - m[0].trimStart().length);
		const trimmed = chunk.trim();
		out.push(span('p', sourceId, i++, start, start + trimmed.length, trimmed));
	}
	return out;
}

/** Rough sentence splitter that keeps abbreviations/decimals attached. */
function findSentences(paragraphs: TextSpan[], sourceId: string): TextSpan[] {
	const out: TextSpan[] = [];
	let i = 0;
	for (const p of paragraphs) {
		const parts = p.text.split(/(?<=[.!?…])\s+(?=[A-Z“"(\[])/);
		let cursor = p.start;
		for (const part of parts) {
			const idx = p.text.indexOf(part, cursor - p.start);
			const start = idx >= 0 ? p.start + idx : cursor;
			const end = start + part.length;
			if (part.trim()) {
				out.push(span('s', sourceId, i++, start, end, part.trim()));
			}
			cursor = end;
		}
	}
	return out;
}

/** Clause-ish splits on ; : — – or , + coordinating conjunction. */
function findClauses(sentences: TextSpan[], sourceId: string): TextSpan[] {
	const out: TextSpan[] = [];
	let i = 0;
	const re = /\s*(?:[;:—–]|\s+--\s+|,(?=\s+(?:and|but|or|so|yet|nor)\b))\s*/gi;
	for (const s of sentences) {
		const pieces: string[] = [];
		let last = 0;
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(s.text))) {
			pieces.push(s.text.slice(last, m.index));
			last = m.index + m[0].length;
		}
		pieces.push(s.text.slice(last));
		let cursor = s.start;
		for (const piece of pieces) {
			const trimmed = piece.trim();
			if (!trimmed) {
				cursor += piece.length;
				continue;
			}
			const local = s.text.indexOf(trimmed, cursor - s.start);
			const start = local >= 0 ? s.start + local : cursor;
			out.push(span('c', sourceId, i++, start, start + trimmed.length, trimmed));
			cursor = start + trimmed.length;
		}
	}
	return out;
}

function findTokens(text: string, sourceId: string) {
	const out: NormalizedDocument['tokens'] = [];
	const re = /[A-Za-z][A-Za-z'-]*|[0-9]+(?:\.[0-9]+)?/g;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(text))) {
		const raw = m[0];
		const lemma = raw.toLowerCase().replace(/'s$/, '');
		out.push({
			...span('t', sourceId, i++, m.index, m.index + raw.length, raw),
			lemma,
			isStopword: STOPWORDS.has(lemma)
		});
	}
	return out;
}

function findSections(text: string, sourceId: string, paragraphs: TextSpan[]) {
	const sections: NormalizedDocument['sections'] = [];
	const headingRe = /^(#{1,6})\s+(.+)$|^(.+)\n([-=])\2*$/gm;
	// Markdown ATX headings only for reliability
	const atx = /^(#{1,6})\s+(.+)$/gm;
	let m: RegExpExecArray | null;
	const headings: Array<{ level: number; title: string; start: number; end: number }> = [];
	while ((m = atx.exec(text))) {
		headings.push({
			level: m[1].length,
			title: m[2].trim(),
			start: m.index,
			end: m.index + m[0].length
		});
	}
	if (headings.length === 0) {
		if (paragraphs.length) {
			sections.push({
				...span('sec', sourceId, 0, 0, text.length, text),
				heading: undefined,
				level: 0
			});
		}
		return sections;
	}
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		const next = headings[i + 1];
		const end = next ? next.start : text.length;
		const body = text.slice(h.start, end);
		sections.push({
			...span('sec', sourceId, i, h.start, end, body),
			heading: h.title,
			level: h.level
		});
	}
	return sections;
}

function findBlocks(text: string, sourceId: string): TextSpan[] {
	// Blocks ≈ non-empty lines / list items / headings for density metrics
	const out: TextSpan[] = [];
	const lines = text.split('\n');
	let offset = 0;
	let i = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) {
			const start = offset + line.indexOf(trimmed);
			out.push(span('b', sourceId, i++, start, start + trimmed.length, trimmed));
		}
		offset += line.length + 1;
	}
	return out;
}

export function normalizeText(
	text: string,
	opts: { sourceId: string; role: ReferenceRole; label?: string }
): NormalizedDocument {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
	const paragraphs = findParagraphs(normalized, opts.sourceId);
	const sentences = findSentences(paragraphs, opts.sourceId);
	const clauses = findClauses(sentences, opts.sourceId);
	const tokens = findTokens(normalized, opts.sourceId);
	const sections = findSections(normalized, opts.sourceId, paragraphs);
	const blocks = findBlocks(normalized, opts.sourceId);
	return {
		sourceId: opts.sourceId,
		role: opts.role,
		label: opts.label,
		text: normalized,
		blocks,
		sections,
		paragraphs,
		sentences,
		clauses,
		tokens
	};
}

export function lookupSpan(doc: NormalizedDocument, spanId: string): TextSpan | undefined {
	const pools = [
		doc.blocks,
		doc.sections,
		doc.paragraphs,
		doc.sentences,
		doc.clauses,
		doc.tokens
	];
	for (const pool of pools) {
		const hit = pool.find((s) => s.id === spanId);
		if (hit) return hit;
	}
	return undefined;
}

export function quoteMatchesSpan(doc: NormalizedDocument, spanId: string, quote: string): boolean {
	const s = lookupSpan(doc, spanId);
	if (!s) return false;
	const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
	const q = norm(quote);
	// Empty / tiny quotes always "match" via String.includes('') — reject them.
	if (q.length < 8) return false;
	const span = norm(s.text);
	if (!span) return false;
	return span.includes(q) || (q.length <= span.length * 2 && q.includes(span));
}
