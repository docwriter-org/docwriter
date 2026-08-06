// @ts-nocheck
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const ANALYZER_VERSION = '1.0.0';

const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|\d+(?:[.,]\d+)*/gu;
const TOKEN_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|\d+(?:[.,]\d+)*|[^\s]/gu;
const TRANSITIONS = /^(however|therefore|moreover|furthermore|instead|for example|for instance|in contrast|in addition|finally|first|second|overall|in sum)\b/i;
const CONJUNCTIONS = new Set(['and', 'but', 'or', 'yet', 'so', 'because', 'although', 'while', 'whereas']);
const HEDGES = new Set(['perhaps', 'possibly', 'probably', 'likely', 'roughly', 'approximately', 'generally', 'usually', 'often', 'sometimes', 'seems', 'appears']);
const MODALS = new Set(['can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would']);
const ATTRIBUTION = new Set(['argues', 'claims', 'finds', 'found', 'shows', 'showed', 'reports', 'reported', 'notes', 'noted', 'states', 'stated', 'suggests', 'suggested']);
const RHETORIC = {
	contrast: ['however', 'but', 'yet', 'whereas', 'in contrast', 'on the other hand'],
	cause: ['because', 'therefore', 'thus', 'consequently', 'as a result'],
	concession: ['although', 'though', 'even though', 'despite', 'nevertheless'],
	example: ['for example', 'for instance', 'e.g.', 'such as'],
	summary: ['overall', 'in sum', 'to summarize', 'in conclusion'],
	addition: ['moreover', 'furthermore', 'in addition', 'also'],
	claim: ['we argue', 'we show', 'this shows', 'this suggests', 'the result', 'the evidence']
};

const FUNCTION_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
	'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'she', 'that',
	'the', 'their', 'they', 'this', 'to', 'was', 'we', 'were', 'which', 'who', 'will', 'with', 'you', 'your'
]);

function hash(value) {
	return createHash('sha256').update(String(value)).digest('hex');
}

function id(prefix, value) {
	return `${prefix}_${hash(value).slice(0, 12)}`;
}

function round(value, digits = 4) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function words(text) {
	return [...text.matchAll(WORD_RE)].map((match) => ({
		text: match[0],
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		normalized: match[0].toLocaleLowerCase()
	}));
}

function percentile(values, fraction) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(values) {
	if (!values.length) {
		return { min: 0, p10: 0, median: 0, p90: 0, max: 0, mean: 0, mad: 0 };
	}
	const median = percentile(values, 0.5);
	return {
		min: round(Math.min(...values)),
		p10: round(percentile(values, 0.1)),
		median: round(median),
		p90: round(percentile(values, 0.9)),
		max: round(Math.max(...values)),
		mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
		mad: round(percentile(values.map((value) => Math.abs(value - median)), 0.5))
	};
}

function mean(values) {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function slope(values) {
	if (values.length < 2) return 0;
	const center = (values.length - 1) / 2;
	const average = mean(values);
	const numerator = values.reduce((sum, value, index) => sum + (index - center) * (value - average), 0);
	const denominator = values.reduce((sum, _value, index) => sum + (index - center) ** 2, 0);
	return denominator ? numerator / denominator : 0;
}

function correlationWithPosition(values) {
	if (values.length < 2) return 0;
	const positions = values.map((_value, index) => index / Math.max(1, values.length - 1));
	const meanValue = mean(values);
	const meanPosition = mean(positions);
	const numerator = values.reduce((sum, value, index) => sum + (value - meanValue) * (positions[index] - meanPosition), 0);
	const denominator = Math.sqrt(
		values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0)
		* positions.reduce((sum, value) => sum + (value - meanPosition) ** 2, 0)
	);
	return denominator ? numerator / denominator : 0;
}

function estimatedSyllables(word) {
	const normalized = word.toLocaleLowerCase().replace(/[^a-z]/g, '');
	if (!normalized) return 0;
	const groups = normalized.replace(/e$/, '').match(/[aeiouy]+/g)?.length ?? 0;
	return Math.max(1, groups);
}

function titleCaseShare(text) {
	const items = words(text).filter((item) => !FUNCTION_WORDS.has(item.normalized));
	return items.length ? items.filter((item) => /^\p{Lu}/u.test(item.text)).length / items.length : 0;
}

function lineSegments(text) {
	const lines = [];
	let start = 0;
	for (const raw of text.split(/(?<=\n)/)) {
		const line = raw.replace(/\r?\n$/, '');
		lines.push({ text: line, start, end: start + line.length });
		start += raw.length;
	}
	if (!lines.length) lines.push({ text, start: 0, end: text.length });
	return lines;
}

