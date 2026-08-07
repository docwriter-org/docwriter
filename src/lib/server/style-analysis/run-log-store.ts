/**
 * Persistence for specialist working traces.
 *
 * Traces used to live only in the SSE stream, so the trace panel could show a
 * finished run nothing at all — "run the analysis with this panel open to
 * watch it think" was the whole story. They are ordinary rows now, so a run
 * can be read back long after it finished.
 *
 * Only completed lines are written. Text and thinking arrive as deltas and the
 * live stream re-sends the whole open line on every one of them; writing each
 * delta would store hundreds of prefixes of the same paragraph. The caller
 * accumulates and hands over a line when it closes.
 */
import { getDb } from '$lib/server/db';
import type { SpecialistLogEntry } from './run-manager';

/** Belt and braces against a runaway agent filling the database. */
const MAX_LINES_PER_RUN = 2000;

/** Never throws: a trace is for looking at, and losing a line must not fail a
 *  run. Callers can append without guarding. */
export function appendRunLog(runId: string, entry: SpecialistLogEntry) {
	try {
		appendRunLogOrThrow(runId, entry);
	} catch {
		// Deliberately swallowed.
	}
}

function appendRunLogOrThrow(runId: string, entry: SpecialistLogEntry) {
	const db = getDb();
	const { count } = db
		.prepare('SELECT COUNT(*) AS count FROM style_run_logs WHERE run_id = ?')
		.get(runId) as { count: number };
	if (count >= MAX_LINES_PER_RUN) return;
	db.prepare(
		`INSERT INTO style_run_logs (run_id, specialist_id, kind, text, tool_name, created)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(
		runId,
		entry.specialistId,
		entry.kind,
		entry.text ?? null,
		entry.toolName ?? null,
		Date.now()
	);
}

/** Every stored line for a run, in the order it happened, keyed by specialist. */
export function readRunLogs(runId: string): Record<string, SpecialistLogEntry[]> {
	const rows = getDb()
		.prepare(
			`SELECT specialist_id, kind, text, tool_name
			 FROM style_run_logs WHERE run_id = ? ORDER BY id`
		)
		.all(runId) as Array<{
		specialist_id: string;
		kind: string;
		text: string | null;
		tool_name: string | null;
	}>;
	const traces: Record<string, SpecialistLogEntry[]> = {};
	for (const row of rows) {
		const entry: SpecialistLogEntry = {
			specialistId: row.specialist_id as SpecialistLogEntry['specialistId'],
			kind: row.kind as SpecialistLogEntry['kind'],
			...(row.text ? { text: row.text } : {}),
			...(row.tool_name ? { toolName: row.tool_name } : {})
		};
		(traces[row.specialist_id] ??= []).push(entry);
	}
	return traces;
}

export function deleteRunLogs(runId: string) {
	getDb().prepare('DELETE FROM style_run_logs WHERE run_id = ?').run(runId);
}
