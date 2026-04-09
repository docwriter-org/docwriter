import {
	buildAtomzFile,
	normalizeAtomzFile,
	projectAtomzFileToRuntimeState,
	type AtomzFileV2
} from './atomz';
import {
	blocks,
	pins,
	fragments,
	prose,
	rules,
	paraBreaks,
	editorPins,
	sections
} from './stores';
import type { Fragment, Rule, Sentence, EditorPin, Section } from './types';

export interface RuntimeViewState {
	fragments: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins: EditorPin[];
	sections: Section[];
}

export function applyCanonicalFileToStores(file: AtomzFileV2) {
	blocks.set(file.blocks);
	pins.set(file.pins || []);
	const projected = projectAtomzFileToRuntimeState(file);
	fragments.set(projected.fragments);
	prose.set(projected.prose);
	rules.set(projected.rules);
	paraBreaks.set(new Set(projected.paraBreaks));
	editorPins.set(projected.editorPins);
	sections.set(projected.sections);
	return projected;
}

export function normalizeAndApplyCanonicalFile(jsonOrObject: string | unknown) {
	const file = normalizeAtomzFile(jsonOrObject);
	applyCanonicalFileToStores(file);
	return file;
}

export function buildCanonicalFileFromRuntimeState(state: RuntimeViewState) {
	return buildAtomzFile(state);
}

export function commitRuntimeViewToCanonicalStores(state: RuntimeViewState) {
	const file = buildCanonicalFileFromRuntimeState(state);
	applyCanonicalFileToStores(file);
	return file;
}
