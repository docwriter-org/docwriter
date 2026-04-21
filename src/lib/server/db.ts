/**
 * SQLite connection singleton. Lazily opens `.docwriter/docwriter.db` on
 * first use and runs any pending migrations.
 */
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { join } from 'path';
import { DOCWRITER_DIR, ensureDocWriterDir } from './document-files';
import { runMigrations } from './db-schema';

const DB_FILE = join(DOCWRITER_DIR, 'docwriter.db');

let cachedDb: Database | null = null;

/** Open (or return) the singleton DB connection. WAL mode is enabled so
 * reads don't block writes. Migrations run once per process on first open. */
export function getDb(): Database {
	if (cachedDb) return cachedDb;
	ensureDocWriterDir();
	const db = new BetterSqlite3(DB_FILE);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	runMigrations(db);
	cachedDb = db;
	return db;
}

/** Close the DB connection if open. Safe to call multiple times. */
export function closeDb() {
	if (!cachedDb) return;
	try {
		cachedDb.close();
	} catch {
		// Already closed — ignore.
	}
	cachedDb = null;
}

// Best-effort graceful shutdown. SvelteKit's Node adapter doesn't guarantee
// these fire in every environment, but closing WAL cleanly when possible
// avoids leaving `-wal`/`-shm` files behind.
let shutdownHooksInstalled = false;
function installShutdownHooks() {
	if (shutdownHooksInstalled) return;
	shutdownHooksInstalled = true;
	const close = () => closeDb();
	process.once('exit', close);
	process.once('SIGINT', () => {
		close();
		process.exit(130);
	});
	process.once('SIGTERM', () => {
		close();
		process.exit(143);
	});
}
installShutdownHooks();
