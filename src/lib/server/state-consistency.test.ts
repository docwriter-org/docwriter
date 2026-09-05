/**
 * Regression suite for the document-lifecycle protocol (schema v13).
 *
 * Each test pins a bug from the 2026-08-31 corrupted-state field reports:
 * the migration that heals orphaned tab data, the grace-window reconcile
 * that stops transient file absence from deleting tabs, restore-from-log
 * on open, the append-mode external-edit reseed that keeps threads and
 * rounds alive, rename migration via the FK cascade, cascade-delete with
 * backups and ledger scrubbing, nested-Y threads surviving concurrent
 * writes, and the narrowed write ops that stop document-sized rounds.
 *
 * One workspace + one DB for the whole file: the migration test seeds a
 * LEGACY (v12) database BEFORE the server modules load, so the first
 * `getDb()` runs the v13 migration against real damaged data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	unlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import * as Y from 'yjs';

let root = '';
let db: typeof import('$lib/server/db');
let dw: typeof import('$lib/server/db-writes');
let rt: typeof import('$lib/server/runtime-state');
let store: typeof import('$lib/server/documents-store');
let yp: typeof import('$lib/server/ydoc-persistence');
let codec: typeof import('$lib/shared/ydoc-codec');
let reconcile: typeof import('$lib/server/tabs-reconcile');
let mcp: typeof import('$lib/server/mcp-doc-tools');
let ws: typeof import('$lib/server/ws-server');
let fi: typeof import('$lib/server/feedback-import');
let stableId: typeof import('$lib/shared/stable-id');
let tabsRoute: typeof import('../../routes/api/tabs/+server');

const ORPHAN_TAB = 'research_2026.tex';
const BINARY_TAB = 'cv.pdf';

function seededDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => codec.seedYDoc(doc, content), codec.SYSTEM_ORIGIN);
	return doc;
}

function updateRows(tabId: string) {
	return db
		.getDb()
		.prepare(
			`SELECT seq, origin, length(payload) AS bytes FROM yjs_updates WHERE tab_id = ? ORDER BY seq`
		)
		.all(tabId) as Array<{ seq: number; origin: string; bytes: number }>;
}

function insertRow(tabId: string, payload: Uint8Array, origin: string, created: number) {
	db.getDb()
		.prepare(`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`)
		.run(tabId, Buffer.from(payload), origin, created);
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'docwriter-state-consistency-'));
	process.env.DOCWRITER_ROOT = root;

	// ── Seed a LEGACY v12 database with the field-report damage ──────────
	mkdirSync(join(root, '.docwriter'), { recursive: true });
	const legacy = new BetterSqlite3(join(root, '.docwriter', 'docwriter.db'));
	legacy.exec(`
		CREATE TABLE yjs_updates (tab_id TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL);
		CREATE INDEX yjs_updates_tab_id ON yjs_updates(tab_id);
		CREATE TABLE tabs (tab_id TEXT PRIMARY KEY, order_index INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE rules (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, examples TEXT);
		CREATE TABLE hooks (id TEXT PRIMARY KEY, event TEXT NOT NULL, matcher TEXT, command TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE recent_actions (label TEXT NOT NULL, used_at INTEGER NOT NULL);
		CREATE TABLE action_usage_counts (action TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	legacy.pragma('user_version = 12');

	// An open tab, plus the exact orphan signature: a heavily-edited tab id
	// present in yjs_updates + last_seen kv but missing from `tabs`, and a
	// binary tab whose "document" is file bytes decoded as UTF-8.
	legacy.prepare(`INSERT INTO tabs (tab_id, order_index, is_active) VALUES ('draft.md', 0, 1)`).run();
	const legacyDoc = new Y.Doc();
	const frag = legacyDoc.getXmlFragment('default');
	const p = new Y.XmlElement('paragraph');
	const t = new Y.XmlText();
	t.insert(0, 'The orphaned research statement.');
	p.insert(0, [t]);
	frag.insert(0, [p]);
	// Legacy plain-object thread (pre-nested-Y shape).
	legacyDoc.getMap('comments').set('thread_legacy', {
		id: 'thread_legacy',
		anchor: { quote: 'The orphaned research statement.', occurrenceIndex: 0 },
		messages: [{ id: 'm1', author: 'agent', text: 'I would tighten this.', timestamp: 1 }],
		resolved: false,
		createdAt: 1
	});
	const ins = legacy.prepare(
		`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`
	);
	ins.run(ORPHAN_TAB, Buffer.from(Y.encodeStateAsUpdate(legacyDoc)), 'user', Date.now());
	ins.run(BINARY_TAB, Buffer.from('%PDF-1.4 Ã¸ binary bytes'), 'system', Date.now());
	legacy.prepare(`INSERT INTO kv (key, value) VALUES ('last_seen:${ORPHAN_TAB}', 'baseline')`).run();
	legacy.prepare(`INSERT INTO kv (key, value) VALUES ('last_seen:${BINARY_TAB}', 'mojibake')`).run();
	legacy.prepare(`INSERT INTO recent_actions (label, used_at) VALUES ('make it concise', 100)`).run();
	legacy.prepare(`INSERT INTO recent_actions (label, used_at) VALUES ('add citations', 200)`).run();
	legacy.prepare(`INSERT INTO action_usage_counts (action, count) VALUES ('custom_1', 7)`).run();
	legacy.prepare(`INSERT INTO action_usage_counts (action, count) VALUES ('custom_2', 3)`).run();
	legacy.close();

	writeFileSync(join(root, 'draft.md'), 'Draft body.\n');

	// ── Load the server modules; first getDb() runs migration v13 ────────
	db = await import('$lib/server/db');
	dw = await import('$lib/server/db-writes');
	rt = await import('$lib/server/runtime-state');
	store = await import('$lib/server/documents-store');
	yp = await import('$lib/server/ydoc-persistence');
	codec = await import('$lib/shared/ydoc-codec');
	reconcile = await import('$lib/server/tabs-reconcile');
	mcp = await import('$lib/server/mcp-doc-tools');
	ws = await import('$lib/server/ws-server');
	fi = await import('$lib/server/feedback-import');
	stableId = await import('$lib/shared/stable-id');
	tabsRoute = await import('../../routes/api/tabs/+server');
	db.getDb();
});

afterAll(() => {
	db.closeDb();
	rmSync(root, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('migration v13 heals a damaged legacy database', () => {
	it('recovers orphaned tab data as a closed, restorable document', () => {
		const doc = store.getDocument(ORPHAN_TAB);
		expect(doc?.status).toBe('closed');
		// last_seen moved from kv onto the row; the kv entry is gone.
		expect(doc?.lastSeen).toBe('baseline');
		expect(dw.kvGet(`last_seen:${ORPHAN_TAB}`)).toBeNull();
		// The update log survived intact.
		expect(updateRows(ORPHAN_TAB).length).toBe(1);
	});

	it('purges binary-tab rows (file bytes are not documents)', () => {
		expect(updateRows(BINARY_TAB).length).toBe(0);
		expect(store.getDocument(BINARY_TAB)).toBeNull();
		expect(dw.kvGet(`last_seen:${BINARY_TAB}`)).toBeNull();
	});

	it('keeps open tabs and remaps usage-count keys to stable label-hash ids', () => {
		expect(store.getDocument('draft.md')?.status).toBe('open');
		const counts = rt.getActionUsageCounts();
		expect(counts[stableId.actionIdForLabel('make it concise')]).toBe(7);
		expect(counts[stableId.actionIdForLabel('add citations')]).toBe(3);
		expect(counts['custom_1']).toBeUndefined();
	});

	it('reopening the healed document restores its text and threads from the log', () => {
		const ydoc = new Y.Doc();
		yp.replayUpdatesInto(ydoc, ORPHAN_TAB);
		expect(codec.serializeYDoc(ydoc)).toContain('The orphaned research statement.');
		const threads = codec.readCommentThreads(ydoc);
		expect(threads).toHaveLength(1);
		expect(threads[0].messages[0].text).toBe('I would tighten this.');
		ydoc.destroy();
	});

	it('enforces the FK: deleting a document cascades its update log', () => {
		store.ensureDocument('cascade-check.md');
		const probe = seededDoc('cascade probe\n');
		insertRow('cascade-check.md', Y.encodeStateAsUpdate(probe), 'user', Date.now());
		expect(updateRows('cascade-check.md').length).toBe(1);
		store.deleteDocument('cascade-check.md');
		expect(updateRows('cascade-check.md').length).toBe(0);
	});
});

describe('missing files no longer destroy tabs', () => {
	it('a transiently missing file keeps its tab (badged), and its return is a non-event', async () => {
		writeFileSync(join(root, 'chapter.md'), 'Chapter body.\n');
		store.openDocument('chapter.md');
		const doc = seededDoc('Chapter body.\n');
		insertRow('chapter.md', Y.encodeStateAsUpdate(doc), 'user', Date.now());

		unlinkSync(join(root, 'chapter.md')); // git-pull window
		let state = reconcile.reconcileOpenTabs();
		expect(state.order).toContain('chapter.md'); // still listed
		expect(state.missing).toContain('chapter.md'); // badged

		writeFileSync(join(root, 'chapter.md'), 'Chapter body.\n'); // pull finished
		state = reconcile.reconcileOpenTabs();
		expect(state.order).toContain('chapter.md');
		expect(state.missing).not.toContain('chapter.md');
		expect(updateRows('chapter.md').length).toBeGreaterThan(0); // history intact
	});

	it('a history-backed document is never auto-dropped, however long the file is gone', () => {
		unlinkSync(join(root, 'chapter.md'));
		// Age the stamp far past the grace window.
		db.getDb()
			.prepare(`UPDATE documents SET missing_since = ? WHERE tab_id = 'chapter.md'`)
			.run(Date.now() - 10 * reconcile.MISSING_TAB_GRACE_MS);
		const state = reconcile.reconcileOpenTabs();
		expect(state.order).toContain('chapter.md');
		writeFileSync(join(root, 'chapter.md'), 'Chapter body.\n');
		reconcile.reconcileOpenTabs();
	});

	it('a no-history tab missing beyond the grace window is removed cleanly', () => {
		store.openDocument('ephemeral.md', { activate: false });
		db.getDb()
			.prepare(`UPDATE documents SET missing_since = ? WHERE tab_id = 'ephemeral.md'`)
			.run(Date.now() - 10 * reconcile.MISSING_TAB_GRACE_MS);
		const state = reconcile.reconcileOpenTabs();
		expect(state.order).not.toContain('ephemeral.md');
		expect(store.getDocument('ephemeral.md')).toBeNull(); // nothing dangles
	});

	it('opening a path whose file is missing restores it from the log instead of truncating', async () => {
		unlinkSync(join(root, 'chapter.md'));
		const request = new Request('http://localhost/api/tabs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'chapter.md' })
		});
		await tabsRoute.POST({ request } as never);
		expect(readFileSync(join(root, 'chapter.md'), 'utf-8')).toContain('Chapter body.');
		expect(updateRows('chapter.md').length).toBeGreaterThan(0); // history NOT purged
	});
});

describe('external edits fold in instead of purging', () => {
	it('text follows disk while threads, rounds and the log survive', () => {
		const tabId = 'paper.tex';
		writeFileSync(join(root, tabId), 'Methods section.\nResults section.\n');
		store.ensureDocument(tabId);
		const doc = seededDoc('Methods section.\nResults section.\n');
		doc.transact(() => {
			codec.putThread(codec.getCommentsMap(doc), {
				id: 'thread_keep',
				anchor: { quote: 'Methods section.', occurrenceIndex: 0 },
				messages: [{ id: 'm', author: 'agent', text: 'note to keep', timestamp: 1 }],
				resolved: false,
				createdAt: 1
			});
			codec.getReviewArray(doc).push([
				{
					id: 'round_keep',
					operation: { type: 'edit', oldString: 'Results section.', newString: 'Findings.' },
					feedbackThreadId: 'thread_keep',
					timestamp: 1
				}
			]);
		}, codec.AGENT_ORIGIN);
		insertRow(tabId, Y.encodeStateAsUpdate(doc), 'user', Date.now() - 60_000);
		const seqBefore = updateRows(tabId)[0].seq;

		writeFileSync(join(root, tabId), 'Methods section, revised externally.\nResults section.\n');
		const fresh = new Y.Doc();
		yp.replayUpdatesInto(fresh, tabId);

		expect(codec.serializeYDoc(fresh)).toContain('revised externally');
		expect(codec.readCommentThreads(fresh)).toHaveLength(1); // thread survived
		expect(codec.readReviewRounds(fresh)).toHaveLength(1); // round survived
		const rows = updateRows(tabId);
		expect(rows.map((r) => r.seq)).toContain(seqBefore); // nothing deleted
		expect(rows.length).toBe(2); // the external edit appended as one update
		// A snapshot backup was written before folding the edit in.
		const backups = readdirSync(join(root, '.docwriter', 'backups'));
		expect(backups.some((f) => f.startsWith(encodeURIComponent(tabId)))).toBe(true);
		fresh.destroy();
	});

	it('a typography-only difference is not an external edit', () => {
		const tabId = 'notes.tex';
		writeFileSync(join(root, tabId), 'results - baseline\n');
		store.ensureDocument(tabId);
		const doc = seededDoc('results - baseline\n');
		insertRow(tabId, Y.encodeStateAsUpdate(doc), 'user', Date.now() - 60_000);

		writeFileSync(join(root, tabId), 'results – baseline\n'); // en-dash copy
		const fresh = new Y.Doc();
		yp.replayUpdatesInto(fresh, tabId);
		expect(updateRows(tabId).length).toBe(1); // no reseed, no purge
		fresh.destroy();
	});
});

describe('rename moves everything with the file', () => {
	it('PATCH rename re-keys the log; the carried client doc merges without duplication', async () => {
		const content = 'Hello from the original file.\n';
		writeFileSync(join(root, 'old.md'), content);
		store.openDocument('old.md', { activate: false });
		const serverDocBefore = new Y.Doc();
		yp.replayUpdatesInto(serverDocBefore, 'old.md'); // seeds + persists
		const clientDoc = new Y.Doc();
		Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDocBefore));

		const request = new Request('http://localhost/api/tabs', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'old.md', newId: 'new.md' })
		});
		await tabsRoute.PATCH({ request } as never);

		expect(updateRows('old.md').length).toBe(0); // nothing orphaned
		expect(updateRows('new.md').length).toBeGreaterThan(0); // history followed

		const serverDocAfter = new Y.Doc();
		yp.replayUpdatesInto(serverDocAfter, 'new.md');
		Y.applyUpdate(serverDocAfter, Y.encodeStateAsUpdate(clientDoc));
		const merged = codec.serializeYDoc(serverDocAfter);
		expect(merged.split('Hello from the original file.').length - 1).toBe(1); // no doubling
		serverDocAfter.destroy();
		serverDocBefore.destroy();
		clientDoc.destroy();
	});
});

describe('delete-file leaves nothing behind', () => {
	it('cascades the log, writes a backup, and scrubs the feedback ledger', async () => {
		const tabId = 'doomed.md';
		writeFileSync(join(root, tabId), 'Doomed content.\n');
		store.openDocument(tabId, { activate: false });
		const doc = seededDoc('Doomed content.\n');
		doc.transact(() => {
			codec.putThread(codec.getCommentsMap(doc), {
				id: 'thread_doomed',
				anchor: { quote: 'Doomed content.', occurrenceIndex: 0 },
				messages: [{ id: 'm', author: 'external', externalAuthor: 'Maya', text: 'fix this', timestamp: 1 }],
				resolved: false,
				createdAt: 1
			});
		}, codec.AGENT_ORIGIN);
		insertRow(tabId, Y.encodeStateAsUpdate(doc), 'user', Date.now());
		fi.saveFeedbackImport({
			comments: [{ id: 'c1', author: 'Maya', text: 'fix this' }],
			commentToThread: { c1: 'thread_doomed' },
			dispositions: { c1: 'discussed' }
		} as never);

		const request = new Request(
			`http://localhost/api/tabs?id=${tabId}&deleteFile=true`
		);
		await tabsRoute.DELETE({ url: new URL(request.url) } as never);

		expect(store.getDocument(tabId)).toBeNull();
		expect(updateRows(tabId).length).toBe(0);
		expect(existsSync(join(root, tabId))).toBe(false);
		const backups = readdirSync(join(root, '.docwriter', 'backups'));
		expect(backups.some((f) => f.startsWith(encodeURIComponent(tabId)))).toBe(true);
		const ledger = fi.getFeedbackImport();
		expect(ledger?.commentToThread['c1']).toBeUndefined(); // no dangling thread ref
	});
});

describe('nested-Y threads merge concurrent writes', () => {
	it('a Dismiss racing an agent reply keeps BOTH', () => {
		const server = new Y.Doc();
		const client = new Y.Doc();
		codec.putThread(codec.getCommentsMap(server), {
			id: 't',
			anchor: { quote: 'q', occurrenceIndex: 0 },
			messages: [{ id: 'm1', author: 'agent', text: 'Suggested an edit.', timestamp: 1 }],
			resolved: false,
			createdAt: 1
		});
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

		// Concurrent: agent replies on the server…
		codec.appendThreadMessage(codec.getCommentsMap(server), 't', {
			id: 'm2',
			author: 'agent',
			text: 'Done — see the new version.',
			timestamp: 2
		});
		// …while the author dismisses on the client.
		codec.setThreadResolved(codec.getCommentsMap(client), 't', true);

		Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

		for (const doc of [server, client]) {
			const t = codec.getThread(codec.getCommentsMap(doc), 't');
			expect(t?.resolved).toBe(true); // the dismiss survived
			expect(t?.messages).toHaveLength(2); // AND the reply survived
		}
		server.destroy();
		client.destroy();
	});

	it('the anchor backfill cannot clobber a concurrent reply', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		codec.putThread(codec.getCommentsMap(a), {
			id: 't2',
			anchor: { quote: 'q', occurrenceIndex: 0 },
			messages: [{ id: 'm1', author: 'agent', text: 'first', timestamp: 1 }],
			resolved: false,
			createdAt: 1
		});
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		codec.appendThreadMessage(codec.getCommentsMap(a), 't2', {
			id: 'm2',
			author: 'agent',
			text: 'second',
			timestamp: 2
		});
		codec.setThreadAnchor(codec.getCommentsMap(b), 't2', {
			quote: 'q',
			occurrenceIndex: 0,
			relStart: 'AAAA',
			relEnd: 'BBBB'
		});
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const t = codec.getThread(codec.getCommentsMap(a), 't2');
		expect(t?.messages).toHaveLength(2);
		expect(t?.anchor.relStart).toBe('AAAA');
		a.destroy();
		b.destroy();
	});
});

describe('rounds stay small', () => {
	it('a pure insertion narrows to a contextual edit op instead of a whole-document write', () => {
		// Realistic prose: each paragraph distinct, so a small context window
		// around the insertion point is unique.
		const paragraphs: string[] = [];
		for (let i = 0; i < 200; i++) {
			paragraphs.push(`Paragraph ${i} discusses evaluation topic number ${i} in detail.\n`);
		}
		const before = paragraphs.join(''); // ~11KB
		const insertion = 'A brand-new paragraph inserted in the middle.\n';
		const midpoint = paragraphs.slice(0, 100).join('').length;
		const after = before.slice(0, midpoint) + insertion + before.slice(midpoint);

		const op = mcp.narrowWriteOperation(before, after);
		expect(op).not.toBeNull();
		expect(op?.type).toBe('edit');
		if (op?.type === 'edit') {
			expect(op.oldString.length).toBeLessThan(2_000); // context, not the doc
			expect(op.newString).toContain(insertion.trim());
			// And it applies: exactly one match, replacement yields `after`.
			expect(before.split(op.oldString).length - 1).toBe(1);
			expect(before.replace(op.oldString, op.newString)).toBe(after);
		}
	});

	it('a genuine whole-document rewrite still stores as a write', () => {
		// Large and fully different: no unique narrow span exists that isn't
		// most of the document, so the round stores as a wholesale write.
		const before = Array.from({ length: 80 }, (_, i) => `Original line ${i} of the source text.`).join('\n');
		const after = Array.from({ length: 80 }, (_, i) => `Replacement sentence ${i} sharing nothing.`).join('\n');
		expect(mcp.narrowWriteOperation(before, after)).toBeNull();
	});

	it('a perfectly periodic document (no unique context anywhere) falls back to a write', () => {
		const paragraph = 'The same sentence repeats through the whole file.\n';
		const before = paragraph.repeat(200);
		const midpoint = paragraph.length * 100;
		const after = before.slice(0, midpoint) + 'Inserted.\n' + before.slice(midpoint);
		expect(mcp.narrowWriteOperation(before, after)).toBeNull();
	});
});

describe('binary tabs never materialize', () => {
	it('replay refuses to seed a PDF tab', () => {
		writeFileSync(join(root, 'preview.pdf'), '%PDF-1.4 binary');
		const ydoc = new Y.Doc();
		yp.replayUpdatesInto(ydoc, 'preview.pdf');
		expect(updateRows('preview.pdf').length).toBe(0);
		ydoc.destroy();
	});

	it('LaTeX and BibTeX are documents, not binary', async () => {
		const df = await import('$lib/server/document-files');
		expect(df.isBinaryTabPath('research_2026.tex')).toBe(false);
		expect(df.isBinaryTabPath('refs/dblp.bib')).toBe(false);
		expect(df.isBinaryTabPath('cv.pdf')).toBe(true);
		expect(df.isBinaryTabPath('figure.png')).toBe(true);
	});
});

describe('recent actions keep their history', () => {
	it('rewrites preserve per-label timestamps and ids are content-stable', () => {
		dw.dbReplaceRecentActions([{ label: 'make it concise' }, { label: 'add citations' }]);
		const before = db
			.getDb()
			.prepare(`SELECT label, used_at FROM recent_actions ORDER BY rowid`)
			.all() as Array<{ label: string; used_at: number }>;
		dw.dbReplaceRecentActions([{ label: 'add citations' }, { label: 'make it concise' }]);
		const after = new Map(
			(
				db.getDb().prepare(`SELECT label, used_at FROM recent_actions`).all() as Array<{
					label: string;
					used_at: number;
				}>
			).map((r) => [r.label, r.used_at])
		);
		for (const row of before) {
			expect(after.get(row.label)).toBe(row.used_at); // timestamps survive rewrites
		}
		const ids = rt.getRecentActions().map((a) => a.id);
		expect(ids).toContain(stableId.actionIdForLabel('make it concise'));
		expect(ids).toContain(stableId.actionIdForLabel('add citations'));
	});
});

describe('server-side rel positions', () => {
	it('threads are stamped with decodable CRDT anchors at creation', () => {
		const doc = seededDoc('First line.\nAnchor me exactly here.\nLast line.\n');
		const raw = codec.serializeFragmentRaw(codec.getFragment(doc));
		const idx = raw.indexOf('Anchor me exactly here.');
		const range = codec.computeFragmentRelRange(codec.getFragment(doc), idx, 'Anchor me exactly here.'.length);
		expect(range).not.toBeNull();
		const start = codec.decodeRelPosition(range!.relStart);
		expect(start).not.toBeNull();
		const abs = Y.createAbsolutePositionFromRelativePosition(start!, doc);
		expect(abs).not.toBeNull();
		expect(abs!.index).toBe(0); // start of the anchored line's text node
		doc.destroy();
	});
});

describe('binary tabs never reach the CRDT log', () => {
	it('appendUpdate refuses a binary tab even when something tries to write one', () => {
		// onLoadDocument already refuses to HYDRATE a binary tab, but nothing
		// stopped a write: a WebSocket sync on a PDF would have appended rows,
		// and appendUpdate's own ensureDocument() creates the identity row, so
		// the yjs_updates FK would not have caught it either. The gate belongs
		// at the one chokepoint every CRDT write passes through.
		const doc = seededDoc('Recommendation letter body.\n');
		const update = Y.encodeStateAsUpdate(doc);
		yp.appendUpdate(BINARY_TAB, update, 'user');
		expect(updateRows(BINARY_TAB).length).toBe(0);

		// The same write on a text tab still lands, so the gate is not a
		// blanket refusal.
		yp.appendUpdate('gate-control.md', update, 'user');
		expect(updateRows('gate-control.md').length).toBe(1);
		doc.destroy();
	});
});

describe('per-render state is isolated between concurrent renders', () => {
	it('one render cannot read, overwrite, or clear another render\'s scope', async () => {
		// The field reports came from rapid-fire renders. These three values
		// used to be module globals: a second render overwrote them mid-flight
		// and whichever finished first cleared all three, which misattributed
		// a critique pass's findings and pointed feedback replies at the wrong
		// thread.
		const seen: Record<string, unknown> = {};
		const gate = { a: () => {}, b: () => {} };
		const waitA = new Promise<void>((r) => (gate.a = r));
		const waitB = new Promise<void>((r) => (gate.b = r));

		const renderA = mcp.runWithRenderScope(
			{ feedbackThreadId: 'thread_A', reviewerId: 'skeptic' },
			async () => {
				gate.b();
				await waitA; // B runs to completion while A is suspended here.
				seen.aStale = mcp.getStaleAcceptApply();
				mcp.setActiveFeedbackThreadId('thread_A_revised');
				return { thread: 'thread_A_revised' };
			}
		);

		const renderB = mcp.runWithRenderScope(
			{ feedbackThreadId: 'thread_B', reviewerId: 'gricean-maxims', staleAcceptApply: null },
			async () => {
				await waitB;
				// B mutating and then leaving must not touch A's values.
				mcp.setActiveReviewerId('fresh-eyes');
				mcp.setActiveFeedbackThreadId(null);
				mcp.setStaleAcceptApply({ tabId: 'other.md' } as never);
				gate.a();
				return { done: true };
			}
		);

		await Promise.all([renderA, renderB]);
		// A never saw B's stale-accept payload, despite B setting one while A
		// was suspended.
		expect(seen.aStale).toBeNull();
		// And nothing leaked to callers outside any scope.
		expect(mcp.getStaleAcceptApply()).toBeNull();
	});

	it('a call outside any render scope falls back instead of throwing', () => {
		expect(mcp.getStaleAcceptApply()).toBeNull();
		mcp.setActiveReviewerId('orphan');
		expect(mcp.getStaleAcceptApply()).toBeNull();
		mcp.setActiveReviewerId(null);
	});
});

describe('tool results never claim an edit was applied', () => {
	// The agent repeats its tool results to the author. "Edit applied to
	// X." had it announcing an edit as done while the author still had to
	// Accept the pending diff — or while nothing had happened at all.
	const pending = { beforeMd: 'a', afterMd: 'b', threadId: 'thread_1' };

	it('an edit lands as a pending proposal on its thread, not as a change', () => {
		const text = mcp.describeTabWrite('essay.md', pending, { kind: 'edit', hits: 1 });
		expect(text).toMatch(/^Proposed the edit as a pending diff on thread thread_1 in essay\.md\./);
		expect(text).toMatch(/only when I accept it/);
		expect(text).toMatch(/do not tell me it has been applied/);
		expect(text).not.toMatch(/^Edit applied/);
	});

	it('a replacement that changes nothing says so instead of succeeding', () => {
		const noop = { beforeMd: 'a', afterMd: 'a', noop: true };
		const text = mcp.describeTabWrite('essay.md', noop, { kind: 'edit', hits: 1 });
		expect(text).toMatch(/^No change proposed for essay\.md/);
		expect(text).toMatch(/Nothing is pending/);
		expect(text).not.toMatch(/applied|Proposed the edit/);
	});

	it('write_doc distinguishes a created file from a rewrite, both pending', () => {
		expect(
			mcp.describeTabWrite('notes.md', pending, { kind: 'write', created: true, chars: 12 })
		).toMatch(/^Created notes\.md and proposed its content \(12 chars\) as a pending diff on thread thread_1\./);
		expect(
			mcp.describeTabWrite('notes.md', pending, { kind: 'write', created: false, chars: 12 })
		).toMatch(/^Proposed a rewrite of notes\.md \(12 chars\) as a pending diff on thread thread_1\./);
	});

	it('the stale-Accept commit path keeps its "already accepted" wording', () => {
		const committed = { beforeMd: 'a', afterMd: 'b', committed: true };
		expect(mcp.describeTabWrite('essay.md', committed, { kind: 'edit', hits: 1 })).toMatch(
			/^Edit applied and accepted on essay\.md\. Accept was already clicked/
		);
	});
});

describe('unloading a live doc flushes what the tick had not written yet', () => {
	// The 500ms flush tick resolves a tab's LIVE doc; a tab that unloads
	// inside that window (the browser's Accept/Reject pause closes its only
	// connection) used to have its dirty flag dropped instead, so the file
	// lagged the CRDT until the next edit.
	const TAB = 'unload-flush.md';

	it('replays the log into the workspace file when the tab was still dirty', () => {
		const doc = seededDoc('Written before the unload.\n');
		yp.appendUpdate(TAB, Y.encodeStateAsUpdate(doc), codec.USER_ORIGIN);
		yp.markTabDirty(TAB);
		expect(yp.isTabDirty(TAB)).toBe(true);
		expect(existsSync(join(root, TAB))).toBe(false);

		ws.onTabUnloaded(TAB);

		expect(yp.isTabDirty(TAB)).toBe(false);
		expect(readFileSync(join(root, TAB), 'utf-8')).toBe('Written before the unload.\n');
	});

	it('a clean tab is left alone', () => {
		const before = readFileSync(join(root, TAB), 'utf-8');
		writeFileSync(join(root, TAB), 'Edited outside, not yet reconciled.\n');
		expect(yp.isTabDirty(TAB)).toBe(false);
		ws.onTabUnloaded(TAB);
		// No dirty flag → no replay → the external content is not clobbered.
		expect(readFileSync(join(root, TAB), 'utf-8')).toBe('Edited outside, not yet reconciled.\n');
		writeFileSync(join(root, TAB), before);
	});
});

describe('accepting a thread\'s edit moves the thread with the text', () => {
	// After a round of accepts, threads whose passages the edits replaced
	// parked at the top of the gutter as orphans ("so many dangling
	// threads"). The conversation belongs with the text the edit produced.
	const P1 = 'Consider a shopper who asks for a refund.';
	const P2 = 'The application must not rely on the model.';
	const CODE = 'tools = [get_order, issue_refund]';
	const P1NEW = 'The agent handles a request like returning a yellow shirt.';

	function seed(threadQuote: string, round: Omit<import('$lib/types').PendingReviewRound, 'id' | 'timestamp'>) {
		const doc = seededDoc(`${P1}\n\n${P2}\n\n${CODE}\n`);
		const suffix = Math.random().toString(36).slice(2, 8);
		const tab = `follow-accept-${suffix}.md`;
		const threadId = 'thread_follow_' + suffix;
		doc.transact(() => {
			codec.putThread(codec.getCommentsMap(doc), {
				id: threadId,
				anchor: { quote: threadQuote, occurrenceIndex: 0 },
				messages: [
					{ id: 'm1', author: 'user', text: 'Too abstract.', timestamp: 1 },
					{ id: 'm2', author: 'agent', text: 'I will rewrite and move it.', timestamp: 2 }
				],
				resolved: false,
				createdAt: 1
			});
			codec.getReviewArray(doc).push([{ ...round, id: 'round_' + threadId, timestamp: 3, feedbackThreadId: threadId }]);
		}, codec.USER_ORIGIN);
		yp.appendUpdate(tab, Y.encodeStateAsUpdate(doc), codec.USER_ORIGIN);
		return { tab, threadId, roundId: 'round_' + threadId };
	}

	function readThread(tab: string, threadId: string) {
		const doc = new Y.Doc();
		yp.replayUpdatesInto(doc, tab);
		return {
			thread: codec.getThread(codec.getCommentsMap(doc), threadId),
			text: codec.serializeYDoc(doc)
		};
	}

	it('a move past a code block re-anchors the thread to the moved text', async () => {
		const { tab, threadId, roundId } = seed(P1, {
			operation: {
				type: 'edit',
				oldString: `${P1}\n\n${P2}\n\n${CODE}`,
				newString: `${P2}\n\n${CODE}\n\n${P1NEW}`
			},
			trigger: 'agent_edit_doc',
			feedbackThreadId: 'placeholder'
		});
		const result = await ws.acceptTabRounds(tab, roundId);
		expect(result.acceptedCount).toBe(1);
		const { thread, text } = readThread(tab, threadId);
		expect(text).toContain(P1NEW);
		expect(text).not.toContain(P1);
		expect(thread?.resolved).toBe(false);
		expect(thread?.anchor.quote).toBe(P1NEW);
		expect(thread?.anchor.relStart).toBeTruthy();
	});

	it('an edit that only removes the passage resolves the thread', async () => {
		const { tab, threadId, roundId } = seed(P1, {
			operation: { type: 'edit', oldString: `${P1}\n\n`, newString: '' },
			trigger: 'agent_edit_doc',
			feedbackThreadId: 'placeholder'
		});
		await ws.acceptTabRounds(tab, roundId);
		const { thread, text } = readThread(tab, threadId);
		expect(text).not.toContain(P1);
		expect(thread?.resolved).toBe(true);
	});

	it('a thread whose passage survived is left alone', async () => {
		const { tab, threadId, roundId } = seed(P2, {
			operation: { type: 'edit', oldString: CODE, newString: 'tools = [get_order]' },
			trigger: 'agent_edit_doc',
			feedbackThreadId: 'placeholder'
		});
		await ws.acceptTabRounds(tab, roundId);
		const { thread } = readThread(tab, threadId);
		expect(thread?.resolved).toBe(false);
		expect(thread?.anchor.quote).toBe(P2);
	});
});
