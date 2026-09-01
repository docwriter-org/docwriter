#!/usr/bin/env node
/**
 * docwriter doctor — inspect and repair a workspace's .docwriter state.
 *
 * Usage:
 *   docwriter doctor [workspace-dir] [flags]
 *   npm run doctor -- [workspace-dir] [flags]
 *
 * Report (default, read-only): where state lives (and whether a stray
 * .docwriter elsewhere might be the one you're looking at), SQLite
 * integrity, the documents table vs the update log, seq-gap classification,
 * pending review rounds and comment threads per document, and backups.
 *
 * Repair flags (each writes a JSON backup to .docwriter/backups/ first):
 *   --reopen <tabId>        Reopen a closed document into the tab bar.
 *   --clear-pending         Drop ALL pending review rounds (per --tab if given).
 *   --resolve-threads       Mark all open comment threads resolved (per --tab).
 *   --gc                    Delete closed documents whose file no longer exists.
 *   --compact               Merge each oversized update log into one snapshot row.
 *   --tab <id>              Scope --clear-pending / --resolve-threads / --compact.
 *   --json                  Machine-readable report.
 *
 * Run with docwriter STOPPED for mutations; a live server holds documents in
 * memory and will not see offline changes until it restarts.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'package.json'));
let Database, Y;
try {
	Database = require('better-sqlite3');
	Y = require('yjs');
} catch (err) {
	console.error('docwriter doctor needs docwriter\'s dependencies installed (better-sqlite3, yjs):', err.message);
	process.exit(1);
}

// Mirrors src/lib/shared/ydoc-codec.ts — the doctor is plain JS and cannot
// import the TS module. Keep in sync.
const REVIEW_ARRAY_NAME = 'rounds';
const COMMENTS_MAP_NAME = 'comments';
const SYSTEM_ORIGIN = 'system';

// Mirrors BINARY_EXTENSIONS in src/lib/server/document-files.ts: the gate
// is a DENYLIST — any extension not on it is an editable text document.
const BINARY_EXTENSIONS = new Set([
	'pdf','png','jpg','jpeg','gif','webp','ico','bmp','tif','tiff','heic','mp3','wav','ogg','mp4','mov','avi','mkv','zip','gz','tgz','bz2','xz','tar','7z','rar','docx','xlsx','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','bin','exe','dll','dylib','so','wasm','sqlite','db','pyc','class','jar','dmg','iso'
]);
function isBinaryTab(tabId) {
	const base = tabId.split('/').pop() ?? '';
	const idx = base.lastIndexOf('.');
	if (idx <= 0) return false;
	return BINARY_EXTENSIONS.has(base.slice(idx + 1).toLowerCase());
}

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set();
let workspaceArg = null;
let tabScope = null;
let reopenTarget = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--tab') tabScope = argv[++i] ?? null;
	else if (a === '--reopen') { flags.add('--reopen'); reopenTarget = argv[++i] ?? null; }
	else if (a.startsWith('--')) flags.add(a);
	else if (!workspaceArg) workspaceArg = a;
}
const asJson = flags.has('--json');
const workspace = resolve(workspaceArg ?? process.env.DOCWRITER_ROOT ?? process.cwd());
const stateDir = join(workspace, '.docwriter');
const dbPath = join(stateDir, 'docwriter.db');

const out = { workspace, stateDir, dbPath, notes: [], documents: [], seqGaps: null };
let db = null;
function note(line) {
	out.notes.push(line);
	if (!asJson) console.log(line);
}

// ── locate state / stray dirs ─────────────────────────────────────────────
if (!asJson) console.log(`\ndocwriter doctor\n  workspace  ${workspace}\n  state      ${stateDir}\n`);
const cwd = resolve(process.cwd());
if (cwd !== workspace && existsSync(join(cwd, '.docwriter'))) {
	note(`NOTE: a different .docwriter exists in your current directory (${join(cwd, '.docwriter')}). State follows the workspace directory — if that one looks empty, this workspace's live state is at ${stateDir}.`);
}
const parent = dirname(workspace);
if (parent !== workspace && existsSync(join(parent, '.docwriter'))) {
	note(`NOTE: the parent directory also has a .docwriter (${join(parent, '.docwriter')}) — likely from opening docwriter with a different root at some point.`);
}
if (!existsSync(dbPath)) {
	note(`No database at ${dbPath} — this workspace has no docwriter state (or you are pointing doctor at the wrong directory).`);
	finish(1);
}

db = new Database(dbPath);
const userVersion = db.pragma('user_version', { simple: true });
out.userVersion = userVersion;
const integrity = db.pragma('integrity_check', { simple: true });
out.integrity = integrity;
note(`schema v${userVersion} · integrity_check: ${integrity}`);

if (userVersion < 13) {
	// Pre-documents-table schema. Report the legacy orphan signature and
	// stop: opening the workspace in docwriter migrates AND heals it
	// (orphaned tab data becomes closed, restorable documents).
	const tabRows = safeAll(`SELECT tab_id FROM tabs ORDER BY order_index`);
	const logIds = safeAll(`SELECT DISTINCT tab_id FROM yjs_updates`);
	const tabSet = new Set(tabRows.map((r) => r.tab_id));
	const orphans = logIds.map((r) => r.tab_id).filter((id) => !tabSet.has(id));
	note(`legacy schema: ${tabRows.length} tab row(s), ${logIds.length} distinct id(s) in the update log`);
	for (const id of orphans) note(`  ORPHANED: "${id}" has update history but no tab row`);
	note('Open this workspace in docwriter once — the v13 migration converts orphans into closed, restorable documents automatically — then re-run doctor.');
	finish(orphans.length > 0 ? 2 : 0);
}

// ── v13 report ────────────────────────────────────────────────────────────
const docs = safeAll(`SELECT tab_id, status, order_index, is_active, missing_since, created, last_activity FROM documents ORDER BY status DESC, order_index, tab_id`);
const logStats = new Map(
	safeAll(`SELECT tab_id, COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi, MAX(created) AS last FROM yjs_updates GROUP BY tab_id`)
		.map((r) => [r.tab_id, r])
);
const strayLog = [...logStats.keys()].filter((id) => !docs.some((d) => d.tab_id === id));
for (const id of strayLog) {
	note(`ORPHANED LOG (should be impossible with the FK — investigate): "${id}"`);
}

for (const d of docs) {
	const stats = logStats.get(d.tab_id);
	const fileExists = existsSync(join(workspace, d.tab_id));
	const doc = stats ? replayTab(d.tab_id) : null;
	const rounds = doc ? readRounds(doc) : [];
	const threads = doc ? readThreads(doc) : [];
	const openThreads = threads.filter((t) => !t.resolved);
	const orphanRounds = rounds.filter(
		(r) => r.feedbackThreadId && !threads.some((t) => t.id === r.feedbackThreadId && !t.resolved)
	);
	const entry = {
		tabId: d.tab_id,
		status: d.status,
		fileExists,
		missingSince: d.missing_since,
		updates: stats?.n ?? 0,
		lastActivity: d.last_activity,
		pendingRounds: rounds.length,
		openThreads: openThreads.length,
		dismissedThreads: threads.length - openThreads.length,
		roundsWithDanglingThread: orphanRounds.length,
		binary: isBinaryTab(d.tab_id)
	};
	out.documents.push(entry);
	if (!asJson) {
		const bits = [
			`${d.status === 'open' ? 'open  ' : 'closed'}`,
			`${String(entry.updates).padStart(6)} updates`,
			`${entry.pendingRounds} pending round(s)`,
			`${entry.openThreads} open / ${entry.dismissedThreads} dismissed thread(s)`
		];
		if (!fileExists) bits.push('FILE MISSING' + (entry.updates > 0 ? ' (restorable from log)' : ''));
		if (entry.roundsWithDanglingThread > 0) bits.push(`${entry.roundsWithDanglingThread} round(s) with dangling thread`);
		if (entry.binary && entry.updates > 0) bits.push('BINARY TAB WITH LOG ROWS (run --gc or report a bug)');
		console.log(`  ${d.tab_id}\n    ${bits.join(' · ')}`);
	}
	doc?.destroy();
}

// Seq gaps: deletes never reuse AUTOINCREMENT values, so gaps mark past
// purges/compactions — expected history, not corruption.
const seqs = safeAll(`SELECT seq FROM yjs_updates ORDER BY seq`).map((r) => r.seq);
let gaps = 0, missing = 0;
for (let i = 1; i < seqs.length; i++) {
	const d = seqs[i] - seqs[i - 1];
	if (d > 1) { gaps += 1; missing += d - 1; }
}
out.seqGaps = { gaps, missing };
note(`seq gaps: ${gaps} gap(s), ${missing} missing value(s) — deletions/compactions never reuse AUTOINCREMENT seqs; this is history, not corruption`);

const backupsDir = join(stateDir, 'backups');
const backups = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.endsWith('.json')) : [];
out.backups = backups.length;
note(`backups: ${backups.length} snapshot(s) in ${backupsDir}`);

// ── repairs ───────────────────────────────────────────────────────────────
let mutated = false;

if (flags.has('--reopen')) {
	if (!reopenTarget) { note('--reopen requires a tab id'); finish(1); }
	const row = db.prepare(`SELECT status FROM documents WHERE tab_id = ?`).get(reopenTarget);
	if (!row) { note(`--reopen: no document named "${reopenTarget}"`); finish(1); }
	const maxOrder = db.prepare(`SELECT MAX(order_index) AS m FROM documents WHERE status = 'open'`).get();
	db.prepare(`UPDATE documents SET status = 'open', order_index = ?, missing_since = NULL WHERE tab_id = ?`)
		.run((maxOrder.m ?? -1) + 1, reopenTarget);
	note(`reopened "${reopenTarget}" into the tab bar`);
	mutated = true;
}

if (flags.has('--clear-pending')) {
	for (const d of docsInScope()) {
		const changed = mutateTab(d.tab_id, 'clear-pending', (ydoc) => {
			const arr = ydoc.getArray(REVIEW_ARRAY_NAME);
			if (arr.length === 0) return false;
			const dropped = arr.toArray();
			arr.delete(0, arr.length);
			// Announce threads that only existed to carry a now-dropped edit
			// (single agent message, no conversation) resolve with it.
			const map = ydoc.getMap(COMMENTS_MAP_NAME);
			for (const round of dropped) {
				if (!round || typeof round.feedbackThreadId !== 'string') continue;
				const t = readThreadValue(map.get(round.feedbackThreadId));
				if (!t || t.resolved) continue;
				if (t.messages.some((m) => m.author === 'user')) continue;
				setResolvedInMap(map, round.feedbackThreadId, true);
			}
			return true;
		});
		if (changed) note(`cleared pending rounds on "${d.tab_id}"`);
	}
	mutated = true;
}

if (flags.has('--resolve-threads')) {
	for (const d of docsInScope()) {
		const changed = mutateTab(d.tab_id, 'resolve-threads', (ydoc) => {
			const map = ydoc.getMap(COMMENTS_MAP_NAME);
			let any = false;
			for (const id of [...map.keys()]) {
				const t = readThreadValue(map.get(id));
				if (t && !t.resolved) { setResolvedInMap(map, id, true); any = true; }
			}
			return any;
		});
		if (changed) note(`resolved all threads on "${d.tab_id}"`);
	}
	mutated = true;
}

if (flags.has('--gc')) {
	const doomed = docs.filter(
		(d) => d.status === 'closed' && !existsSync(join(workspace, d.tab_id))
	);
	for (const d of doomed) {
		backupTab(d.tab_id, 'doctor-gc');
		db.prepare(`DELETE FROM documents WHERE tab_id = ?`).run(d.tab_id); // FK cascades the log
		note(`gc: deleted closed document "${d.tab_id}" (file gone; snapshot in backups/)`);
	}
	if (doomed.length === 0) note('gc: nothing to collect');
	mutated = doomed.length > 0 || mutated;
}

if (flags.has('--compact')) {
	const THRESHOLD = 500;
	for (const d of docsInScope()) {
		const stats = logStats.get(d.tab_id);
		if (!stats || (stats.n <= THRESHOLD && !tabScope)) continue;
		const rows = db
			.prepare(`SELECT payload FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
			.all(d.tab_id);
		if (rows.length < 2) continue;
		const merged = Y.mergeUpdates(rows.map((r) => new Uint8Array(r.payload)));
		db.transaction(() => {
			db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(d.tab_id);
			db.prepare(`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`)
				.run(d.tab_id, Buffer.from(merged), SYSTEM_ORIGIN, Date.now());
		})();
		note(`compacted "${d.tab_id}": ${rows.length} rows → 1`);
		mutated = true;
	}
}

if (mutated) {
	note('\nRepairs applied. If docwriter is currently running against this workspace, restart it so live documents reload the repaired state.');
}
finish(0);

// ── helpers ───────────────────────────────────────────────────────────────
function safeAll(sql) {
	try { return db.prepare(sql).all(); } catch { return []; }
}
function docsInScope() {
	return tabScope ? docs.filter((d) => d.tab_id === tabScope) : docs;
}
function replayTab(tabId) {
	const rows = db.prepare(`SELECT payload, origin FROM yjs_updates WHERE tab_id = ? ORDER BY seq`).all(tabId);
	const ydoc = new Y.Doc();
	for (const row of rows) {
		ydoc.transact(() => Y.applyUpdate(ydoc, new Uint8Array(row.payload)), row.origin);
	}
	return ydoc;
}
function readRounds(ydoc) {
	return ydoc.getArray(REVIEW_ARRAY_NAME).toArray();
}
function readThreadValue(value) {
	if (value instanceof Y.Map) {
		const messages = value.get('messages');
		return {
			id: value.get('id'),
			resolved: value.get('resolved') === true,
			messages: messages instanceof Y.Array ? messages.toArray() : []
		};
	}
	if (value && typeof value === 'object' && typeof value.id === 'string') {
		return { id: value.id, resolved: value.resolved === true, messages: value.messages ?? [] };
	}
	return null;
}
function readThreads(ydoc) {
	const outThreads = [];
	ydoc.getMap(COMMENTS_MAP_NAME).forEach((value) => {
		const t = readThreadValue(value);
		if (t) outThreads.push(t);
	});
	return outThreads;
}
function setResolvedInMap(map, id, resolved) {
	const value = map.get(id);
	if (value instanceof Y.Map) value.set('resolved', resolved);
	else if (value && typeof value === 'object') map.set(id, { ...value, resolved });
}
function backupTab(tabId, reason) {
	try {
		const ydoc = replayTab(tabId);
		mkdirSync(backupsDir, { recursive: true });
		const path = join(backupsDir, `${encodeURIComponent(tabId)}-${Date.now()}.json`);
		writeFileSync(path, JSON.stringify({ tabId, reason, savedAt: new Date().toISOString(), rounds: readRounds(ydoc), threads: readThreads(ydoc) }, null, 2));
		ydoc.destroy();
	} catch (err) {
		console.error(`backup failed for "${tabId}":`, err.message);
	}
}
/** Replay, mutate inside a SYSTEM transaction, append the delta as one row. */
function mutateTab(tabId, reason, mutate) {
	if (!logStats.get(tabId)) return false;
	backupTab(tabId, `doctor-${reason}`);
	const ydoc = replayTab(tabId);
	const before = Y.encodeStateVector(ydoc);
	let changed = false;
	ydoc.transact(() => { changed = mutate(ydoc) === true; }, SYSTEM_ORIGIN);
	if (changed) {
		const delta = Y.encodeStateAsUpdate(ydoc, before);
		if (delta.length > 0) {
			db.prepare(`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`)
				.run(tabId, Buffer.from(delta), SYSTEM_ORIGIN, Date.now());
		}
	}
	ydoc.destroy();
	return changed;
}
function finish(code) {
	if (asJson) console.log(JSON.stringify(out, null, 2));
	try { db?.close(); } catch { /* not open */ }
	process.exit(code);
}
