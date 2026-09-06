/**
 * Persistent user registry: one row per user with a stable Linux uid and a
 * stable pair of localhost ports. Stability matters more than density —
 * a user's files are owned by their uid, and reusing ports across users
 * would let a stale browser tab talk to the wrong process.
 */
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  uid INTEGER NOT NULL UNIQUE,
  app_port INTEGER NOT NULL UNIQUE,
  ws_port INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);`;

export function allocate(seq, { uidBase, portBase }) {
	// seq starts at 1. Two consecutive ports per user.
	return { uid: uidBase + seq, appPort: portBase + 2 * (seq - 1), wsPort: portBase + 2 * (seq - 1) + 1 };
}

export function openRegistry(path, { uidBase, portBase }) {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.exec(SCHEMA);

	const selectById = db.prepare('SELECT * FROM users WHERE id = ?');
	const insert = db.prepare(
		'INSERT INTO users (id, login, uid, app_port, ws_port, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	const nextSeq = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'users'), 0) + 1 AS seq");
	const touch = db.prepare('UPDATE users SET last_seen_at = ?, login = ? WHERE id = ?');
	const all = db.prepare('SELECT * FROM users ORDER BY seq');

	const getOrCreate = db.transaction((id, login) => {
		const existing = selectById.get(id);
		const now = new Date().toISOString();
		if (existing) {
			touch.run(now, login, id);
			return { ...existing, login };
		}
		const { seq } = nextSeq.get();
		const { uid, appPort, wsPort } = allocate(seq, { uidBase, portBase });
		insert.run(id, login, uid, appPort, wsPort, now, now);
		return selectById.get(id);
	});

	return {
		getOrCreate: (id, login) => rowToUser(getOrCreate(id, login)),
		get: (id) => {
			const row = selectById.get(id);
			return row ? rowToUser(row) : null;
		},
		all: () => all.all().map(rowToUser),
		close: () => db.close()
	};
}

function rowToUser(row) {
	return {
		id: row.id,
		login: row.login,
		uid: row.uid,
		appPort: row.app_port,
		wsPort: row.ws_port,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at
	};
}
