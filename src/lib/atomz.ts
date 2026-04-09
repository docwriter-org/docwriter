import type { Fragment, Rule, Sentence, EditorPin, Section } from './types';

export interface AtomzAtom {
	id: string;
	subject: string;
	predicate: string;
	transition?: string;
	children: AtomzAtom[];
}

export interface AtomzRule {
	id: string;
	text: string;
}

export interface AtomzHeadingBlock {
	id: string;
	type: 'heading';
	level: 1 | 2 | 3;
	text: string;
}

export interface AtomzMarkdownBlock {
	id: string;
	type: 'markdown';
	markdown: string;
	atomIds: string[];
}

export type AtomzBlock = AtomzHeadingBlock | AtomzMarkdownBlock;

export interface AtomzPinAnchorAtom {
	type: 'atom';
	atomId: string;
}

export interface AtomzPinAnchorBlock {
	type: 'block';
	blockId: string;
}

export type AtomzPinAnchor = AtomzPinAnchorAtom | AtomzPinAnchorBlock;

export interface AtomzPin {
	id: string;
	kind: 'verbatim';
	value: string;
	anchors: AtomzPinAnchor[];
}

export interface AtomzFileV2 {
	version: 2;
	source?: string;
	tag?: string;
	atoms: AtomzAtom[];
	rules: AtomzRule[];
	blocks: AtomzBlock[];
	pins?: AtomzPin[];
}

export interface RenderDocument {
	atoms: Array<AtomzAtom & { pinnedWords?: string[] }>;
	rules: string[];
	prose: Array<{ id: string; frags: string[]; para: number; text: string }>;
}

export interface CanonicalRuntimeState {
	atoms: Fragment[];
	rules: Rule[];
	blocks: AtomzBlock[];
	pins: AtomzPin[];
}

export interface RuntimeDocumentState {
	atoms: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: number[];
	editorPins: EditorPin[];
	sections: Section[];
}

function normalizePinnedText(text: string): string {
	const normalized = text.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
	return normalized || text.trim().toLowerCase();
}

function cloneAtoms(atoms: AtomzAtom[]): AtomzAtom[] {
	return atoms.map((atom) => ({
		...atom,
		children: cloneAtoms(atom.children || [])
	}));
}

function stripPinnedWords(atom: AtomzAtom & { pinnedWords?: string[] }): AtomzAtom {
	return {
		id: atom.id,
		subject: atom.subject,
		predicate: atom.predicate,
		...(atom.transition ? { transition: atom.transition } : {}),
		children: (atom.children || []).map((child) => stripPinnedWords(child as AtomzAtom & { pinnedWords?: string[] }))
	};
}

function buildTopLevelIndexMap(atoms: AtomzAtom[]): Map<string, number> {
	const map = new Map<string, number>();
	function walk(atom: AtomzAtom, topLevelIndex: number) {
		map.set(atom.id, topLevelIndex);
		for (const child of atom.children || []) walk(child, topLevelIndex);
	}
	atoms.forEach((atom, index) => walk(atom, index));
	return map;
}

function getTopLevelIndexForAtomIds(atomIds: string[], indexMap: Map<string, number>): number | null {
	const indexes = atomIds
		.map((atomId) => indexMap.get(atomId))
		.filter((index): index is number => typeof index === 'number');
	if (indexes.length === 0) return null;
	return Math.min(...indexes);
}

function buildSectionsFromBlocks(blocks: AtomzBlock[], atoms: AtomzAtom[]): Section[] {
	const topLevelIndexMap = buildTopLevelIndexMap(atoms);
	return blocks.flatMap((block, blockIndex) => {
		if (block.type !== 'heading') return [];
		for (let i = blockIndex + 1; i < blocks.length; i++) {
			const candidate = blocks[i];
			if (candidate.type !== 'markdown') continue;
			const beforeAtomIndex = getTopLevelIndexForAtomIds(candidate.atomIds, topLevelIndexMap);
			return [{
				title: block.text,
				beforeAtomIndex: beforeAtomIndex ?? atoms.length
			}];
		}
		return [{
			title: block.text,
			beforeAtomIndex: atoms.length
		}];
	});
}

function buildParaBreaksFromBlocks(blocks: AtomzBlock[], atoms: AtomzAtom[]): number[] {
	const topLevelIndexMap = buildTopLevelIndexMap(atoms);
	const breaks = new Set<number>();
	let seenFirstParagraph = false;
	for (const block of blocks) {
		if (block.type !== 'markdown') continue;
		const beforeAtomIndex = getTopLevelIndexForAtomIds(block.atomIds, topLevelIndexMap);
		if (!seenFirstParagraph) {
			seenFirstParagraph = true;
			continue;
		}
		if (beforeAtomIndex !== null && beforeAtomIndex > 0) breaks.add(beforeAtomIndex);
	}
	return [...breaks].sort((a, b) => a - b);
}

