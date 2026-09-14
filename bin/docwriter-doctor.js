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
 * pending proposals (tracked changes) and comment threads per document,
 * and backups.
 *
 * Repair flags (each writes a JSON backup to .docwriter/backups/ first):
 *   --reopen <tabId>        Reopen a closed document into the tab bar.
 *   --clear-pending         Reject ALL pending proposals (per --tab if given).
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

// Mirrors src/lib/shared/ydoc-constants.ts and proposals.ts — the doctor is
// plain JS and cannot import the TS modules. Keep in sync. A proposal is
// tracked changes on the document: `insertion` / `deletion` text formats
// carrying `{ threadId }`, plus the `suggest` / `suggestThread` paragraph
// attributes for whole lines added or removed.
const FRAGMENT_NAME = 'default';
const COMMENTS_MAP_NAME = 'comments';
const SYSTEM_ORIGIN = 'system';
const INSERTION_ATTR = 'insertion';
const DELETION_ATTR = 'deletion';
const COMMENT_ATTR = 'comment';
const SUGGEST_ATTR = 'suggest';
const SUGGEST_THREAD_ATTR = 'suggestThread';

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
	const proposalThreads = doc ? proposalThreadIds(doc) : new Set();
	const threads = doc ? readThreads(doc) : [];
	const openThreads = threads.filter((t) => !t.resolved);
	const orphanProposals = [...proposalThreads].filter(
		(id) => !threads.some((t) => t.id === id && !t.resolved)
	);
	const entry = {
		tabId: d.tab_id,
		status: d.status,
		fileExists,
		missingSince: d.missing_since,
		updates: stats?.n ?? 0,
		lastActivity: d.last_activity,
		pendingProposals: proposalThreads.size,
		openThreads: openThreads.length,
		dismissedThreads: threads.length - openThreads.length,
		proposalsWithDanglingThread: orphanProposals.length,
		binary: isBinaryTab(d.tab_id)
	};
	out.documents.push(entry);
	if (!asJson) {
		const bits = [
			`${d.status === 'open' ? 'open  ' : 'closed'}`,
			`${String(entry.updates).padStart(6)} updates`,
			`${entry.pendingProposals} pending proposal(s)`,
			`${entry.openThreads} open / ${entry.dismissedThreads} dismissed thread(s)`
		];
		if (!fileExists) bits.push('FILE MISSING' + (entry.updates > 0 ? ' (restorable from log)' : ''));
		if (entry.proposalsWithDanglingThread > 0) bits.push(`${entry.proposalsWithDanglingThread} proposal(s) whose thread is gone or dismissed`);
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
			const ids = proposalThreadIds(ydoc);
			if (ids.size === 0) return false;
			const map = ydoc.getMap(COMMENTS_MAP_NAME);
			for (const id of ids) {
				revertThreadMarks(ydoc, id);
				setResolvedInMap(map, id, true, 'rejected');
			}
			return true;
		});
		if (changed) note(`rejected pending proposals on "${d.tab_id}"`);
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
function markThread(attrs, key) {
	const v = attrs && attrs[key];
	return v && typeof v === 'object' && typeof v.threadId === 'string' ? v.threadId : null;
}
function paragraphs(ydoc) {
	const out = [];
	ydoc.getXmlFragment(FRAGMENT_NAME).forEach((p) => { if (p instanceof Y.XmlElement) out.push(p); });
	return out;
}
/** Threads that hold a proposal: any insertion / deletion run or a
 * `suggest` paragraph carrying their id. */
function proposalThreadIds(ydoc) {
	const ids = new Set();
	for (const p of paragraphs(ydoc)) {
		const owner = p.getAttribute(SUGGEST_THREAD_ATTR);
		if (p.getAttribute(SUGGEST_ATTR) && typeof owner === 'string') ids.add(owner);
		for (const c of p.toArray()) {
			if (!(c instanceof Y.XmlText)) continue;
			for (const d of c.toDelta()) {
				for (const key of [INSERTION_ATTR, DELETION_ATTR]) {
					const t = markThread(d.attributes, key);
					if (t) ids.add(t);
				}
			}
		}
	}
	return ids;
}
/** Undo one thread's marks (mirrors `revertThreadMarks` in proposals.ts):
 * its inserted text and paragraphs go, its struck text and paragraphs
 * come back, its comment highlight clears. Caller runs inside a transact. */
function revertThreadMarks(ydoc, threadId) {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	const paras = paragraphs(ydoc);
	for (let i = paras.length - 1; i >= 0; i--) {
		const p = paras[i];
		for (const c of p.toArray()) {
			if (!(c instanceof Y.XmlText)) continue;
			const ranges = [];
			let idx = 0;
			for (const d of c.toDelta()) {
				if (typeof d.insert !== 'string') continue;
				ranges.push({ start: idx, length: d.insert.length, attrs: d.attributes || {} });
				idx += d.insert.length;
			}
			for (let r = ranges.length - 1; r >= 0; r--) {
				const { start, length, attrs } = ranges[r];
				if (markThread(attrs, INSERTION_ATTR) === threadId) { c.delete(start, length); continue; }
				const fmt = {};
				if (markThread(attrs, DELETION_ATTR) === threadId) fmt[DELETION_ATTR] = null;
				if (markThread(attrs, COMMENT_ATTR) === threadId) fmt[COMMENT_ATTR] = null;
				if (Object.keys(fmt).length > 0) c.format(start, length, fmt);
			}
		}
		if (p.getAttribute(SUGGEST_THREAD_ATTR) !== threadId) continue;
		const suggest = p.getAttribute(SUGGEST_ATTR);
		let remaining = 0;
		for (const c of p.toArray()) {
			if (c instanceof Y.XmlText) remaining += c.length;
			else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') remaining += 1;
		}
		if (suggest === 'ins' && remaining === 0) { fragment.delete(i, 1); continue; }
		p.removeAttribute(SUGGEST_ATTR);
		p.removeAttribute(SUGGEST_THREAD_ATTR);
	}
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
function setResolvedInMap(map, id, resolved, outcome = 'dismissed') {
	const value = map.get(id);
	if (value instanceof Y.Map) {
		value.set('resolved', resolved);
		if (resolved) value.set('outcome', outcome);
		else value.delete('outcome');
	} else if (value && typeof value === 'object') {
		map.set(id, { ...value, resolved, ...(resolved ? { outcome } : {}) });
	}
}
function backupTab(tabId, reason) {
	try {
		const ydoc = replayTab(tabId);
		mkdirSync(backupsDir, { recursive: true });
		const path = join(backupsDir, `${encodeURIComponent(tabId)}-${Date.now()}.json`);
		writeFileSync(path, JSON.stringify({ tabId, reason, savedAt: new Date().toISOString(), proposalThreads: [...proposalThreadIds(ydoc)], threads: readThreads(ydoc) }, null, 2));
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
