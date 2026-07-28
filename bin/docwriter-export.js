#!/usr/bin/env node
/**
 * docwriter-export — bundle a workspace's study data for collection.
 *
 * Usage:
 *   node bin/docwriter-export.js [workspace-dir] [--out <dir>]
 *   npm run study:export [-- <workspace-dir>]
 *
 * Produces a self-contained folder the participant can zip and send:
 *
 *   study-export-<participant>-<timestamp>/
 *     docwriter.db     WAL-safe snapshot (VACUUM INTO) of the full DB:
 *                      yjs_updates (every keystroke + agent edit, origin-
 *                      tagged), conversation_events + provider_session_entries
 *                      (the AI transcript), interaction_events (UI log), tabs,
 *                      rules, reviewers, kv.
 *     events.jsonl     Flattened merged timeline (interaction_events ∪
 *                      conversation_events ∪ yjs_updates metadata) sorted by
 *                      server timestamp — pandas-ready without SQLite.
 *     files/…          Current contents of every open tab + document.md.
 *     manifest.json    Participant ID, app/schema versions, row counts,
 *                      time range.
 *
 * The live app can keep running during export — VACUUM INTO takes a
 * consistent snapshot of a WAL-mode database.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
	existsSync,
	mkdirSync,
	copyFileSync,
	readFileSync,
	writeFileSync,
	appendFileSync
} from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
let rootArg = null;
let outArg = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--out') outArg = argv[++i];
	else if (a.startsWith('--out=')) outArg = a.slice(6);
	else if (a === '-h' || a === '--help') {
		console.log('Usage: docwriter-export [workspace-dir] [--out <dir>]');
		process.exit(0);
	} else if (!a.startsWith('-')) rootArg = a;
}

const workspaceRoot = resolve(rootArg ?? process.env.DOCWRITER_ROOT ?? process.cwd());
const dbPath = join(workspaceRoot, '.docwriter', 'docwriter.db');
if (!existsSync(dbPath)) {
	console.error(`[docwriter-export] No database at ${dbPath}`);
	console.error('Run this from (or point it at) a workspace docwriter has been used in.');
	process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const BetterSqlite3 = require('better-sqlite3');
const db = new BetterSqlite3(dbPath);

// --------------------------------------------------------------------------
// Metadata
// --------------------------------------------------------------------------
function kvGet(key) {
	try {
		const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
		return row?.value ?? null;
	} catch {
		return null;
	}
}
function tableCount(table) {
	try {
		return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
	} catch {
		return null; // table absent (older schema) — recorded as null
	}
}

const participant = kvGet('participantId');
const schemaVersion = db.pragma('user_version', { simple: true });
const stamp = new Date()
	.toISOString()
	.replace(/[-:]/g, '')
	.replace(/T/, '-')
	.slice(0, 15);
const outDir = resolve(
	outArg ?? join(workspaceRoot, `study-export-${participant ?? 'anon'}-${stamp}`)
);
mkdirSync(outDir, { recursive: true });

// --------------------------------------------------------------------------
// 1. DB snapshot (WAL-safe)
// --------------------------------------------------------------------------
const snapshotPath = join(outDir, 'docwriter.db');
db.prepare('VACUUM INTO ?').run(snapshotPath);
console.log(`  db        ${snapshotPath}`);

// --------------------------------------------------------------------------
// 2. Current tab files + document.md
// --------------------------------------------------------------------------
const filesDir = join(outDir, 'files');
const copied = [];
const tabIds = (() => {
	try {
		return db.prepare('SELECT tab_id FROM tabs ORDER BY order_index ASC').all().map((r) => r.tab_id);
	} catch {
		return [];
	}
})();
for (const rel of new Set([...tabIds, 'document.md'])) {
	const src = join(workspaceRoot, rel);
	// Tab ids are workspace-relative paths; refuse anything that escapes.
	if (!resolve(src).startsWith(workspaceRoot)) continue;
	if (!existsSync(src)) continue;
	const dest = join(filesDir, rel);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	copied.push(rel);
}
console.log(`  files     ${copied.length} copied (${copied.join(', ') || 'none'})`);

// --------------------------------------------------------------------------
// 3. Merged timeline → events.jsonl
// --------------------------------------------------------------------------
function parseJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return { unparseable: true };
	}
}

const rows = [];
try {
	for (const r of db
		.prepare('SELECT id, boot_id, source, event, tab_id, data, client_ts, created FROM interaction_events ORDER BY id')
		.all()) {
		rows.push({
			t: r.created,
			kind: 'interaction',
			src: r.source,
			event: r.event,
			tab: r.tab_id ?? undefined,
			boot: r.boot_id,
			clientTs: r.client_ts ?? undefined,
			data: parseJson(r.data)
		});
	}
} catch {
	console.warn('  events    interaction_events table missing (pre-v9 DB)');
}
for (const r of db
	.prepare('SELECT session, provider, event, data, created FROM conversation_events ORDER BY id')
	.all()) {
	rows.push({
		t: r.created,
		kind: 'conversation',
		src: 'agent',
		event: r.event,
		session: r.session,
		provider: r.provider,
		data: parseJson(r.data)
	});
}
for (const r of db
	.prepare('SELECT tab_id, origin, LENGTH(payload) AS bytes, created FROM yjs_updates ORDER BY seq')
	.all()) {
	rows.push({
		t: r.created,
		kind: 'yjs_update',
		src: r.origin,
		tab: r.tab_id,
		bytes: r.bytes
	});
}
rows.sort((a, b) => a.t - b.t);
const eventsPath = join(outDir, 'events.jsonl');
writeFileSync(eventsPath, '');
// Chunked append keeps memory flat for long sessions.
const CHUNK = 5_000;
for (let i = 0; i < rows.length; i += CHUNK) {
	appendFileSync(eventsPath, rows.slice(i, i + CHUNK).map((r) => JSON.stringify(r)).join('\n') + '\n');
}
console.log(`  events    ${rows.length} rows → ${eventsPath}`);

// --------------------------------------------------------------------------
// 4. Manifest
// --------------------------------------------------------------------------
const timeRange = rows.length
	? { from: new Date(rows[0].t).toISOString(), to: new Date(rows[rows.length - 1].t).toISOString() }
	: null;
const manifest = {
	participant,
	appVersion: pkg.version,
	schemaVersion,
	exportedAt: new Date().toISOString(),
	workspace: workspaceRoot,
	timeRange,
	counts: {
		interaction_events: tableCount('interaction_events'),
		conversation_events: tableCount('conversation_events'),
		provider_session_entries: tableCount('provider_session_entries'),
		yjs_updates: tableCount('yjs_updates'),
		tabs: tableCount('tabs'),
		rules: tableCount('rules'),
		reviewers: tableCount('reviewers')
	},
	filesCopied: copied
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
db.close();

console.log(`\n  Export complete: ${outDir}`);
if (!participant) {
	console.log('  (No participant ID — start docwriter with --participant <id> to tag future sessions.)');
}
console.log('  Zip this folder and send it to the study team.\n');
