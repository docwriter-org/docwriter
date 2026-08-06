import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { DOCWRITER_DIR } from '$lib/server/document-files';

export const STYLE_STUDY_DIR = join(DOCWRITER_DIR, 'style-study');
export const STYLE_STUDY_EVENTS_FILE = join(STYLE_STUDY_DIR, 'events.jsonl');

const FORBIDDEN_KEYS = new Set(['text', 'prompt', 'content', 'candidateA', 'candidateB', 'editedText', 'generatedText', 'referenceText']);

export function scrubStyleStudyData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubStyleStudyData);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !FORBIDDEN_KEYS.has(key))
		.map(([key, item]) => [key, scrubStyleStudyData(item)]));
}

export function appendStyleStudyEvent(type: string, data: Record<string, unknown> = {}) {
	if (!existsSync(STYLE_STUDY_DIR)) mkdirSync(STYLE_STUDY_DIR, { recursive: true });
	const event = {
		schemaVersion: 1,
		type,
		timestamp: Date.now(),
		...scrubStyleStudyData(data) as Record<string, unknown>
	};
	appendFileSync(STYLE_STUDY_EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
}

export function readStyleStudyEvents(): Array<Record<string, unknown>> {
	if (!existsSync(STYLE_STUDY_EVENTS_FILE)) return [];
	return readFileSync(STYLE_STUDY_EVENTS_FILE, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
		});
}
