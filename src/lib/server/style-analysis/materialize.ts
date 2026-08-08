import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedDocument } from '$lib/style-profile';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { writeTextAtomic } from '$lib/server/file-utils';
import {
	REFERENCES_CACHE_DIR,
	getStyleReference,
	isSelected,
	listStyleReferences,
	updateStyleReference,
	type StyleReference
} from '$lib/server/references';
import { normalizeText } from './analyze-style.mjs';

export interface MaterializedReference {
	reference: StyleReference;
	text: string;
	format: string;
	contentHash: string;
	cachePath: string;
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function cacheAbsolutePath(id: string): string {
	return join(REFERENCES_CACHE_DIR, `${id}.txt`);
}

function cacheRelativePath(id: string): string {
	return `.docwriter/style-analysis/source-cache/${id}.txt`;
}

function ensureCacheDir() {
	if (!existsSync(REFERENCES_CACHE_DIR)) mkdirSync(REFERENCES_CACHE_DIR, { recursive: true });
}

function storedSamplePath(reference: StyleReference): string {
	return join(DOCWRITER_DIR, reference.target.replace(/^\.docwriter\//, ''));
}

function readStoredSample(reference: StyleReference): { text: string; format: string; sourceFingerprint: string } {
	const absolute = storedSamplePath(reference);
	if (!existsSync(absolute)) throw new Error('Reference file no longer exists');
	const bytes = new Uint8Array(readFileSync(absolute));
	return {
		text: new TextDecoder().decode(bytes).trim(),
		format: reference.format ?? 'text',
		sourceFingerprint: sha256(bytes)
	};
}

export async function materializeStyleReference(id: string, force = false): Promise<MaterializedReference> {
	const reference = getStyleReference(id);
	if (!reference) throw new Error('Style reference not found');
	if (!force && reference.materializationStatus === 'ready' && reference.cachePath && reference.contentHash) {
		const cache = cacheAbsolutePath(reference.id);
		if (existsSync(cache)) {
			return { reference, text: readFileSync(cache, 'utf8'), format: reference.format ?? 'text', contentHash: reference.contentHash, cachePath: reference.cachePath };
		}
	}
	updateStyleReference(id, { materializationStatus: 'pending', error: undefined });
	try {
		const result = readStoredSample(reference);
		if (!result.text.trim()) throw new Error('Reference did not contain readable text');
		ensureCacheDir();
		const normalized = result.text.replace(/\r\n/g, '\n').trim();
		const contentHash = sha256(normalized);
		writeTextAtomic(cacheAbsolutePath(id), `${normalized}\n`);
		const updated = updateStyleReference(id, {
			format: result.format,
			contentHash,
			sourceFingerprint: result.sourceFingerprint,
			materializationStatus: 'ready',
			cachePath: cacheRelativePath(id),
			extractedAt: Date.now(),
			error: undefined
		});
		return { reference: updated, text: normalized, format: result.format, contentHash, cachePath: cacheRelativePath(id) };
	} catch (error) {
		updateStyleReference(id, {
			materializationStatus: 'error',
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}

export function updateMaterializedReferenceText(id: string, text: string): MaterializedReference {
	const reference = getStyleReference(id);
	if (!reference) throw new Error('Style reference not found');
	const normalized = text.replace(/\r\n/g, '\n').trim();
	if (!normalized) throw new Error('Reference text is required');
	ensureCacheDir();
	const contentHash = sha256(normalized);
	writeTextAtomic(cacheAbsolutePath(id), `${normalized}\n`);
	const updated = updateStyleReference(id, {
		contentHash,
		materializationStatus: 'ready',
		cachePath: cacheRelativePath(id),
		extractedAt: Date.now(),
		error: undefined
	});
	return { reference: updated, text: normalized, format: updated.format ?? 'text', contentHash, cachePath: cacheRelativePath(id) };
}

export async function materializeAllReferences(force = false): Promise<MaterializedReference[]> {
	// Rejected sources stay in the list but must not shape the style.
	const references = listStyleReferences().filter(isSelected);
	const results: MaterializedReference[] = [];
	for (const reference of references) results.push(await materializeStyleReference(reference.id, force));
	return results;
}

export function normalizedDocumentFromMaterialized(item: MaterializedReference): NormalizedDocument {
	return normalizeText({
		sourceId: item.reference.id,
		role: item.reference.role,
		format: item.format,
		text: item.text
	}) as NormalizedDocument;
}

export function referenceIsStale(reference: StyleReference): boolean {
	if (reference.materializationStatus !== 'ready' || !reference.contentHash) return true;
	try {
		const absolute = storedSamplePath(reference);
		if (!existsSync(absolute)) return true;
		if (reference.sourceFingerprint) {
			return sha256(new Uint8Array(readFileSync(absolute))) !== reference.sourceFingerprint;
		}
		return sha256(readFileSync(absolute, 'utf8').trim()) !== reference.contentHash;
	} catch {
		return true;
	}
}