function blockSegments(sourceId, text) {
	const lines = lineSegments(text);
	const blocks = [];
	let paragraphStart = null;
	let paragraphEnd = null;
	let paragraphLines = [];
	const flush = () => {
		if (paragraphStart === null) return;
		const blockText = text.slice(paragraphStart, paragraphEnd).trim();
		if (blockText) {
			const leading = text.slice(paragraphStart, paragraphEnd).indexOf(blockText);
			const start = paragraphStart + Math.max(0, leading);
			blocks.push({
				id: id('block', `${sourceId}:${start}:${paragraphEnd}`),
				sourceId,
				start,
				end: start + blockText.length,
				text: blockText,
				kind: 'paragraph'
			});
		}
		paragraphStart = null;
		paragraphEnd = null;
		paragraphLines = [];
	};

	let inCode = false;
	let codeStart = 0;
	for (const line of lines) {
		const trimmed = line.text.trim();
		if (/^```/.test(trimmed)) {
			flush();
			if (!inCode) codeStart = line.start;
			else {
				blocks.push({
					id: id('block', `${sourceId}:${codeStart}:${line.end}`),
					sourceId,
					start: codeStart,
					end: line.end,
					text: text.slice(codeStart, line.end),
					kind: 'code'
				});
			}
			inCode = !inCode;
			continue;
		}
		if (inCode) continue;
		if (!trimmed) {
			flush();
			continue;
		}
		const heading = trimmed.match(/^(#{1,6})\s+(.+)$/) ?? trimmed.match(/^\\(?:section|subsection|subsubsection)\*?\{(.+)\}$/);
		if (heading) {
			flush();
			const headingText = heading[2] ?? heading[1];
			const level = heading[2] ? heading[1].length : trimmed.startsWith('\\section') ? 1 : trimmed.startsWith('\\subsection') ? 2 : 3;
			const local = line.text.indexOf(headingText);
			blocks.push({
				id: id('block', `${sourceId}:${line.start}:${line.end}`),
				sourceId,
				start: line.start + Math.max(0, local),
				end: line.start + Math.max(0, local) + headingText.length,
				text: headingText,
				kind: 'heading',
				level
			});
			continue;
		}
		if (/^\s*(?:[-*+] |\d+[.)] )/.test(line.text)) {
			flush();
			blocks.push({
				id: id('block', `${sourceId}:${line.start}:${line.end}`),
				sourceId,
				start: line.start,
				end: line.end,
				text: trimmed.replace(/^(?:[-*+] |\d+[.)] )/, ''),
				kind: 'list-item'
			});
			continue;
		}
		if (/^\s*>/.test(line.text)) {
			flush();
			blocks.push({
				id: id('block', `${sourceId}:${line.start}:${line.end}`),
				sourceId,
				start: line.start,
				end: line.end,
				text: trimmed.replace(/^>\s?/, ''),
				kind: 'blockquote'
			});
			continue;
		}
		if (/^\|.*\|$/.test(trimmed)) {
			flush();
			blocks.push({
				id: id('block', `${sourceId}:${line.start}:${line.end}`),
				sourceId,
				start: line.start,
				end: line.end,
				text: trimmed,
				kind: 'table'
			});
			continue;
		}
		if (paragraphStart === null) paragraphStart = line.start;
		paragraphEnd = line.end;
		paragraphLines.push(line.text);
	}
	flush();
	return blocks;
}

function sentenceSegments(sourceId, text) {
	const segments = [];
	const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
	for (const part of segmenter.segment(text)) {
		const trimmed = part.segment.trim();
		if (!trimmed || !WORD_RE.test(trimmed)) {
			WORD_RE.lastIndex = 0;
			continue;
		}
		WORD_RE.lastIndex = 0;
		const leading = part.segment.indexOf(trimmed);
		const start = part.index + Math.max(0, leading);
		segments.push({
			id: id('sentence', `${sourceId}:${start}:${start + trimmed.length}`),
			sourceId,
			start,
			end: start + trimmed.length,
			text: trimmed,
			kind: 'sentence',
			wordCount: words(trimmed).length,
			clauseIds: []
		});
	}
	return segments;
}

function clauseSegments(sourceId, sentence) {
	const boundaries = [];
	const boundaryRe = /--|[,;:—–]|\b(?:and|but|or|yet|so|because|although|while|whereas)\b/giu;
	for (const match of sentence.text.matchAll(boundaryRe)) {
		const start = match.index ?? 0;
		if (match[0] === ':' && isFalseColon(sentence.text, start)) continue;
		if (match[0] === ',' && insideCitation(sentence.text, start)) continue;
		boundaries.push({ start, end: start + match[0].length, text: match[0] });
	}
	const clauses = [];
	let localStart = 0;
	for (const boundary of boundaries) {
		const raw = sentence.text.slice(localStart, boundary.start).trim();
		if (raw) {
			const offset = sentence.text.slice(localStart, boundary.start).indexOf(raw);
			const start = sentence.start + localStart + Math.max(0, offset);
			clauses.push({
				id: id('clause', `${sourceId}:${start}:${start + raw.length}`),
				sourceId,
				start,
				end: start + raw.length,
				text: raw,
				kind: 'clause',
				wordCount: words(raw).length,
				boundary: boundary.text
			});
		}
		localStart = boundary.end;
	}
	const raw = sentence.text.slice(localStart).trim();
	if (raw) {
		const offset = sentence.text.slice(localStart).indexOf(raw);
		const start = sentence.start + localStart + Math.max(0, offset);
		clauses.push({
			id: id('clause', `${sourceId}:${start}:${start + raw.length}`),
			sourceId,
			start,
			end: start + raw.length,
			text: raw,
			kind: 'clause',
			wordCount: words(raw).length
		});
	}
	return clauses.length ? clauses : [{
		id: id('clause', `${sourceId}:${sentence.start}:${sentence.end}`),
		sourceId,
		start: sentence.start,
		end: sentence.end,
		text: sentence.text,
		kind: 'clause',
		wordCount: sentence.wordCount
	}];
}

function isFalseColon(text, index) {
	const before = text.slice(Math.max(0, index - 12), index + 12);
	return /(?:https?|ftp)$/i.test(text.slice(Math.max(0, index - 8), index)) || /\b\d{1,2}:\d{2}\b/.test(before);
}

function insideCitation(text, index) {
	const openSquare = text.lastIndexOf('[', index);
	const closeSquare = text.indexOf(']', index);
	const openParen = text.lastIndexOf('(', index);
	const closeParen = text.indexOf(')', index);
	return (openSquare >= 0 && closeSquare > index) || (openParen >= 0 && closeParen > index && /\d{4}/.test(text.slice(openParen, closeParen + 1)));
}

export function normalizeText({ sourceId, role = 'authored', format = 'text', text, contentHash = undefined }) {
	const normalizedText = String(text ?? '').replace(/\r\n/g, '\n').trim();
	const blocks = blockSegments(sourceId, normalizedText);
	const sentences = blocks
		.filter((block) => ['paragraph', 'list-item', 'blockquote'].includes(block.kind))
		.flatMap((block) => {
			const found = normalizedText.indexOf(block.text, block.start);
			const base = found >= block.start && found <= block.end ? found : block.start;
			return sentenceSegments(sourceId, block.text).map((sentence) => {
				const start = base + sentence.start;
				const end = base + sentence.end;
				return {
					...sentence,
					id: id('sentence', `${sourceId}:${start}:${end}`),
					start,
					end
				};
			});
		});
	const clauses = [];
	for (const sentence of sentences) {
		const sentenceClauses = clauseSegments(sourceId, sentence);
		sentence.clauseIds = sentenceClauses.map((clause) => clause.id);
		clauses.push(...sentenceClauses);
	}
	const tokens = [...normalizedText.matchAll(TOKEN_RE)].map((match) => {
		const value = match[0];
		const start = match.index ?? 0;
		return {
			id: id('token', `${sourceId}:${start}:${value}`),
			sourceId,
			start,
			end: start + value.length,
			text: value,
			kind: /^\d/.test(value) ? 'number' : /^[\p{L}\p{M}]/u.test(value) ? 'word' : 'punctuation',
			normalized: value.toLocaleLowerCase()
		};
	});
	const paragraphs = blocks.filter((block) => block.kind === 'paragraph').map((block) => {
		const contained = sentences.filter((sentence) => sentence.start >= block.start && sentence.end <= block.end);
		return {
			...block,
			id: id('paragraph', `${sourceId}:${block.start}:${block.end}`),
			kind: 'paragraph',
			wordCount: words(block.text).length,
			sentenceIds: contained.map((sentence) => sentence.id)
		};
	});
	const headings = blocks.filter((block) => block.kind === 'heading');
	const sections = headings.map((heading, index) => {
		const next = headings.slice(index + 1).find((candidate) => (candidate.level ?? 1) <= (heading.level ?? 1));
		const end = next?.start ?? normalizedText.length;
		return {
			id: id('section', `${sourceId}:${heading.start}:${end}`),
			sourceId,
			start: heading.start,
			end,
			text: normalizedText.slice(heading.start, end),
			kind: 'section',
			level: heading.level ?? 1,
			heading: heading.text,
			blockIds: blocks.filter((block) => block.start >= heading.start && block.end <= end).map((block) => block.id)
		};
	});
	return {
		sourceId,
		role,
		format,
		contentHash: contentHash || hash(normalizedText),
		text: normalizedText,
		blocks,
		sections,
		paragraphs,
		sentences,
		clauses,
		tokens
	};
}

function containingSentence(document, start) {
	return document.sentences.find((sentence) => sentence.start <= start && sentence.end >= start);
}

function punctuationOccurrences(document) {
	const occurrences = [];
	const consumed = new Set();
	const nestingDepthAt = (text, index) => {
		const stack = [];
		let straightDoubleQuoteOpen = false;
		let straightSingleQuoteOpen = false;
		for (let cursor = 0; cursor < index; cursor += 1) {
			const character = text[cursor];
			if (character === '(' || character === '[') stack.push(character);
			else if (character === ')' && stack.at(-1) === '(') stack.pop();
			else if (character === ']' && stack.at(-1) === '[') stack.pop();
			else if (character === '“') stack.push(character);
			else if (character === '”' && stack.at(-1) === '“') stack.pop();
			else if (character === '‘') stack.push(character);
			else if (character === '’' && stack.at(-1) === '‘') stack.pop();
			else if (character === '"') straightDoubleQuoteOpen = !straightDoubleQuoteOpen;
			else if (character === "'" && !(/[\p{L}]/u.test(text[cursor - 1] ?? '') && /[\p{L}]/u.test(text[cursor + 1] ?? ''))) straightSingleQuoteOpen = !straightSingleQuoteOpen;
		}
		return stack.length + Number(straightDoubleQuoteOpen) + Number(straightSingleQuoteOpen);
	};
	const isFalsePeriod = (text, index) => {
		if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return true;
		const whitespaceStart = Math.max(text.lastIndexOf(' ', index), text.lastIndexOf('\n', index), text.lastIndexOf('\t', index)) + 1;
		const whitespaceEnds = [text.indexOf(' ', index), text.indexOf('\n', index), text.indexOf('\t', index)].filter((value) => value >= 0);
		const whitespaceEnd = whitespaceEnds.length ? Math.min(...whitespaceEnds) : text.length;
		const surroundingToken = text.slice(whitespaceStart, whitespaceEnd).replace(/[),;!?]+$/g, '');
		if (/^(?:https?:\/\/|www\.)/i.test(surroundingToken)) {
			const urlWithoutTerminalPunctuation = surroundingToken.replace(/[.,;!?]+$/g, '');
			if (index < whitespaceStart + urlWithoutTerminalPunctuation.length) return true;
		}
		let tokenStart = index;
		let tokenEnd = index + 1;
		while (tokenStart > 0 && /[\p{L}.]/u.test(text[tokenStart - 1])) tokenStart -= 1;
		while (tokenEnd < text.length && /[\p{L}.]/u.test(text[tokenEnd])) tokenEnd += 1;
		const token = text.slice(tokenStart, tokenEnd);
		const abbreviation = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(token)
			|| /^(?:e\.g\.|i\.e\.)$/i.test(token)
			|| /^(?:[\p{L}]\.){2,}$/u.test(token)
			|| /^al\.$/i.test(token) && /\bet\s+$/i.test(text.slice(Math.max(0, tokenStart - 4), tokenStart));
		return abbreviation && text.slice(tokenEnd).trimStart().length > 0;
	};
	const add = (metric, start, end, raw, kind, extra = {}) => {
		for (let i = start; i < end; i += 1) consumed.add(i);
		const sentence = containingSentence(document, start);
		const local = sentence ? start - sentence.start : 0;
		const leftText = sentence?.text.slice(0, local) ?? document.text.slice(Math.max(0, start - 80), start);
		const rightText = sentence?.text.slice(local + raw.length) ?? document.text.slice(end, end + 80);
		const leftBoundary = Math.max(leftText.lastIndexOf(','), leftText.lastIndexOf(';'), leftText.lastIndexOf(':'), leftText.lastIndexOf('—'), leftText.lastIndexOf('–'), leftText.lastIndexOf('--'));
		const rightCandidates = [',', ';', ':', '—', '–', '--'].map((mark) => rightText.indexOf(mark)).filter((index) => index >= 0);
		const rightBoundary = rightCandidates.length ? Math.min(...rightCandidates) : rightText.length;
		const after = rightText.trimStart().match(/^([\p{L}]+)/u)?.[1]?.toLocaleLowerCase() ?? null;
		const likelyFunction = raw === ':' ? 'introduction-or-explanation'
			: raw === ';' ? 'independent-clause-link'
			: raw === '—' || raw === '–' || raw === '--' ? 'aside-or-emphasis'
			: raw === ',' ? 'list-modifier-or-clause-link'
			: kind === 'conjunction' ? 'coordination-or-subordination'
			: kind;
		occurrences.push({
			id: id('occurrence', `${document.sourceId}:${metric}:${start}:${end}`),
			metricId: metric,
			family: 'punctuation',
			sourceId: document.sourceId,
			start,
			end,
			text: raw,
			value: raw,
			context: {
				kind,
				leftClauseWords: words(leftText.slice(leftBoundary + 1)).length,
				rightClauseWords: words(rightText.slice(0, rightBoundary)).length,
				normalizedPosition: sentence ? round(local / Math.max(1, sentence.text.length)) : 0,
				followingConjunction: after && CONJUNCTIONS.has(after) ? after : null,
				nestingDepth: nestingDepthAt(document.text, start),
				likelyFunction,
				sentenceText: sentence?.text ?? '',
				...extra
			}
		});
	};

	for (const match of document.text.matchAll(/\.{2,}|[!?]{2,}/g)) {
		const start = match.index ?? 0;
		const metric = /^\.+$/.test(match[0]) ? 'punctuation.sequence.repeated-period' : /[!?].*[!?]/.test(match[0]) && match[0].includes('!') && match[0].includes('?') ? 'punctuation.sequence.mixed-question-exclamation' : match[0][0] === '!' ? 'punctuation.sequence.repeated-exclamation' : 'punctuation.sequence.repeated-question';
		add(metric, start, start + match[0].length, match[0], 'sequence');
		if (/^\.{3,}$/.test(match[0])) add('punctuation.terminal.ellipsis', start, start + match[0].length, match[0], 'terminal');
	}
	for (const match of document.text.matchAll(/--/g)) {
		const start = match.index ?? 0;
		if (!consumed.has(start)) add('punctuation.boundary.double-hyphen', start, start + 2, '--', 'clause-boundary');
	}

	const singles = {
		'.': 'punctuation.terminal.period',
		'?': 'punctuation.terminal.question',
		'!': 'punctuation.terminal.exclamation',
		',': 'punctuation.boundary.comma',
		';': 'punctuation.boundary.semicolon',
		':': 'punctuation.boundary.colon',
		'—': 'punctuation.boundary.em-dash',
		'–': 'punctuation.boundary.en-dash',
		'(': 'punctuation.enclosure.parenthesis-open',
		')': 'punctuation.enclosure.parenthesis-close',
		'[': 'punctuation.enclosure.bracket-open',
		']': 'punctuation.enclosure.bracket-close',
		'"': 'punctuation.enclosure.double-quote',
		"'": 'punctuation.enclosure.single-quote',
		'“': 'punctuation.enclosure.double-quote',
		'”': 'punctuation.enclosure.double-quote',
		'‘': 'punctuation.enclosure.single-quote',
		'’': 'punctuation.enclosure.single-quote'
	};
	for (let index = 0; index < document.text.length; index += 1) {
		const raw = document.text[index];
		const metric = singles[raw];
		if (!metric || consumed.has(index)) continue;
		if (raw === '.' && isFalsePeriod(document.text, index)) continue;
		if (raw === ':' && isFalseColon(document.text, index)) continue;
		if (raw === ',' && insideCitation(document.text, index)) continue;
		if ((raw === "'" || raw === '’') && /[\p{L}]/u.test(document.text[index - 1] ?? '') && /[\p{L}]/u.test(document.text[index + 1] ?? '')) continue;
		const kind = metric.includes('.terminal.') ? 'terminal' : metric.includes('.boundary.') ? 'clause-boundary' : 'enclosure';
		add(metric, index, index + 1, raw, kind);
	}

	for (const match of document.text.matchAll(/\b(and|but|or|yet|so|because|although|while|whereas)\b/giu)) {
		const start = match.index ?? 0;
		const before = document.text.slice(0, start).trimEnd().slice(-1);
		if (/[,:;—–-]/.test(before)) continue;
		add(`punctuation.boundary.conjunction.${match[1].toLocaleLowerCase()}`, start, start + match[0].length, match[0], 'conjunction');
	}
	return occurrences;
}

function countMatches(text, regex) {
	return [...text.matchAll(regex)].length;
}

function movingTypeTokenRatio(tokens, window = 50) {
	if (!tokens.length) return 0;
	if (tokens.length <= window) return new Set(tokens).size / tokens.length;
	let total = 0;
	let windows = 0;
	for (let index = 0; index <= tokens.length - window; index += window) {
		total += new Set(tokens.slice(index, index + window)).size / window;
		windows += 1;
	}
	return windows ? total / windows : 0;
}

function metricSpecForDocument(document, punctuation) {
	const wordTokens = document.tokens.filter((token) => token.kind === 'word');
	const normalizedWords = wordTokens.map((token) => token.normalized);
	const wordCount = normalizedWords.length;
	const per1000 = (count) => wordCount ? count * 1000 / wordCount : 0;
	const paragraphs = document.paragraphs;
	const sentences = document.sentences;
	const sentenceLengths = sentences.map((sentence) => sentence.wordCount);
	const paragraphLengths = paragraphs.map((paragraph) => paragraph.wordCount);
	const headingBlocks = document.blocks.filter((block) => block.kind === 'heading');
	const listBlocks = document.blocks.filter((block) => block.kind === 'list-item');
	const tableBlocks = document.blocks.filter((block) => block.kind === 'table');
	const blockCount = Math.max(1, document.blocks.length);
	const sentenceCount = Math.max(1, sentences.length);
	const paragraphCount = Math.max(1, paragraphs.length);
	const counts = (set) => normalizedWords.filter((word) => set.has(word)).length;
	const firstPerson = new Set(['i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours']);
	const secondPerson = new Set(['you', 'your', 'yours']);
	const thirdPerson = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'his', 'their', 'theirs']);
	const contractionCount = wordTokens.filter((token) => /['’]/.test(token.text)).length;
	const passiveCount = countMatches(document.text, /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/giu);
	const nominalizationCount = normalizedWords.filter((word) => /(?:tion|sion|ment|ness|ity|ance|ence)$/.test(word)).length;
	const abbreviationCount = countMatches(document.text, /\b(?:[A-Z]{2,}|(?:[A-Z]\.){2,})\b/g);
	const transitionCount = paragraphs.filter((paragraph) => TRANSITIONS.test(paragraph.text)).length;
	const emphasisCount = countMatches(document.text, /(?:\*\*|__)[^\n]+?(?:\*\*|__)/g);
	const inlineCodeCount = countMatches(document.text, /`[^`\n]+`/g);
	const linkCount = countMatches(document.text, /\[[^\]]+\]\([^)]+\)|https?:\/\/\S+/g);
	const citationCount = countMatches(document.text, /\[[0-9,;\s-]+\]|\([A-Z][A-Za-z'’.-]+(?:\s+(?:et al\.|and)\s+[A-Z][A-Za-z'’.-]+)?,?\s+\d{4}[a-z]?\)|\\cite\w*\{[^}]+\}/g);
	const footnoteCount = countMatches(document.text, /\[\^[^\]]+\]|\\footnote\{/g);
	const quoteCount = countMatches(document.text, /(?:"[^"\n]+"|“[^”\n]+”)/g);
	const attributionCount = counts(ATTRIBUTION);
	const clausesPerSentence = sentences.map((sentence) => sentence.clauseIds.length);
	const sectionWordCounts = document.sections.map((section) => words(section.text).length);
	const firstSectionWords = sectionWordCounts[0] ?? paragraphLengths[0] ?? 0;
	const lastSectionWords = sectionWordCounts.at(-1) ?? paragraphLengths.at(-1) ?? 0;
	const sectionEdgeBlocks = document.sections.map((section) => {
		const blocks = section.blockIds
			.map((blockId) => document.blocks.find((block) => block.id === blockId))
			.filter((block) => block && block.kind !== 'heading');
		return {
			opening: words(blocks[0]?.text ?? '').length,
			closing: words(blocks.at(-1)?.text ?? '').length
		};
	});
	const paragraphSentenceLengths = paragraphs.map((paragraph) => paragraph.sentenceIds
		.map((sentenceId) => sentences.find((sentence) => sentence.id === sentenceId)?.wordCount ?? 0)
		.filter(Boolean));
	const consecutiveSentenceDifferences = sentenceLengths.slice(1).map((value, index) => Math.abs(value - sentenceLengths[index]));
	const alternatingSentenceRate = sentenceLengths.length > 1
		? sentenceLengths.slice(1).filter((value, index) => (value <= 10) !== (sentenceLengths[index] <= 10)).length / (sentenceLengths.length - 1)
		: 0;
	const pastTenseCount = normalizedWords.filter((word) => /ed$/.test(word) || ['was', 'were', 'had', 'did'].includes(word)).length;
	const presentTenseCount = normalizedWords.filter((word) => ['am', 'is', 'are', 'has', 'have', 'do', 'does'].includes(word)).length;
	const imperativeCount = sentences.filter((sentence) => /^(?:use|write|keep|avoid|choose|add|remove|make|run|check|set|start|end|explain|show|state)\b/i.test(sentence.text)).length;
	const contentWords = normalizedWords.filter((word) => !FUNCTION_WORDS.has(word) && word.length > 2);
	const contentFrequencies = new Map();
	for (const word of contentWords) contentFrequencies.set(word, (contentFrequencies.get(word) ?? 0) + 1);
	const repeatedContentShare = contentWords.length ? Math.max(0, ...contentFrequencies.values()) / contentWords.length : 0;
	const discourseMarkerCount = Object.values(RHETORIC).flat().reduce((sum, phrase) =>
		sum + countMatches(document.text, new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu')), 0);
	const citationPattern = /\[[0-9,;\s-]+\]|\([A-Z][A-Za-z'’.-]+(?:\s+(?:et al\.|and)\s+[A-Z][A-Za-z'’.-]+)?,?\s+\d{4}[a-z]?\)|\\cite\w*\{[^}]+\}/g;
	const citationMatches = [...document.text.matchAll(citationPattern)];
	const citationEndRate = citationMatches.length ? citationMatches.filter((match) => {
		const sentence = containingSentence(document, match.index ?? 0);
		return sentence ? ((match.index ?? 0) - sentence.start) / Math.max(1, sentence.text.length) >= 0.55 : false;
	}).length / citationMatches.length : 0;
	const titleCaseRates = headingBlocks.map((block) => titleCaseShare(block.text));
	const sentenceCaseRate = headingBlocks.length ? headingBlocks.filter((block) => /^\p{Lu}[^\n]*$/u.test(block.text) && titleCaseShare(block.text) < 0.8).length / headingBlocks.length : 0;
	const allCapsCount = wordTokens.filter((token) => token.text.length > 1 && /^\p{Lu}+$/u.test(token.text)).length;
	const spec = {
		'document-organization.section-count': document.sections.length,
		'document-organization.block-count': document.blocks.length,
		'document-organization.paragraph-count': paragraphs.length,
		'document-organization.word-count': wordCount,
		'document-organization.heading-depth': headingBlocks.length ? Math.max(...headingBlocks.map((block) => block.level ?? 1)) : 0,
		'document-organization.section-words': mean(sectionWordCounts),
		'document-organization.section-size-variation': distribution(sectionWordCounts).mad,
		'document-organization.opening-share': wordCount ? firstSectionWords / wordCount : 0,
		'document-organization.closing-share': wordCount ? lastSectionWords / wordCount : 0,
		'document-organization.list-density': listBlocks.length / blockCount,
		'document-organization.table-density': tableBlocks.length / blockCount,
		'section-structure.heading-words': mean(headingBlocks.map((block) => words(block.text).length)),
		'section-structure.heading-depth-variation': distribution(headingBlocks.map((block) => block.level ?? 1)).mad,
		'section-structure.heading-question-rate': headingBlocks.length ? headingBlocks.filter((block) => /\?$/.test(block.text)).length / headingBlocks.length : 0,
		'section-structure.heading-title-case-rate': mean(titleCaseRates),
		'section-structure.opening-block-words': mean(sectionEdgeBlocks.map((edge) => edge.opening)),
		'section-structure.closing-block-words': mean(sectionEdgeBlocks.map((edge) => edge.closing)),
		'section-structure.paragraphs-per-section': document.sections.length ? paragraphs.length / document.sections.length : paragraphs.length,
		'section-structure.transition-opening-rate': transitionCount / paragraphCount,
		'paragraph-structure.words': mean(paragraphLengths),
		'paragraph-structure.sentences': mean(paragraphs.map((paragraph) => paragraph.sentenceIds.length)),
		'paragraph-structure.clauses': mean(paragraphs.map((paragraph) => paragraph.sentenceIds.reduce((sum, sentenceId) => sum + (sentences.find((sentence) => sentence.id === sentenceId)?.clauseIds.length ?? 0), 0))),
		'paragraph-structure.opening-sentence-words': mean(paragraphSentenceLengths.map((lengths) => lengths[0] ?? 0)),
		'paragraph-structure.closing-sentence-words': mean(paragraphSentenceLengths.map((lengths) => lengths.at(-1) ?? 0)),
		'paragraph-structure.sentence-length-slope': mean(paragraphSentenceLengths.map(slope)),
		'paragraph-structure.length-position-correlation': correlationWithPosition(paragraphLengths),
		'paragraph-structure.short-rate': paragraphLengths.filter((value) => value <= 40).length / paragraphCount,
		'sentence-rhythm.words': mean(sentenceLengths),
		'sentence-rhythm.words-p10': percentile(sentenceLengths, 0.1),
		'sentence-rhythm.words-median': percentile(sentenceLengths, 0.5),
		'sentence-rhythm.words-p90': percentile(sentenceLengths, 0.9),
		'sentence-rhythm.length-variation': distribution(sentenceLengths).mad,
		'sentence-rhythm.consecutive-length-difference': mean(consecutiveSentenceDifferences),
		'sentence-rhythm.short-long-alternation-rate': alternatingSentenceRate,
		'sentence-rhythm.clauses': mean(clausesPerSentence),
		'sentence-rhythm.short-sentence-rate': sentences.filter((sentence) => sentence.wordCount <= 8).length / sentenceCount,
		'sentence-rhythm.long-sentence-rate': sentences.filter((sentence) => sentence.wordCount >= 25).length / sentenceCount,
		'sentence-rhythm.question-rate': sentences.filter((sentence) => /\?\s*$/.test(sentence.text)).length / sentenceCount,
		'sentence-rhythm.fragment-rate': sentences.filter((sentence) => sentence.wordCount <= 4 && !/[.!?]\s*$/.test(sentence.text)).length / sentenceCount,
		'grammar-voice.first-person-per-1000': per1000(counts(firstPerson)),
		'grammar-voice.second-person-per-1000': per1000(counts(secondPerson)),
		'grammar-voice.third-person-per-1000': per1000(counts(thirdPerson)),
		'grammar-voice.modal-per-1000': per1000(counts(MODALS)),
		'grammar-voice.hedge-per-1000': per1000(counts(HEDGES)),
		'grammar-voice.contraction-per-1000': per1000(contractionCount),
		'grammar-voice.passive-proxy-per-1000': per1000(passiveCount),
		'grammar-voice.past-tense-proxy-per-1000': per1000(pastTenseCount),
		'grammar-voice.present-tense-proxy-per-1000': per1000(presentTenseCount),
		'grammar-voice.future-signal-per-1000': per1000(normalizedWords.filter((word) => word === 'will' || word === 'shall').length),
		'grammar-voice.imperative-signal-rate': imperativeCount / sentenceCount,
		'vocabulary-register.mattr': movingTypeTokenRatio(normalizedWords),
		'vocabulary-register.word-characters': mean(wordTokens.map((token) => token.text.length)),
		'vocabulary-register.syllables-per-word': mean(wordTokens.map((token) => estimatedSyllables(token.text))),
		'vocabulary-register.lexical-density': wordCount ? contentWords.length / wordCount : 0,
		'vocabulary-register.repeated-content-share': repeatedContentShare,
		'vocabulary-register.long-word-rate': wordTokens.filter((token) => token.text.length >= 10).length / Math.max(1, wordTokens.length),
		'vocabulary-register.nominalization-per-1000': per1000(nominalizationCount),
		'vocabulary-register.abbreviation-per-1000': per1000(abbreviationCount),
		'vocabulary-register.discourse-marker-per-1000': per1000(discourseMarkerCount),
		'rhetorical-structure.question-per-1000': per1000(sentences.filter((sentence) => /\?\s*$/.test(sentence.text)).length),
		'evidence-citations.citation-per-1000': per1000(citationCount),
		'evidence-citations.citation-position': citationMatches.length ? mean(citationMatches.map((match) => (match.index ?? 0) / Math.max(1, document.text.length))) : 0,
		'evidence-citations.citation-ending-rate': citationEndRate,
		'evidence-citations.attribution-per-1000': per1000(attributionCount),
		'evidence-citations.quote-per-1000': per1000(quoteCount),
		'evidence-citations.link-per-1000': per1000(linkCount),
		'evidence-citations.footnote-per-1000': per1000(footnoteCount),
		'formatting.heading-density': headingBlocks.length / blockCount,
		'formatting.heading-title-case-rate': mean(titleCaseRates),
		'formatting.heading-sentence-case-rate': sentenceCaseRate,
		'formatting.list-density': listBlocks.length / blockCount,
		'formatting.table-density': tableBlocks.length / blockCount,
		'formatting.code-density': document.blocks.filter((block) => block.kind === 'code').length / blockCount,
		'formatting.emphasis-per-1000': per1000(emphasisCount),
		'formatting.inline-code-per-1000': per1000(inlineCodeCount),
		'formatting.blockquote-density': document.blocks.filter((block) => block.kind === 'blockquote').length / blockCount,
		'formatting.line-break-per-1000': per1000(countMatches(document.text, /\n/g)),
		'formatting.all-caps-per-1000': per1000(allCapsCount)
	};
	for (const [category, phrases] of Object.entries(RHETORIC)) {
		const positions = phrases.flatMap((phrase) => [...document.text.matchAll(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu'))].map((match) => (match.index ?? 0) / Math.max(1, document.text.length)));
		spec[`rhetorical-structure.${category}-per-1000`] = per1000(positions.length);
		spec[`rhetorical-structure.${category}-position`] = positions.length ? mean(positions) : 0;
	}
	for (const occurrence of punctuation) {
		spec[occurrence.metricId] = (spec[occurrence.metricId] ?? 0) + per1000(1);
	}
	return { spec, sentenceLengths, paragraphLengths, wordCount };
}

const FAMILY_LABELS = {
	'document-organization': 'Document organization',
	'section-structure': 'Section structure',
	'paragraph-structure': 'Paragraph structure',
	'sentence-rhythm': 'Sentence and rhythm',
	'grammar-voice': 'Grammar and voice',
	'vocabulary-register': 'Vocabulary and register',
	punctuation: 'Punctuation',
	'rhetorical-structure': 'Rhetorical structure',
	'evidence-citations': 'Evidence and citations',
	formatting: 'Formatting'
};

function metricFamily(metricId) {
	return metricId.split('.').slice(0, metricId.startsWith('punctuation.') ? 1 : 1)[0];
}

function metricUnit(metricId) {
	if (metricId.includes('per-1000') || metricId.startsWith('punctuation.')) return 'per-1000-words';
	if (metricId.includes('words') || metricId.includes('characters')) return 'words';
	if (metricId.includes('count') || metricId.includes('depth')) return 'count';
	if (metricId.includes('density') || metricId.includes('rate') || metricId.includes('mattr')) return 'ratio';
	return 'score';
}

function metricLabel(metricId) {
	const [family, ...parts] = metricId.split('.');
	return `${FAMILY_LABELS[family] ?? family}: ${parts.join(' ').replace(/-/g, ' ')}`;
}

function metricReliability(metricId) {
	if (metricId.startsWith('rhetorical-structure.')) return 0.72;
	if (metricId.includes('passive-proxy')) return 0.7;
	if (metricId.includes('nominalization')) return 0.8;
	if (metricId.startsWith('punctuation.')) return 0.96;
	return 0.9;
}

function exampleForOccurrence(document, occurrence) {
	const sentence = containingSentence(document, occurrence.start);
	if (!sentence) return null;
	return {
		id: id('example', `${occurrence.metricId}:${sentence.id}`),
		sourceId: document.sourceId,
		start: sentence.start,
		end: sentence.end,
		text: sentence.text,
		kind: occurrence.metricId
	};
}

function representativeExamples(document) {
	const output = [];
	const add = (family, span, suffix) => {
		if (!span?.text?.trim()) return;
		output.push({
			id: id('example', `${document.sourceId}:${family}:${suffix}:${span.start}:${span.end}`),
			sourceId: document.sourceId,
			start: span.start,
			end: span.end,
			text: span.text.trim(),
			kind: family
		});
	};
	for (const block of document.blocks.filter((item) => item.kind === 'heading').slice(0, 3)) {
		add('document-organization', block, 'heading');
		add('section-structure', block, 'heading');
		add('formatting', block, 'heading');
	}
	const paragraphs = document.paragraphs;
	for (const paragraph of [paragraphs[0], paragraphs[Math.floor(paragraphs.length / 2)], paragraphs.at(-1)]) {
		add('paragraph-structure', paragraph, 'paragraph');
		add('rhetorical-structure', paragraph, 'paragraph');
	}
	const sortedSentences = [...document.sentences].sort((a, b) => a.wordCount - b.wordCount);
	for (const sentence of [sortedSentences[0], sortedSentences[Math.floor(sortedSentences.length / 2)], sortedSentences.at(-1)]) {
		add('sentence-rhythm', sentence, 'sentence');
		add('grammar-voice', sentence, 'sentence');
		add('vocabulary-register', sentence, 'sentence');
	}
	for (const sentence of document.sentences.filter((item) => /\[[^\]]+\]|\([^)]*\d{4}[^)]*\)|\\cite|https?:\/\//.test(item.text)).slice(0, 3)) {
		add('evidence-citations', sentence, 'evidence');
	}
	return output;
}

export function analyzeDocuments(documents) {
	const createdAt = Date.now();
	const sourceSnapshotHash = hash(documents.map((document) => `${document.sourceId}:${document.role}:${document.contentHash}`).sort().join('|'));
	const occurrences = [];
	const examples = [];
	const perDocument = [];

	for (const document of documents) {
		const punctuation = punctuationOccurrences(document);
		occurrences.push(...punctuation);
		const seenExamples = new Set();
		for (const occurrence of punctuation) {
			const example = exampleForOccurrence(document, occurrence);
			if (example && !seenExamples.has(example.id)) {
				seenExamples.add(example.id);
				examples.push(example);
			}
		}
		for (const example of representativeExamples(document)) {
			if (!seenExamples.has(example.id)) {
				seenExamples.add(example.id);
				examples.push(example);
			}
		}
		perDocument.push({ document, punctuation, ...metricSpecForDocument(document, punctuation) });
	}

	const metricIds = new Set(perDocument.flatMap((entry) => Object.keys(entry.spec)));
	const measurements = [];
	for (const metricId of [...metricIds].sort()) {
		const values = perDocument.map((entry) => Number(entry.spec[metricId] ?? 0));
		const authoredValues = perDocument.filter((entry) => entry.document.role === 'authored').map((entry) => Number(entry.spec[metricId] ?? 0));
		const inspirationValues = perDocument.filter((entry) => entry.document.role === 'inspiration').map((entry) => Number(entry.spec[metricId] ?? 0));
		const metricOccurrences = occurrences.filter((occurrence) => occurrence.metricId === metricId);
		measurements.push({
			id: metricId,
			family: metricFamily(metricId),
			label: metricLabel(metricId),
			unit: metricUnit(metricId),
			value: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
			count: metricOccurrences.length,
			sourceCount: perDocument.filter((entry) => Number(entry.spec[metricId] ?? 0) !== 0).length,
			roleValues: {
				...(authoredValues.length ? { authored: round(authoredValues.reduce((a, b) => a + b, 0) / authoredValues.length) } : {}),
				...(inspirationValues.length ? { inspiration: round(inspirationValues.reduce((a, b) => a + b, 0) / inspirationValues.length) } : {})
			},
			distribution: distribution(values),
			reliability: metricReliability(metricId),
			occurrenceIds: metricOccurrences.map((occurrence) => occurrence.id)
		});
	}

	return {
		schemaVersion: 1,
		analyzerVersion: ANALYZER_VERSION,
		createdAt,
		sourceSnapshotHash,
		documents: perDocument.map((entry) => ({
			sourceId: entry.document.sourceId,
			role: entry.document.role,
			format: entry.document.format,
			contentHash: entry.document.contentHash,
			wordCount: entry.wordCount
		})),
		measurements,
		occurrences,
		examples: examples.slice(0, 500)
	};
}

export function analyzeText(input) {
	const document = normalizeText({
		sourceId: input.sourceId ?? 'source',
		role: input.role ?? 'authored',
		format: input.format ?? 'text',
		text: input.text ?? ''
	});
	return analyzeDocuments([document]);
}

async function cli() {
	const args = process.argv.slice(2);
	const inputIndex = args.indexOf('--input');
	const outputIndex = args.indexOf('--output');
	if (inputIndex < 0) {
		throw new Error('Usage: analyze-style.mjs --input <file> [--output <file>] [--role authored|inspiration]');
	}
	const path = args[inputIndex + 1];
	const roleIndex = args.indexOf('--role');
	const role = roleIndex >= 0 ? args[roleIndex + 1] : 'authored';
	const text = await readFile(path, 'utf8');
	const report = analyzeText({ sourceId: path, role, format: path.split('.').pop() ?? 'text', text });
	const result = `${JSON.stringify(report, null, 2)}\n`;
	if (outputIndex >= 0) await writeFile(args[outputIndex + 1], result, 'utf8');
	else process.stdout.write(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	cli().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