function buildAtomPinnedWordMap(pins: AtomzPin[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const pin of pins) {
		for (const anchor of pin.anchors) {
			if (anchor.type !== 'atom') continue;
			const current = map.get(anchor.atomId) || [];
			if (!current.some((value) => normalizePinnedText(value) === normalizePinnedText(pin.value))) {
				current.push(pin.value);
			}
			map.set(anchor.atomId, current);
		}
	}
	return map;
}

function buildFragmentsFromAtoms(atoms: AtomzAtom[], pins: AtomzPin[]): Fragment[] {
	const pinnedWordMap = buildAtomPinnedWordMap(pins);
	function toFragment(atom: AtomzAtom): Fragment {
		return {
			id: atom.id,
			subject: atom.subject,
			predicate: atom.predicate,
			...(atom.transition ? { transition: atom.transition } : {}),
			...(pinnedWordMap.get(atom.id)?.length ? { pinnedWords: pinnedWordMap.get(atom.id) } : {}),
			children: (atom.children || []).map(toFragment)
		};
	}
	return atoms.map(toFragment);
}

function buildEditorPinsFromBlocks(blocks: AtomzBlock[], pins: AtomzPin[]): EditorPin[] {
	const blockParaMap = new Map<string, number>();
	let paraIndex = 0;
	for (const block of blocks) {
		if (block.type !== 'markdown') continue;
		paraIndex += 1;
		blockParaMap.set(block.id, paraIndex);
	}
	const editorPins: EditorPin[] = [];
	for (const pin of pins) {
		for (const anchor of pin.anchors) {
			if (anchor.type !== 'block') continue;
			const para = blockParaMap.get(anchor.blockId);
			if (!para) continue;
			if (!editorPins.some((existing) => existing.para === para && normalizePinnedText(existing.text) === normalizePinnedText(pin.value))) {
				editorPins.push({ text: pin.value, para });
			}
		}
	}
	return editorPins;
}

function buildProseFromBlocks(blocks: AtomzBlock[]): Sentence[] {
	const prose: Sentence[] = [];
	let paraIndex = 0;
	for (const block of blocks) {
		if (block.type === 'heading') {
			prose.push({
				text: `${'#'.repeat(block.level)} ${block.text}`,
				frags: [],
				para: paraIndex
			});
			continue;
		}
		paraIndex += 1;
		prose.push({
			text: block.markdown,
			frags: block.atomIds,
			para: paraIndex
		});
	}
	return prose;
}

function deriveHeadingBeforeAtomIndex(blocks: AtomzBlock[], headingIndex: number, atoms: AtomzAtom[]): number {
	const topLevelIndexMap = buildTopLevelIndexMap(atoms);
	for (let i = headingIndex + 1; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.type !== 'markdown') continue;
		const beforeAtomIndex = getTopLevelIndexForAtomIds(block.atomIds, topLevelIndexMap);
		return beforeAtomIndex ?? atoms.length;
	}
	return atoms.length;
}

function toAtom(fragment: Fragment): AtomzAtom {
	return {
		id: fragment.id,
		subject: fragment.subject,
		predicate: fragment.predicate,
		...(fragment.transition ? { transition: fragment.transition } : {}),
		children: (fragment.children || []).map(toAtom)
	};
}

