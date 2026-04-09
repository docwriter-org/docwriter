import type { DocumentOp, Fragment, Rule, Section, Sentence } from './types';

interface DocumentState {
	fragments: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins: { text: string; para: number }[];
	sections: Section[];
}

function normalizePinnedText(text: string): string {
	const normalized = text.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
	return normalized || text.trim().toLowerCase();
}

function updateFragmentTree(fragments: Fragment[], fragId: string, updater: (fragment: Fragment) => Fragment): Fragment[] {
	return fragments.map((fragment) => {
		const children = updateFragmentTree(fragment.children || [], fragId, updater);
		if (fragment.id !== fragId) return { ...fragment, children };
		return updater({ ...fragment, children });
	});
}

function mirrorPinnedTextToFragments(fragments: Fragment[], linkedFragIds: string[], text: string): Fragment[] {
	const normalizedText = normalizePinnedText(text);
	const linkedSet = new Set(linkedFragIds);
	return fragments.map((fragment) => {
		const children = mirrorPinnedTextToFragments(fragment.children || [], linkedFragIds, normalizedText);
		if (!linkedSet.has(fragment.id)) return { ...fragment, children };
		const atomText = `${fragment.subject} ${fragment.predicate}`.toLowerCase();
		if (!atomText.includes(normalizedText)) return { ...fragment, children };
		const pinnedWords = fragment.pinnedWords || [];
		if (pinnedWords.some((word) => normalizePinnedText(word) === normalizedText)) {
			return { ...fragment, children };
		}
		return {
			...fragment,
			children,
			pinnedWords: [...pinnedWords, normalizedText]
		};
	});
}

export function applyDocumentOp(state: DocumentState, op: DocumentOp): DocumentState {
	switch (op.type) {
		case 'edit_atom':
			return {
				...state,
				fragments: updateFragmentTree(state.fragments, op.fragId, (fragment) => ({
					...fragment,
					subject: op.subject,
					predicate: op.predicate
				}))
			};
		case 'pin_atom_word':
			return {
				...state,
				fragments: updateFragmentTree(state.fragments, op.fragId, (fragment) => {
					const normalizedWord = normalizePinnedText(op.word);
					const pinnedWords = fragment.pinnedWords || [];
					const nextPinnedWords = op.pinned
						? (pinnedWords.some((word) => normalizePinnedText(word) === normalizedWord) ? pinnedWords : [...pinnedWords, normalizedWord])
						: pinnedWords.filter((word) => normalizePinnedText(word) !== normalizedWord);
					return {
						...fragment,
						...(nextPinnedWords.length > 0 ? { pinnedWords: nextPinnedWords } : { pinnedWords: undefined })
					};
				})
			};
		case 'pin_prose_text': {
			const normalizedText = normalizePinnedText(op.text);
			const nextEditorPins = state.editorPins.some((pin) => pin.para === op.para && normalizePinnedText(pin.text) === normalizedText)
				? state.editorPins
				: [...state.editorPins, { text: normalizedText, para: op.para }];
			return {
				...state,
				editorPins: nextEditorPins,
				fragments: mirrorPinnedTextToFragments(state.fragments, op.linkedFragIds, normalizedText)
			};
		}
		case 'replace_prose':
			return {
				...state,
				prose: op.prose.map((sentence) => ({ ...sentence })),
				sections: op.sections.map((section) => ({ ...section }))
			};
		case 'replace_fragments':
			return {
				...state,
				fragments: op.fragments.map((fragment) => ({ ...fragment }))
			};
		case 'replace_rules':
			return {
				...state,
				rules: op.rules.map((rule) => ({ ...rule }))
			};
		case 'replace_sections':
			return {
				...state,
				sections: op.sections.map((section) => ({ ...section }))
			};
		case 'replace_paragraph_structure':
			return {
				...state,
				paraBreaks: new Set(op.paraBreaks),
				prose: op.prose.map((sentence) => ({ ...sentence }))
			};
		default:
			return state;
	}
}
