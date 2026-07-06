/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * In multi-tenant mode, the Clerk middleware wraps each request in
 * runWithUser(userId, fn). Downstream code (getDb, tabFile, etc.) checks
 * the context to resolve the right per-user workspace. Outside a request
 * context (dev mode, background tasks), the fallback is single-user mode.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isMultiTenant } from './deploy-mode';

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

/** UserId scoping the current work, or null (single-user mode, or no context). */
export function getActiveUserId(): string | null {
	return isMultiTenant() ? getCurrentUserId() : null;
}

/**
 * Like getActiveUserId, but throws in multi-tenant mode when no user context
 * is active — a silent fallback there would read/write the shared root
 * across tenants. Timers and SDK callbacks that legitimately outlive the
 * request must re-enter via bindUserContext().
 */
export function requireActiveUserId(): string | null {
	if (!isMultiTenant()) return null;
	const userId = getCurrentUserId();
	if (!userId) {
		throw new Error('Multi-tenant operation attempted outside a user context');
	}
	return userId;
}

/** Capture the current user context for later re-entry (timers, SDK callbacks). */
export function bindUserContext(): <T>(fn: () => T) => T {
	const userId = getActiveUserId();
	if (!userId) return (fn) => fn();
	return (fn) => runWithUser(userId, fn);
}
