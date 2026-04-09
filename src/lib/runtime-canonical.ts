import {
	buildAtomzFileFromCanonicalState,
	normalizeAtomzFile,
	projectAtomzFileToRuntimeState,
	type AtomzFileV2,
	type AtomzBlock,
	type AtomzPin
} from './atomz';
import {
	blocks,
	pins,
	atoms,
	rules,
	setProjectedRuntimeView
} from './stores';
import type { Atom, Rule, Sentence, EditorPin, Section } from './types';

export interface RuntimeViewState {
	atoms: Atom[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins: EditorPin[];
	sections: Section[];
}

export interface CanonicalRuntimeState {
	atoms: Atom[];
	rules: Rule[];
	blocks: AtomzFileV2['blocks'];
	pins: NonNullable<AtomzFileV2['pins']>;
}

export function applyCanonicalFileToStores(file: AtomzFileV2) {
	blocks.set(file.blocks);
	pins.set(file.pins || []);
	const projected = projectAtomzFileToRuntimeState(file);
	atoms.set(projected.atoms);
	rules.set(projected.rules);
	setProjectedRuntimeView({
		prose: projected.prose,
		paraBreaks: new Set(projected.paraBreaks),
		editorPins: projected.editorPins,
		sections: projected.sections
	});
	return projected;
}

/**
 * Re-derive all projected stores (prose, paraBreaks, editorPins, sections)
 * from the current canonical stores (blocks, pins, atoms, rules).
 * This is the single entry point for "canonical state changed, update derived views".
 */
export function reproject() {
	let currentBlocks: AtomzBlock[] = [];
	let currentPins: AtomzPin[] = [];
	let currentAtoms: Atom[] = [];
	let currentRules: Rule[] = [];
	blocks.subscribe((v) => (currentBlocks = v))();
	pins.subscribe((v) => (currentPins = v))();
	atoms.subscribe((v) => (currentAtoms = v))();
	rules.subscribe((v) => (currentRules = v))();

	const file = buildAtomzFileFromCanonicalState({
		atoms: currentAtoms,
		rules: currentRules,
		blocks: currentBlocks,
		pins: currentPins
	});
	const projected = projectAtomzFileToRuntimeState(file);
	atoms.set(projected.atoms);
	setProjectedRuntimeView({
		prose: projected.prose,
		paraBreaks: new Set(projected.paraBreaks),
		editorPins: projected.editorPins,
		sections: projected.sections
	});
}

export function normalizeAndApplyCanonicalFile(jsonOrObject: string | unknown) {
	const file = normalizeAtomzFile(jsonOrObject);
	applyCanonicalFileToStores(file);
	return file;
}

export function getCanonicalRuntimeStateFromStores(): CanonicalRuntimeState {
	let currentAtoms: Atom[] = [];
	let currentRules: Rule[] = [];
	let currentBlocks: AtomzFileV2['blocks'] = [];
	let currentPins: NonNullable<AtomzFileV2['pins']> = [];
	atoms.subscribe((value) => (currentAtoms = value))();
	rules.subscribe((value) => (currentRules = value))();
	blocks.subscribe((value) => (currentBlocks = value))();
	pins.subscribe((value) => (currentPins = value))();
	return {
		atoms: currentAtoms,
		rules: currentRules,
		blocks: currentBlocks,
		pins: currentPins
	};
}
