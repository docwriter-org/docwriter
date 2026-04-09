import type { DocumentOp, Fragment, Rule, Section, Sentence } from './types';

interface DocumentState {
	fragments: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins: { text: string; para: number }[];
	sections: Section[];
}

export interface DocumentOpProcessingPlan {
	localOnlyOps: DocumentOp[];
	agentOps: DocumentOp[];
	editedFragId?: string;
	trigger?: string;
}

function normalizePinnedText(text: string): string {
	const normalized = text.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
	return normalized || text.trim().toLowerCase();
}

function hasPinnedText(text: string, pinnedText: string): boolean {
	return text.toLowerCase().includes(normalizePinnedText(pinnedText));
}

function findFragmentById(fragments: Fragment[], fragId: string): Fragment | null {
	for (const fragment of fragments) {
		if (fragment.id === fragId) return fragment;
		const child = findFragmentById(fragment.children || [], fragId);
		if (child) return child;
	}
	return null;
}

function opRequiresAgent(op: DocumentOp, state: DocumentState): boolean {
	switch (op.type) {
		case 'edit_atom':
		case 'replace_prose':
		case 'replace_fragments':
			return true;
		case 'replace_rules':
		case 'replace_sections':
		case 'replace_paragraph_structure':
			return false;
		case 'feedback_request':
			return true;
		case 'pin_atom_word': {
			if (!op.pinned) return false;
			const linkedProse = state.prose.filter((sentence) => sentence.frags.includes(op.fragId));
			return !linkedProse.some((sentence) => hasPinnedText(sentence.text, op.word));
		}
		case 'pin_prose_text': {
			if (op.linkedFragIds.length === 0) return false;
			return !op.linkedFragIds.some((fragId) => {
				const fragment = findFragmentById(state.fragments, fragId);
				return fragment ? hasPinnedText(`${fragment.subject} ${fragment.predicate}`, op.text) : false;
			});
		}
		default:
			return false;
	}
}

function buildTrigger(ops: DocumentOp[]): string {
	return ops.map((op) => {
		switch (op.type) {
			case 'edit_atom':
				return `Atom ${op.fragId} edited`;
			case 'replace_prose':
				return 'User edited prose directly. Preserve the current prose exactly and update atoms to match.';
			case 'replace_fragments':
				return 'Atom structure changed. Update prose to match the current atoms with minimal edits.';
			case 'pin_atom_word':
				return `[PIN_FIX_PROSE] Atom pin "${op.word}" on atom "${op.fragId}". The pinned word is missing from linked prose for this atom. Minimally edit only linked prose entries so "${op.word}" appears verbatim.`;
			case 'pin_prose_text':
				return `[PIN_FIX_SYNC] Prose pin "${op.text}" linked to atoms [${op.linkedFragIds.join(', ')}]. This pinned phrase is not present in linked atom text. Minimally edit linked atoms or linked prose so "${op.text}" appears verbatim in both places while preserving meaning.`;
			case 'feedback_request':
				return op.description;
			default:
				return 'Document state changed. Reconcile the document with minimal edits.';
		}
	}).join('; ');
}

function deriveEditedFragId(agentOps: DocumentOp[]): string | undefined {
	if (agentOps.length !== 1) return undefined;
	const op = agentOps[0];
	if (op.type === 'edit_atom') return op.fragId;
	if (op.type === 'pin_atom_word') return op.fragId;
	return undefined;
}

export function buildDocumentOpProcessingPlan(ops: DocumentOp[], state: DocumentState): DocumentOpProcessingPlan {
	const localOnlyOps: DocumentOp[] = [];
	const agentOps: DocumentOp[] = [];
	for (const op of ops) {
		if (opRequiresAgent(op, state)) {
			agentOps.push(op);
			continue;
		}
		localOnlyOps.push(op);
	}
	return {
		localOnlyOps,
		agentOps,
		editedFragId: deriveEditedFragId(agentOps),
		trigger: agentOps.length > 0 ? buildTrigger(agentOps) : undefined
	};
}
