#!/usr/bin/env node
/**
 * One-shot maintenance script: delete every comment thread from every tab
 * in a DocWriter workspace, persisted to `.docwriter/docwriter.db`.
 *
 * Comments live inside each tab's Y.Doc as a `Y.Map('comments')`. The Y.Doc
 * itself is persisted as a sequence of binary updates in the `yjs_updates`
 * table — so to actually drop the comments we need to:
 *   1. Replay the updates into a fresh Y.Doc.
 *   2. Clear the comments map inside a transact.
 *   3. Replace every row for that tab with a single full-state update.
 *
 * Run it from the workspace root with the dev server STOPPED. While the
 * server is running it owns the live Hocuspocus Y.Docs in memory and DB
 * mutations won't be reflected until the server next hydrates from SQLite
 * (i.e. a restart).
 *
 * Usage:
 *   node scripts/delete-all-comments.mjs              # uses cwd as workspace
 *   DOCWRITER_ROOT=/path/to/repo node scripts/delete-all-comments.mjs
 *   node scripts/delete-all-comments.mjs --dry-run    # report only, no writes
 */
import BetterSqlite3 from 'better-sqlite3';
import * as Y from 'yjs';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const COMMENTS_MAP_NAME = 'comments';
const SYSTEM_ORIGIN = 'system';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const root = resolve(process.env.DOCWRITER_ROOT || process.cwd());
const dbPath = join(root, '.docwriter', 'docwriter.db');

if (!existsSync(dbPath)) {
	console.error(`No DocWriter DB at ${dbPath}.`);
	console.error('Run this from the workspace root or set DOCWRITER_ROOT.');
	process.exit(1);
}

console.log(`Workspace: ${root}`);
console.log(`Database:  ${dbPath}`);
if (dryRun) console.log('Mode:      dry run (no writes)');
console.log('');

const db = new BetterSqlite3(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const tabIds = db
	.prepare('SELECT DISTINCT tab_id FROM yjs_updates ORDER BY tab_id')
	.all()
	.map((row) => row.tab_id);

if (tabIds.length === 0) {
	console.log('No tabs found in yjs_updates.');
	db.close();
	process.exit(0);
}

let totalThreads = 0;
let tabsTouched = 0;

for (const tabId of tabIds) {
	const rows = db
		.prepare(
			'SELECT payload, origin FROM yjs_updates WHERE tab_id = ? ORDER BY seq'
		)
		.all(tabId);

	const ydoc = new Y.Doc();
	for (const row of rows) {
		ydoc.transact(
			() => Y.applyUpdate(ydoc, new Uint8Array(row.payload)),
			row.origin
		);
	}

	const map = ydoc.getMap(COMMENTS_MAP_NAME);
	const beforeCount = map.size;
	if (beforeCount === 0) {
		ydoc.destroy();
		continue;
	}

	console.log(`  ${tabId}: ${beforeCount} thread${beforeCount === 1 ? '' : 's'}`);
	totalThreads += beforeCount;
	tabsTouched += 1;

	if (dryRun) {
		ydoc.destroy();
		continue;
	}

	ydoc.transact(() => {
		const keys = [];
		map.forEach((_, key) => keys.push(key));
		for (const key of keys) map.delete(key);
	}, SYSTEM_ORIGIN);

	const fullStateUpdate = Y.encodeStateAsUpdate(ydoc);
	const replace = db.transaction(() => {
		db.prepare('DELETE FROM yjs_updates WHERE tab_id = ?').run(tabId);
		db.prepare(
			'INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)'
		).run(tabId, Buffer.from(fullStateUpdate), SYSTEM_ORIGIN, Date.now());
	});
	replace();
	ydoc.destroy();
}

console.log('');
if (totalThreads === 0) {
	console.log('No comment threads found. Nothing to do.');
} else if (dryRun) {
	console.log(
		`Would delete ${totalThreads} thread${totalThreads === 1 ? '' : 's'} ` +
			`across ${tabsTouched} tab${tabsTouched === 1 ? '' : 's'}. ` +
			'Re-run without --dry-run to apply.'
	);
} else {
	console.log(
		`Deleted ${totalThreads} thread${totalThreads === 1 ? '' : 's'} ` +
			`across ${tabsTouched} tab${tabsTouched === 1 ? '' : 's'}.`
	);
	console.log(
		'Restart the DocWriter dev server so it hydrates the cleaned state.'
	);
}

db.close();
