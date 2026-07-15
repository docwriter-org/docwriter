import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync
} from 'fs';
import { basename, extname, join } from 'path';
import { DOCWRITER_DIR } from './document-files';
import { resolveWorkspacePath } from './workspace-path';
import { writeJsonAtomic, writeTextAtomic } from './file-utils';

export const REFERENCES_DIR = join(DOCWRITER_DIR, 'references');
export const REFERENCES_INDEX_FILE = join(DOCWRITER_DIR, 'references.json');

export type StyleReferenceType = 'workspace-file' | 'stored-sample' | 'url';

export interface StyleReference {
	id: string;
	label: string;
	type: StyleReferenceType;
	target: string;
	addedAt: number;
}

interface ReferencesIndex {
	references: StyleReference[];
}

function ensureReferencesDir() {
	if (!existsSync(REFERENCES_DIR)) {
		mkdirSync(REFERENCES_DIR, { recursive: true });
	}
}

function ensureReferencesIndex() {
	if (!existsSync(REFERENCES_INDEX_FILE)) {
		writeJsonAtomic(REFERENCES_INDEX_FILE, { references: [] });
	}
}

function readIndex(): ReferencesIndex {
	ensureReferencesDir();
	ensureReferencesIndex();
	try {
		const parsed = JSON.parse(readFileSync(REFERENCES_INDEX_FILE, 'utf-8')) as ReferencesIndex;
		return { references: Array.isArray(parsed.references) ? parsed.references : [] };
	} catch {
		return { references: [] };
	}
}

function writeIndex(index: ReferencesIndex) {
	ensureReferencesDir();
	writeJsonAtomic(REFERENCES_INDEX_FILE, index);
}

function assertValidStoredSampleFileName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Reference name is required');
	if (trimmed.length > 120) throw new Error('Reference name is too long');
	if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
		throw new Error('Reference name must be a single file name');
	}
	if (trimmed === '.' || trimmed === '..') {
		throw new Error('Reference name is invalid');
	}
	return trimmed;
}

function sanitizeReferenceName(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return 'writing-sample.md';
	const normalized = trimmed
		.normalize('NFKD')
		.replace(/[^\w.\- ]+/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.toLowerCase();
	const base = normalized || 'writing-sample';
	return extname(base) ? base : `${base}.md`;
}

function uniqueStoredSampleFileName(desiredName: string): string {
	ensureReferencesDir();
	const safeName = assertValidStoredSampleFileName(sanitizeReferenceName(desiredName));
	const ext = extname(safeName);
	const stem = ext ? safeName.slice(0, -ext.length) : safeName;
	let candidate = safeName;
	let counter = 2;
	while (existsSync(join(REFERENCES_DIR, candidate))) {
		candidate = `${stem}-${counter}${ext}`;
		counter += 1;
	}
	return candidate;
}

function upsertReference(next: Omit<StyleReference, 'id' | 'addedAt'>): StyleReference {
	const index = readIndex();
	const existing = index.references.find(
		(ref) => ref.type === next.type && ref.target === next.target
	);
	if (existing) {
		const updated: StyleReference = {
			...existing,
			label: next.label,
			addedAt: Date.now()
		};
		writeIndex({
			references: [updated, ...index.references.filter((ref) => ref.id !== existing.id)]
		});
		return updated;
	}

	const created: StyleReference = {
		id: 'ref_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		addedAt: Date.now(),
		...next
	};
	writeIndex({ references: [created, ...index.references] });
	return created;
}

export function listStyleReferences(): StyleReference[] {
	return readIndex().references.sort((a, b) => b.addedAt - a.addedAt);
}

export function createStoredSampleReference(name: string, content: string): StyleReference {
	const normalizedContent = content.trim();
	if (!normalizedContent) throw new Error('Reference content is required');
	const fileName = uniqueStoredSampleFileName(name);
	writeTextAtomic(join(REFERENCES_DIR, fileName), normalizedContent + '\n');
	return upsertReference({
		label: basename(fileName, extname(fileName)),
		type: 'stored-sample',
		target: `.docwriter/references/${fileName}`
	});
}

export function addWorkspaceFileReference(tabId: string): StyleReference {
	resolveWorkspacePath(tabId);
	return upsertReference({
		label: tabId,
		type: 'workspace-file',
		target: tabId
	});
}

export function addUrlReference(url: string, label?: string): StyleReference {
	const normalized = url.trim();
	if (!/^https?:\/\//i.test(normalized)) {
		throw new Error('Style reference URL must start with http:// or https://');
	}
	return upsertReference({
		label: label?.trim() || normalized,
		type: 'url',
		target: normalized
	});
}

export function deleteStyleReference(id: string) {
	const index = readIndex();
	const doomed = index.references.find((ref) => ref.id === id);
	if (!doomed) return;
	if (doomed.type === 'stored-sample') {
		const fileName = doomed.target.replace(/^\.docwriter\/references\//, '');
		const path = join(REFERENCES_DIR, fileName);
		if (existsSync(path)) unlinkSync(path);
	}
	writeIndex({
		references: index.references.filter((ref) => ref.id !== id)
	});
}

// NOTE: a `buildStyleReferencesPromptBlock` helper used to live here. It
// duplicated the system prompt's Style references section and had no live
// callers, so it was removed rather than left to drift.
