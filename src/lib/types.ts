export interface Atom {
	id: string;
	subject: string;       // core noun — who/what the sentence is about
	predicate: string;     // the claim — what's being said
	children: Atom[];
	pinnedWords?: string[];
	transition?: string;   // transition word/phrase before this atom's sentence (e.g., "Yet", "However")
}

/** @deprecated Use Atom instead */
export type Fragment = Atom;

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

export interface AddAtomOp extends DocumentOpBase {
	type: 'add_atom';
	atom: { id: string; subject: string; predicate: string };
	parentId?: string;       // if sub-atom, the parent atom id
	index: number;           // insertion position
}

export interface DeleteAtomOp extends DocumentOpBase {
	type: 'delete_atom';
	atomId: string;
	subject: string;         // for agent context
	predicate: string;       // for agent context
}

export interface ReorderAtomsOp extends DocumentOpBase {
	type: 'reorder_atoms';
	atomId: string;
	fromIndex: number;
	toIndex: number;
	parentId?: string;       // if reordering children within a parent
}

export interface ReplaceRulesOp extends DocumentOpBase {
	type: 'replace_rules';
	rules: Rule[];
}

export interface FeedbackRequestOp extends DocumentOpBase {
	type: 'feedback_request';
	description: string;
}

export interface UpdateBlocksOp extends DocumentOpBase {
	type: 'update_blocks';
	blocks: import('$lib/atomz').AtomzBlock[];
	source: 'editor' | 'structure';
}

export interface UpdatePinsOp extends DocumentOpBase {
	type: 'update_pins';
	pins: import('$lib/atomz').AtomzPin[];
}

export type DocumentOp =
	| EditAtomOp
	| PinAtomWordOp
	| PinProseTextOp
	| AddAtomOp
	| DeleteAtomOp
	| ReorderAtomsOp
	| ReplaceRulesOp
	| FeedbackRequestOp
	| UpdateBlocksOp
	| UpdatePinsOp;

type NewOp<T extends DocumentOpBase> = Omit<T, 'id' | 'createdAt'> & Partial<Pick<DocumentOpBase, 'id' | 'createdAt'>>;
export type NewDocumentOp =
	| NewOp<EditAtomOp>
	| NewOp<PinAtomWordOp>
	| NewOp<PinProseTextOp>
	| NewOp<AddAtomOp>
	| NewOp<DeleteAtomOp>
	| NewOp<ReorderAtomsOp>
	| NewOp<ReplaceRulesOp>
	| NewOp<FeedbackRequestOp>
	| NewOp<UpdateBlocksOp>
	| NewOp<UpdatePinsOp>;

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
