/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * In multi-tenant mode, the Clerk middleware wraps each request in
 * runWithUser(userId, fn). Downstream code (getDb, tabFile, etc.) checks
 * the context to resolve the right per-user workspace. Outside a request
 * context (dev mode, background tasks), the fallback is single-user mode.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
	userId: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export function runWithUser<T>(userId: string, fn: () => T): T {
	return store.run({ userId }, fn);
}

export function getCurrentUserId(): string | null {
	return store.getStore()?.userId ?? null;
}
