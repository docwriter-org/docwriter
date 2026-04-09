export interface Fragment {
	id: string;
	subject: string;       // core noun — who/what the sentence is about
	predicate: string;     // the claim — what's being said
	children: Fragment[];
	pinnedWords?: string[];
	transition?: string;   // transition word/phrase before this atom's sentence (e.g., "Yet", "However")
}

export const TRANSITIONS = [
	'', 'And', 'But', 'Yet', 'So', 'Or', 'Nor', 'For',
	'However', 'Moreover', 'Furthermore', 'Meanwhile',
	'Nevertheless', 'Instead', 'Similarly', 'Conversely',
	'In contrast', 'As a result', 'In other words'
] as const;

// An atom = subject + predicate. Keep both minimal.
export const ATOM_CONSTRAINTS = {
	maxTotalWords: 12,     // subject + predicate combined
	subjectRequired: true,
	predicateRequired: true,
} as const;

export interface Rule {
	id: string;
	text: string;
	viewModes?: string[];
}

export interface Action {
	id: string;
	label: string;
	icon: string; // lucide icon name
	pinned: boolean;
	color: string;
}

export interface Annotation {
	id: string;
	text: string;
	action: Action;
}

export interface Sentence {
	text: string;
	frags: string[];
	para: number;
}

export interface InlineFeedback {
	text: string;
	x: number;
	y: number;
}

export interface EditorPin {
	text: string;
	para: number;
}

export type QueueItemType =
	| 'atom_edit'
	| 'atom_add'
	| 'atom_remove'
	| 'atom_reorder'
	| 'feedback'
	| 'pin_word'
	| 'rule_change'
	| 'para_break';

export interface QueueItem {
	id: string;
	createdAt: number;
	type: QueueItemType;
	description: string;
	editedFragId?: string;
}

interface DocumentOpBase {
	id: string;
	createdAt: number;
}

export interface EditAtomOp extends DocumentOpBase {
	type: 'edit_atom';
	fragId: string;
	subject: string;
	predicate: string;
}

export interface PinAtomWordOp extends DocumentOpBase {
	type: 'pin_atom_word';
	fragId: string;
	word: string;
	pinned: boolean;
}

export interface PinProseTextOp extends DocumentOpBase {
	type: 'pin_prose_text';
	text: string;
	para: number;
	linkedFragIds: string[];
}

export interface ReplaceProseOp extends DocumentOpBase {
	type: 'replace_prose';
	prose: Sentence[];
	sections: Section[];
}

export interface ReplaceFragmentsOp extends DocumentOpBase {
	type: 'replace_fragments';
	fragments: Fragment[];
}

export interface ReplaceRulesOp extends DocumentOpBase {
	type: 'replace_rules';
	rules: Rule[];
}

export interface ReplaceSectionsOp extends DocumentOpBase {
	type: 'replace_sections';
	sections: Section[];
}

export interface ReplaceParagraphStructureOp extends DocumentOpBase {
	type: 'replace_paragraph_structure';
	paraBreaks: number[];
	prose: Sentence[];
}

export type DocumentOp =
	| EditAtomOp
	| PinAtomWordOp
	| PinProseTextOp
	| ReplaceProseOp
	| ReplaceFragmentsOp
	| ReplaceRulesOp
	| ReplaceSectionsOp
	| ReplaceParagraphStructureOp;
export type NewDocumentOp =
	| (Omit<EditAtomOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<PinAtomWordOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<PinProseTextOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<ReplaceProseOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<ReplaceFragmentsOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<ReplaceRulesOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<ReplaceSectionsOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>)
	| (Omit<ReplaceParagraphStructureOp, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>);

export interface Section {
	title: string;
	beforeAtomIndex: number;
}

export type HistoryEntry =
	| { type: 'user_action'; timestamp: number; description: string }
	| { type: 'tool_call'; timestamp: number; tool_name: string; input: Record<string, unknown>; durationMs?: number; subagent?: boolean }
	| { type: 'assistant_text'; timestamp: number; text: string }
	| { type: 'render_start'; timestamp: number; trigger: string }
	| { type: 'render_end'; timestamp: number; success: boolean; durationMs?: number };
