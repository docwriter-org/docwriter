/**
 * Per-user workspace resolver for multi-tenant mode.
 *
 * Each Clerk user gets an isolated workspace under DATA_DIR/workspaces/<userId>/
 * with its own .docwriter/docwriter.db and filesystem tree.
 *
 * In single-user mode (dev/CLI), this module is not used — the existing
 * module-level constants in document-files.ts and the singleton getDb()
 * handle everything.
 */
import { join } from 'path';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './db-schema';

const DATA_DIR = process.env.DOCWRITER_ROOT || process.cwd();
const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');

export interface UserWorkspace {
	userId: string;
	root: string;
	docwriterDir: string;
	providerCacheDir: string;
	claudeConfigDir: string;
	agentScratchDir: string;
}

const dbCache = new Map<string, Database>();

export function isMultiTenant(): boolean {
	return process.env.DOCWRITER_HOSTED === '1';
}

export function getUserWorkspace(userId: string): UserWorkspace {
	const root = join(WORKSPACES_DIR, userId);
	const docwriterDir = join(root, '.docwriter');
	const providerCacheDir = join(docwriterDir, 'provider-cache');
	const claudeConfigDir = join(providerCacheDir, 'claude');
	const agentScratchDir = join(docwriterDir, 'agent', 'scratch');
	return { userId, root, docwriterDir, providerCacheDir, claudeConfigDir, agentScratchDir };
}

const CLAUDE_NATIVE_TOP_LEVEL = [
	'projects',
	'sessions',
	'backups',
	'.claude.json',
	'policy-limits.json'
] as const;

function uniqueDestination(path: string): string {
	if (!existsSync(path)) return path;
	for (let i = 1; i < 1000; i += 1) {
		const candidate = `${path}.migrated-${i}`;
		if (!existsSync(candidate)) return candidate;
	}
	return `${path}.migrated-${Date.now()}`;
}

function movePath(source: string, destination: string): void {
	if (!existsSync(source)) return;
	if (!existsSync(destination)) {
		renameSync(source, destination);
		return;
	}

	const sourceStat = lstatSync(source);
	const destinationStat = lstatSync(destination);
	if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
		for (const child of readdirSync(source)) {
			movePath(join(source, child), join(destination, child));
		}
		rmSync(source, { recursive: false, force: true });
		return;
	}

	renameSync(source, uniqueDestination(destination));
}

function migrateClaudeNativeState(ws: UserWorkspace): void {
	const hasNativeState = CLAUDE_NATIVE_TOP_LEVEL.some((name) =>
		existsSync(join(ws.docwriterDir, name))
	);
	if (!hasNativeState) return;
	mkdirSync(ws.claudeConfigDir, { recursive: true });
	for (const name of CLAUDE_NATIVE_TOP_LEVEL) {
		movePath(join(ws.docwriterDir, name), join(ws.claudeConfigDir, name));
	}
}

export function ensureUserWorkspace(userId: string): UserWorkspace {
	const ws = getUserWorkspace(userId);
	if (!existsSync(ws.docwriterDir)) {
		mkdirSync(ws.docwriterDir, { recursive: true });
	}
	migrateClaudeNativeState(ws);
	if (!existsSync(join(ws.root, 'document.md'))) {
		writeFileSync(join(ws.root, 'document.md'), '# Welcome to DocWriter\n\nStart writing here.\n');
	}
	return ws;
}

export function getDbForUser(userId: string): Database {
	const cached = dbCache.get(userId);
	if (cached) return cached;

	const ws = ensureUserWorkspace(userId);
	const dbFile = join(ws.docwriterDir, 'docwriter.db');
	const db = new BetterSqlite3(dbFile);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	runMigrations(db);
	dbCache.set(userId, db);
	return db;
}

export function closeAllUserDbs(): void {
	for (const [userId, db] of dbCache) {
		try {
			db.close();
		} catch {
			// Already closed.
		}
		dbCache.delete(userId);
	}
}

// Shutdown hooks for user DBs.
let shutdownInstalled = false;
if (!shutdownInstalled) {
	shutdownInstalled = true;
	const close = () => closeAllUserDbs();
	process.once('exit', close);
	process.once('SIGINT', () => { close(); process.exit(130); });
	process.once('SIGTERM', () => { close(); process.exit(143); });
}
