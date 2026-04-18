/**
 * In-memory bookkeeping for pending AskUserQuestion tool calls.
 *
 * The render endpoint's `canUseTool` intercepts AskUserQuestion calls,
 * mints an id, parks a resolver here, and sends the questions to the
 * browser over SSE. The `/api/ask-user-reply` endpoint calls
 * `resolvePendingAskUser` when the user picks answers, which unblocks
 * the render loop with the user's selections.
 *
 * This lives in a shared module (not inside a `+server.ts`) because
 * SvelteKit restricts `+server.ts` exports to HTTP methods — sharing
 * state across routes needs a plain lib module.
 */

interface PendingAskUser {
	resolve: (answers: string[]) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingAskUser>();

/** Park a resolver, return the timer so callers can cancel on abort. */
export function registerPendingAskUser(
	id: string,
	resolve: (answers: string[]) => void,
	timeoutMs: number
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => {
		pending.delete(id);
		resolve([]);
	}, timeoutMs);
	pending.set(id, { resolve, timer });
	return timer;
}

/** Resolve the pending promise with the user's answers. Returns false
 * if the id wasn't found (timed out or already answered). */
export function resolvePendingAskUser(id: string, answers: string[]): boolean {
	const p = pending.get(id);
	if (!p) return false;
	clearTimeout(p.timer);
	pending.delete(id);
	p.resolve(answers);
	return true;
}

/** Clear an entry without resolving — used when the render is aborted. */
export function cancelPendingAskUser(id: string): void {
	const p = pending.get(id);
	if (!p) return;
	clearTimeout(p.timer);
	pending.delete(id);
}
