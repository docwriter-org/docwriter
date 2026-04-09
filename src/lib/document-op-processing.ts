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

function opRequiresAgent(_op: DocumentOp, _state: DocumentState): boolean {
	// All ops go to the agent. The agent decides what needs action.
	return true;
}

function buildTrigger(ops: DocumentOp[]): string {
	return ops.map((op) => {
		switch (op.type) {
			case 'edit_atom':
				return `Atom "${op.fragId}" was edited. New subject: "${op.subject}", new predicate: "${op.predicate}". Update only the prose sentences linked to this atom to reflect the new meaning.`;
			case 'add_atom': {
				const subjectNote = op.atom.subject
					? `Subject: "${op.atom.subject}"`
					: 'No subject provided — pick a natural subject based on the predicate';
				return `New atom added at position ${op.index}${op.parentId ? ` under parent "${op.parentId}"` : ''}. ${subjectNote}, predicate: "${op.atom.predicate}". Update the atom's subject if blank, then write a new prose sentence for this atom and insert it at the appropriate position in the document.`;
			}
			case 'delete_atom':
				return `Atom "${op.atomId}" was deleted (was: "${op.subject} | ${op.predicate}"). Remove or merge its linked prose sentences. Ensure surrounding prose still flows naturally.`;
			case 'reorder_atoms':
				return `Atom "${op.atomId}" moved from position ${op.fromIndex} to position ${op.toIndex}${op.parentId ? ` within parent "${op.parentId}"` : ''}. Reorder the corresponding prose to match the new atom order. Adjust transitions for natural flow.`;
			case 'pin_atom_word':
				return `[PIN_FIX_PROSE] Atom pin "${op.word}" on atom "${op.fragId}". The pinned word is missing from linked prose for this atom. Minimally edit only linked prose entries so "${op.word}" appears verbatim.`;
			case 'pin_prose_text':
				return `[PIN_FIX_SYNC] Prose pin "${op.text}" linked to atoms [${op.linkedFragIds.join(', ')}]. This pinned phrase is not present in linked atom text. Minimally edit linked atoms or linked prose so "${op.text}" appears verbatim in both places while preserving meaning.`;
			case 'replace_rules':
				return `Writing rules changed. Review the current rules in the document and scan all prose for violations. Fix any prose that breaks the new rules. Keep edits minimal — only change what violates a rule.`;
			case 'feedback_request':
				return op.description;
			case 'update_blocks':
				if (op.source === 'editor') {
					return 'User edited prose directly. Examine the changes: if the user wrote or changed prose text, preserve it exactly and update atoms to match. If the user wrote a directive or instruction (e.g. "make this more concise", "add an example here"), follow the directive, update prose accordingly, and update atoms to match the new prose.';
				}
				return 'Document structure changed (section rename or paragraph break). Review the change and ensure prose still flows naturally. Adjust transitions if needed.';
			case 'update_pins':
				return 'Pin structure changed. Review the pins and ensure pinned words appear verbatim in linked prose and atoms. Fix any mismatches.';
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
	if (op.type === 'delete_atom') return op.atomId;
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