export function buildBlocksFromRuntimeView(data: {
	atoms: Fragment[];
	prose: Sentence[];
	sections?: Section[];
}): AtomzBlock[] {
	const atomList = data.atoms.map(toAtom);
	const topLevelIndexMap = buildTopLevelIndexMap(atomList);
	const proseBlocks: AtomzBlock[] = [];
	let markdownCount = 0;
	for (let i = 0; i < data.prose.length; i++) {
		const sentence = data.prose[i];
		const headingMatch = sentence.text.match(/^(#{1,3})\s+(.+)/);
		if (headingMatch) {
			proseBlocks.push({
				id: `block_heading_${i}`,
				type: 'heading',
				level: headingMatch[1].length as 1 | 2 | 3,
				text: headingMatch[2]
			});
			continue;
		}
		markdownCount += 1;
		proseBlocks.push({
			id: `block_markdown_${markdownCount}`,
			type: 'markdown',
			markdown: sentence.text,
			atomIds: sentence.frags
		});
	}

	if (!data.sections?.length) return proseBlocks;
	const sectionsByIndex = new Map(data.sections.map((section) => [section.beforeAtomIndex, section.title]));
	const blocks = [...proseBlocks];
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.type !== 'heading') continue;
		const beforeAtomIndex = deriveHeadingBeforeAtomIndex(blocks, i, atomList);
		const sectionTitle = sectionsByIndex.get(beforeAtomIndex);
		if (sectionTitle) {
			block.text = sectionTitle;
			sectionsByIndex.delete(beforeAtomIndex);
		}
	}

	for (const [beforeAtomIndex, title] of sectionsByIndex) {
		const insertAt = blocks.findIndex((block) => {
			if (block.type !== 'markdown') return false;
			const blockIndex = getTopLevelIndexForAtomIds(block.atomIds, topLevelIndexMap);
			return blockIndex !== null && blockIndex >= beforeAtomIndex;
		});
		const headingBlock: AtomzHeadingBlock = {
			id: `block_heading_extra_${beforeAtomIndex}`,
			type: 'heading',
			level: 1,
			text: title
		};
		if (insertAt === -1) blocks.push(headingBlock);
		else blocks.splice(insertAt, 0, headingBlock);
	}

	return blocks;
}


function isHeadingBlock(block: unknown): block is AtomzHeadingBlock {
	return !!block && typeof block === 'object' && (block as AtomzHeadingBlock).type === 'heading';
}

function isMarkdownBlock(block: unknown): block is AtomzMarkdownBlock {
	return !!block && typeof block === 'object' && (block as AtomzMarkdownBlock).type === 'markdown';
}

function isAtomzFileV2(file: unknown): file is AtomzFileV2 {
	return !!file && typeof file === 'object' && (file as AtomzFileV2).version === 2 && Array.isArray((file as AtomzFileV2).atoms) && Array.isArray((file as AtomzFileV2).rules) && Array.isArray((file as AtomzFileV2).blocks);
}

export function normalizeAtomzFile(jsonOrObject: string | unknown): AtomzFileV2 {
	const parsed = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
	if (!isAtomzFileV2(parsed)) {
		throw new Error('Unsupported .atomz format. Expected version 2 with atoms, rules, blocks, and optional pins.');
	}
	const blocks = (parsed.blocks || []).map((block, index) => {
		if (isHeadingBlock(block)) {
			return {
				id: block.id || `block_heading_${index + 1}`,
				type: 'heading' as const,
				level: block.level,
				text: block.text
			};
		}
		if (isMarkdownBlock(block)) {
			return {
				id: block.id || `block_markdown_${index + 1}`,
				type: 'markdown' as const,
				markdown: block.markdown,
				atomIds: [...(block.atomIds || [])]
			};
		}
		throw new Error(`Unsupported block type at index ${index}`);
	});
	return {
		version: 2,
		...(parsed.source ? { source: parsed.source } : {}),
		...(parsed.tag ? { tag: parsed.tag } : {}),
		atoms: cloneAtoms(parsed.atoms || []),
		rules: (parsed.rules || []).map((rule, index) => ({ id: rule.id || `r${index + 1}`, text: rule.text })),
		blocks,
		...(parsed.pins?.length ? {
			pins: parsed.pins.map((pin, index) => ({
				id: pin.id || `pin_${index + 1}`,
				kind: 'verbatim' as const,
				value: pin.value,
				anchors: pin.anchors.map((anchor) => ({ ...anchor }))
			}))
		} : {})
	};
}

function toAtomWithPins(fragment: Fragment): AtomzAtom & { pinnedWords?: string[] } {
	return {
		id: fragment.id,
		subject: fragment.subject,
		predicate: fragment.predicate,
		...(fragment.transition ? { transition: fragment.transition } : {}),
		...(fragment.pinnedWords?.length ? { pinnedWords: [...fragment.pinnedWords] } : {}),
		children: (fragment.children || []).map(toAtomWithPins)
	};
}

export function projectAtomzFileToRenderDocument(file: AtomzFileV2): RenderDocument {
	const atomsWithPins = buildFragmentsFromAtoms(file.atoms, file.pins || []).map(toAtomWithPins);
	// Build prose directly from blocks, carrying block IDs through as stable identifiers.
	// The merge algorithm uses these IDs to match edited prose back to original blocks.
	const prose: RenderDocument['prose'] = [];
	let paraIndex = 0;
	for (const block of file.blocks) {
		if (block.type === 'heading') {
			prose.push({
				id: block.id,
				frags: [],
				para: paraIndex,
				text: `${'#'.repeat(block.level)} ${block.text}`
			});
			continue;
		}
		paraIndex += 1;
		prose.push({
			id: block.id,
			frags: block.atomIds,
			para: paraIndex,
			text: block.markdown
		});
	}
	return {
		atoms: atomsWithPins,
		rules: file.rules.map((rule) => rule.text),
		prose
	};
}

