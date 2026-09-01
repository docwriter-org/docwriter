/**
 * JSON snapshots of a document's review state into `.docwriter/backups/`,
 * written before any destructive transition (file delete, disk-wins reseed,
 * doctor mutations). Invariant I5: log rows are only ever deleted by
 * explicit intent, and never without a backup first.
 *
 * Best-effort: a backup failure is logged, never thrown — the user's
 * explicit action (e.g. deleting a file) must not be blocked by a full disk.
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import * as Y from 'yjs';
import { DOCWRITER_DIR } from './document-files';
import { serializeYDoc, readCommentThreads, readReviewRounds } from '$lib/shared/ydoc-codec';

const BACKUPS_DIR = join(DOCWRITER_DIR, 'backups');
/** Keep the most recent N backup files; older ones are pruned on write. */
const MAX_BACKUPS = 40;

export function backupsDir(): string {
	return BACKUPS_DIR;
}

/** Snapshot a document's text + threads + pending rounds. `reason` names
 * the transition (e.g. 'delete-file', 'external-edit-reseed'). Returns the
 * backup file path, or null when the write failed. */
export function backupDocumentState(tabId: string, reason: string, ydoc: Y.Doc): string | null {
	try {
		mkdirSync(BACKUPS_DIR, { recursive: true });
		const safe = encodeURIComponent(tabId);
		const path = join(BACKUPS_DIR, `${safe}-${Date.now()}.json`);
		writeFileSync(
			path,
			JSON.stringify(
				{
					tabId,
					reason,
					savedAt: new Date().toISOString(),
					text: serializeYDoc(ydoc),
					threads: readCommentThreads(ydoc),
					rounds: readReviewRounds(ydoc)
				},
				null,
				2
			)
		);
		pruneOldBackups();
		return path;
	} catch (err) {
		console.error(`[docwriter] backup failed for tab "${tabId}" (${reason}):`, err);
		return null;
	}
}

function pruneOldBackups() {
	try {
		const entries = readdirSync(BACKUPS_DIR)
			.filter((name) => name.endsWith('.json'))
			.map((name) => {
				const full = join(BACKUPS_DIR, name);
				return { full, mtime: statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);
		for (const stale of entries.slice(MAX_BACKUPS)) {
			unlinkSync(stale.full);
		}
	} catch {
		// Pruning is housekeeping — never let it fail a backup.
	}
}
