/**
 * SQLite connection. In single-user mode (dev/CLI), a module-level singleton.
 * In multi-tenant mode, resolves per-user via AsyncLocalStorage context.
 */
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { join } from 'path';
import { DOCWRITER_DIR, ensureDocWriterDir } from './document-files';
import { runMigrations } from './db-schema';
import { getCurrentUserId } from './request-context';
import { isMultiTenant, getDbForUser } from './workspace';

const DB_FILE = join(DOCWRITER_DIR, 'docwriter.db');

let cachedDb: Database | null = null;

/** Open (or return) the DB connection for the current context. In multi-tenant
 * mode, checks AsyncLocalStorage for a userId and returns that user's DB.
 * In single-user mode (or outside a request context), returns the singleton. */
export function getDb(): Database {
	if (isMultiTenant()) {
		const userId = getCurrentUserId();
		if (userId) return getDbForUser(userId);
	}
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
