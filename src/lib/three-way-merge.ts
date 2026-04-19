import { diffArrays } from 'diff';

const TRAILING_NEWLINE = '\u0000__DOCWRITER_TRAILING_NEWLINE__';

interface Hunk {
	baseStart: number;
	baseEnd: number;
	newTokens: string[];
}

export interface ThreeWayMergeResult {
	mergedText: string;
	appliedHunks: number;
	conflictCount: number;
}

export function mergeAgentEditsIntoCurrent(
	baseText: string,
	currentText: string,
	agentText: string
): ThreeWayMergeResult {
	const baseTokens = textToTokens(baseText);
	const currentTokens = textToTokens(currentText);
	const agentTokens = textToTokens(agentText);

	const userHunks = buildHunks(baseTokens, currentTokens);
	const agentHunks = buildHunks(baseTokens, agentTokens);

	if (agentHunks.length === 0) {
		return {
			mergedText: currentText,
			appliedHunks: 0,
			conflictCount: 0
		};
	}

	const mergedTokens = [...currentTokens];
	let appliedHunks = 0;
	let conflictCount = 0;
	let appliedOffset = 0;

	for (const hunk of agentHunks) {
		if (userHunks.some((userHunk) => hunksOverlap(userHunk, hunk))) {
			conflictCount++;
			continue;
		}

		const start = mapBaseIndexToCurrent(hunk.baseStart, userHunks) + appliedOffset;
		const end = mapBaseIndexToCurrent(hunk.baseEnd, userHunks) + appliedOffset;
		mergedTokens.splice(start, end - start, ...hunk.newTokens);
		appliedOffset += hunk.newTokens.length - (end - start);
		appliedHunks++;
	}

	return {
		mergedText: tokensToText(mergedTokens),
		appliedHunks,
		conflictCount
	};
}

function buildHunks(baseTokens: string[], targetTokens: string[]): Hunk[] {
	const changes = diffArrays(baseTokens, targetTokens);
	const hunks: Hunk[] = [];
	let baseIndex = 0;

	for (let i = 0; i < changes.length; i++) {
		const part = changes[i];
		if (!part.added && !part.removed) {
			baseIndex += part.value.length;
			continue;
		}

		const baseStart = baseIndex;
		let baseEnd = baseIndex;
		const newTokens: string[] = [];

		while (i < changes.length) {
			const change = changes[i];
			if (!change.added && !change.removed) break;
			if (change.removed) {
				baseEnd += change.value.length;
				baseIndex += change.value.length;
			}
			if (change.added) newTokens.push(...change.value);
			i++;
		}

		hunks.push({ baseStart, baseEnd, newTokens });
		i--;
	}

	return hunks;
}

function mapBaseIndexToCurrent(baseIndex: number, userHunks: Hunk[]): number {
	let currentIndex = baseIndex;
	for (const hunk of userHunks) {
		if (hunk.baseEnd <= baseIndex) {
			currentIndex += hunk.newTokens.length - (hunk.baseEnd - hunk.baseStart);
		}
	}
	return currentIndex;
}

function hunksOverlap(a: Hunk, b: Hunk): boolean {
	const aInsert = a.baseStart === a.baseEnd;
	const bInsert = b.baseStart === b.baseEnd;
	if (aInsert && bInsert) return a.baseStart === b.baseStart;
	if (aInsert) return a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd;
	if (bInsert) return b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd;
	return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

function textToTokens(text: string): string[] {
	const normalized = text.replace(/\r\n?/g, '\n');
	if (normalized.length === 0) return [];
	const trailing = normalized.endsWith('\n');
	const body = trailing ? normalized.slice(0, -1) : normalized;
	const tokens = body.length > 0 ? body.split('\n') : [];
	if (trailing) tokens.push(TRAILING_NEWLINE);
	return tokens;
}

function tokensToText(tokens: string[]): string {
	if (tokens.length === 0) return '';
	const trailing = tokens[tokens.length - 1] === TRAILING_NEWLINE;
	const bodyTokens = trailing ? tokens.slice(0, -1) : tokens;
	const body = bodyTokens.join('\n');
	return trailing ? body + '\n' : body;
}
