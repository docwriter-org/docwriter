import type { DocumentOp, Fragment, Rule, Section, Sentence } from './types';
import type { AtomzBlock, AtomzPin } from './atomz';

interface DocumentState {
	atoms: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins: { text: string; para: number }[];
	sections: Section[];
	blocks?: AtomzBlock[];
	pins?: AtomzPin[];
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
				atoms: updateFragmentTree(state.atoms, op.fragId, (fragment) => ({
					...fragment,
					subject: op.subject,
					predicate: op.predicate
				}))
			};
		case 'pin_atom_word':
			return {
				...state,
				atoms: updateFragmentTree(state.atoms, op.fragId, (fragment) => {
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
				atoms: mirrorPinnedTextToFragments(state.atoms, op.linkedFragIds, normalizedText)
			};
		}
		case 'add_atom': {
			const newFrag: Fragment = { id: op.atom.id, subject: op.atom.subject, predicate: op.atom.predicate, children: [] };
			if (op.parentId) {
				return {
					...state,
					atoms: updateFragmentTree(state.atoms, op.parentId, (parent) => ({
						...parent, children: [...(parent.children || []), newFrag]
					}))
				};
			}
			const next = [...state.atoms];
			next.splice(op.index, 0, newFrag);
			return { ...state, atoms: next };
		}
		case 'delete_atom': {
			const targetId = op.atomId;
			function removeFromTree(list: Fragment[]): Fragment[] {
				return list.filter((f) => f.id !== targetId).map((f) => ({
					...f, children: removeFromTree(f.children || [])
				}));
			}
			return { ...state, atoms: removeFromTree(state.atoms) };
		}
		case 'reorder_atoms': {
			if (op.parentId) {
				return {
					...state,
					atoms: updateFragmentTree(state.atoms, op.parentId, (parent) => {
						const kids = [...(parent.children || [])];
						const fromIdx = kids.findIndex((c) => c.id === op.atomId);
						if (fromIdx === -1) return parent;
						const [moved] = kids.splice(fromIdx, 1);
						kids.splice(op.toIndex, 0, moved);
						return { ...parent, children: kids };
					})
				};
			}
			const next = [...state.atoms];
			const fromIdx = next.findIndex((f) => f.id === op.atomId);
			if (fromIdx === -1) return state;
			const [moved] = next.splice(fromIdx, 1);
			next.splice(op.toIndex, 0, moved);
			return { ...state, atoms: next };
		}
		case 'replace_rules':
			return {
				...state,
				rules: op.rules.map((rule) => ({ ...rule }))
			};
		case 'feedback_request':
			return state;
		case 'update_blocks':
			return {
				...state,
				blocks: op.blocks.map((b) => ({ ...b }))
			};
		case 'update_pins':
			return {
				...state,
				pins: op.pins.map((p) => ({ ...p, anchors: p.anchors.map((a) => ({ ...a })) }))
			};
		default:
			return state;
	}
}