export function mergeRenderDocumentIntoAtomzFile(baseFile: AtomzFileV2, renderDocument: RenderDocument): AtomzFileV2 {
	const atoms = renderDocument.atoms.map((atom) => stripPinnedWords(atom));

	// Each prose entry carries an `id` that is the block ID it was projected from.
	// The agent may have changed text, frags, or reordered entries — but the ID is stable.
	// New entries added by the agent get a generated ID.
	let newBlockCounter = 0;
	const blocks: AtomzBlock[] = renderDocument.prose.map((sentence) => {
		const headingMatch = sentence.text.match(/^(#{1,3})\s+(.+)/);
		// Use the prose entry's ID (which is the original block ID).
		// If the agent added a new entry, it won't have a valid block ID — generate one.
		const blockId = sentence.id || `block_new_${++newBlockCounter}`;
		if (headingMatch) {
			return {
				id: blockId,
				type: 'heading' as const,
				level: headingMatch[1].length as 1 | 2 | 3,
				text: headingMatch[2]
			};
		}
		return {
			id: blockId,
			type: 'markdown' as const,
			markdown: sentence.text,
			atomIds: sentence.frags
		};
	});

	// Rebuild pins: preserve base pins but re-anchor block references to new block IDs
	// and remove orphaned anchors
	const blockIdSet = new Set(blocks.map((b) => b.id));
	const atomIdSet = new Set<string>();
	function walkAtoms(list: AtomzAtom[]) { for (const a of list) { atomIdSet.add(a.id); walkAtoms(a.children || []); } }
	walkAtoms(atoms);
	const pins: AtomzPin[] = (baseFile.pins || []).map((pin) => ({
		...pin,
		anchors: pin.anchors.filter((a) =>
			(a.type === 'atom' && atomIdSet.has(a.atomId)) ||
			(a.type === 'block' && blockIdSet.has(a.blockId))
		).map((a) => ({ ...a }))
	})).filter((pin) => pin.anchors.length > 0);

	return {
		version: 2,
		...(baseFile.source ? { source: baseFile.source } : {}),
		...(baseFile.tag ? { tag: baseFile.tag } : {}),
		atoms,
		rules: baseFile.rules.map((rule) => ({ ...rule })),
		blocks,
		...(pins.length ? { pins } : {})
	};
}

export function buildAtomzFileFromCanonicalState(state: CanonicalRuntimeState): AtomzFileV2 {
	return {
		version: 2,
		atoms: state.atoms.map(toAtom),
		rules: state.rules.map((rule) => ({ id: rule.id, text: rule.text })),
		blocks: state.blocks.map((block) => block.type === 'heading'
			? { ...block }
			: { ...block, atomIds: [...block.atomIds] }),
		...(state.pins.length ? {
			pins: state.pins.map((pin) => ({
				...pin,
				anchors: pin.anchors.map((anchor) => ({ ...anchor }))
			}))
		} : {})
	};
}

export function projectAtomzFileToRuntimeState(file: AtomzFileV2): RuntimeDocumentState {
	return {
		atoms: buildFragmentsFromAtoms(file.atoms, file.pins || []),
		prose: buildProseFromBlocks(file.blocks),
		rules: file.rules.map((rule) => ({ id: rule.id, text: rule.text })),
		paraBreaks: buildParaBreaksFromBlocks(file.blocks, file.atoms),
		editorPins: buildEditorPinsFromBlocks(file.blocks, file.pins || []),
		sections: buildSectionsFromBlocks(file.blocks, file.atoms)
	};
}

export function deserialize(json: string): RuntimeDocumentState {
	return projectAtomzFileToRuntimeState(normalizeAtomzFile(json));
}

export function uploadAtomz(): Promise<ReturnType<typeof deserialize>> {
	return new Promise((resolve, reject) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.atomz,.json';
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return reject(new Error('No file selected'));
			const reader = new FileReader();
			reader.onload = () => {
				try {
					resolve(deserialize(reader.result as string));
				} catch (e) {
					reject(e);
				}
			};
			reader.readAsText(file);
		};
		input.click();
	});
}

export function uploadText(): Promise<{ text: string; name: string }> {
	return new Promise((resolve, reject) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.txt,.md,.pdf';
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return reject(new Error('No file selected'));
			const reader = new FileReader();
			reader.onload = () => {
				resolve({ text: reader.result as string, name: file.name });
			};
			reader.readAsText(file);
		};
		input.click();
	});
}
