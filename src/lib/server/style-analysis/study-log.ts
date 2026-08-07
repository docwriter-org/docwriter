/**
 * Study telemetry for the author-style feature: which arm a workspace is in
 * (no references / raw references / compiled skill) and what happened under it.
 *
 * Rows in SQLite, not a JSONL file. This is runtime state, not something a
 * human opens, so it sits with rules, hooks and reviewers. A pre-existing
 * events.jsonl is imported once and then left alone.
 *
 * Nothing anyone wrote is recorded. `scrubStyleStudyData` strips every prose
 * field before a row is written, so the log knows that a proposition was
 * confirmed in 11 seconds and never what either passage said.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { getDb } from '$lib/server/db';
import { kvGet, kvSet } from '$lib/server/db-writes';

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

let importChecked = false;
const IMPORTED_KEY = 'style_study:jsonl_imported';

/**
 * Carry a pre-SQLite log across, once.
 *
 * The marker is a kv flag written inside the same transaction as the rows, not
 * a renamed file: a rename that failed after the rows committed would import
 * the file again on the next start and double the history. The original file is
 * left exactly where it is, so nothing of the writer's is moved or deleted.
 */
function importLegacyLog() {
	if (importChecked) return;
	importChecked = true;
	try {
		if (kvGet(IMPORTED_KEY)) return;
		const db = getDb();
		if (!existsSync(STYLE_STUDY_EVENTS_FILE)) {
			kvSet(IMPORTED_KEY, String(Date.now()));
			return;
		}
		const insert = db.prepare(
			'INSERT INTO style_study_events (type, timestamp, data) VALUES (?, ?, ?)'
		);
		db.transaction(() => {
			for (const line of readFileSync(STYLE_STUDY_EVENTS_FILE, 'utf8').split('\n')) {
				if (!line.trim()) continue;
				try {
					const { type, timestamp, ...rest } = JSON.parse(line);
					if (typeof type !== 'string') continue;
					insert.run(type, typeof timestamp === 'number' ? timestamp : 0, JSON.stringify(rest));
				} catch {
					// A corrupt line is not worth failing the import over.
				}
			}
			kvSet(IMPORTED_KEY, String(Date.now()));
		})();
	} catch {
		// Telemetry must never break the app.
	}
}

export function appendStyleStudyEvent(type: string, data: Record<string, unknown> = {}) {
	try {
		importLegacyLog();
		const scrubbed = scrubStyleStudyData(data) as Record<string, unknown>;
		getDb()
			.prepare('INSERT INTO style_study_events (type, timestamp, data) VALUES (?, ?, ?)')
			.run(type, Date.now(), JSON.stringify({ schemaVersion: 1, ...scrubbed }));
	} catch {
		// Same: losing a metric is not a reason to fail a render or a pass.
	}
}

export function readStyleStudyEvents(): Array<Record<string, unknown>> {
	importLegacyLog();
	const rows = getDb()
		.prepare('SELECT type, timestamp, data FROM style_study_events ORDER BY id')
		.all() as Array<{ type: string; timestamp: number; data: string }>;
	return rows.map((row) => {
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(row.data);
		} catch {
			// Fall through to just the columns.
		}
		return { schemaVersion: 1, ...parsed, type: row.type, timestamp: row.timestamp };
	});
}
