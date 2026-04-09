import type { Fragment, Rule, Sentence, EditorPin, Section } from './types';

// The on-disk format — what the agent reads/edits
export interface AtomzFile {
	atoms: AtomzAtom[];
	rules: string[];
	paraBreaks: number[];
	prose: AtomzSentence[];
	editorPins?: { text: string; para: number }[];
	sections?: { title: string; beforeAtomIndex: number }[];
}

export interface AtomzAtom {
	id: string;
	subject: string;
	predicate: string;
	pinnedWords?: string[];
	transition?: string;
	children: AtomzAtom[];
}

export interface AtomzSentence {
	id: number;
	frags: string[];
	para: number;
	text: string;
}

// Convert app state → file format
export function serialize(data: {
	fragments: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: Set<number>;
	editorPins?: EditorPin[];
	sections?: Section[];
}): string {
	function toAtom(f: Fragment): AtomzAtom {
		return {
			id: f.id,
			subject: f.subject,
			predicate: f.predicate,
			...(f.pinnedWords?.length ? { pinnedWords: f.pinnedWords } : {}),
			...(f.transition ? { transition: f.transition } : {}),
			children: (f.children || []).map(toAtom)
		};
	}

	const file: AtomzFile = {
		atoms: data.fragments.map(toAtom),
		rules: data.rules.map((r) => r.text),
		paraBreaks: Array.from(data.paraBreaks).sort((a, b) => a - b),
		prose: data.prose.map((s, i) => ({ id: i, frags: s.frags, para: s.para, text: s.text })),
		...(data.editorPins?.length ? { editorPins: data.editorPins } : {}),
		...(data.sections?.length ? { sections: data.sections } : {})
	};
	return JSON.stringify(file, null, 2);
}

// Convert file format → app state
export function deserialize(json: string): {
	fragments: Fragment[];
	prose: Sentence[];
	rules: Rule[];
	paraBreaks: number[];
	editorPins: EditorPin[];
	sections: Section[];
} {
	const file: AtomzFile = JSON.parse(json);

	function toFragment(a: any): Fragment {
		return {
			id: a.id,
			subject: a.subject,
			predicate: a.predicate || a.label || '',
			pinnedWords: a.pinnedWords,
			transition: a.transition,
			children: (a.children || []).map(toFragment)
		};
	}

	return {
		fragments: file.atoms.map(toFragment),
		prose: file.prose.map((s) => ({ text: s.text, frags: s.frags, para: s.para })),
		rules: file.rules.map((text, i) => ({ id: 'r' + i, text })),
		paraBreaks: file.paraBreaks || [],
		editorPins: (file.editorPins || []).map(p => ({ text: p.text, para: p.para })),
		sections: (file.sections || []).map(s => ({ title: s.title, beforeAtomIndex: s.beforeAtomIndex }))
	};
}

export function downloadAtomz(data: Parameters<typeof serialize>[0], filename = 'untitled.atomz') {
	const json = serialize(data);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
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
