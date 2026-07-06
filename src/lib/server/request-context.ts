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

/**
 * Per-render feedback-thread context.
 *
 * `edit_doc` attaches the review round it creates to a comment thread. The
 * default thread for a render is parsed from the triggering user message
 * (`thread_id="…"`) and applies for the whole render UNLESS an individual
 * `edit_doc` call passes its own `thread_id`. This used to live in a
 * module-global in mcp-doc-tools, which two concurrent renders (two hosted
 * users, or a user render racing a warmup) would stomp on each other.
 *
 * We carry it in a dedicated AsyncLocalStorage cell instead. Each render wraps
 * its whole flow in `runWithFeedbackThread(defaultThreadId, ...)`, so every
 * async continuation it spawns — the provider query loop and the tool
 * callbacks it invokes — inherits that render's own cell. Concurrent renders
 * run separate cells and can't see each other's default.
 *
 * The cell holds a mutable object so `edit_doc` can transiently override the
 * default for a single call and restore it after (`set...` then `set...` back
 * to the captured prior value). Mutating the object is visible to the rest of
 * that render's async subtree because they all share the same store reference.
 */
interface FeedbackThreadContext {
	threadId: string | null;
}

const feedbackThreadStore = new AsyncLocalStorage<FeedbackThreadContext>();

/** Run `fn` inside a fresh feedback-thread cell seeded with `threadId`. */
export function runWithFeedbackThread<T>(threadId: string | null, fn: () => T): T {
	return feedbackThreadStore.run({ threadId }, fn);
}

/** The thread id the next agent review round should attach to for the active
 * render, or null (no default, or called outside a render context). */
export function getActiveFeedbackThreadId(): string | null {
	return feedbackThreadStore.getStore()?.threadId ?? null;
}

/** Override the active render's feedback-thread default. `edit_doc` uses this
 * to transiently target an explicit `thread_id`, then restore the prior value.
 * No-op outside a feedback-thread context (there's no cell to attach to). */
export function setActiveFeedbackThreadId(threadId: string | null): void {
	const store = feedbackThreadStore.getStore();
	if (store) store.threadId = threadId;
}
