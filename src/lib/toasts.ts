/**
 * Sticky toast notifications.
 *
 * Unlike typical toasts these do NOT auto-dismiss — they persist until the
 * user acts on them (Accept / Dismiss). Used to surface agent-proposed rules
 * and hooks now that the right-side review sidebar is gone. The ToastStack
 * component subscribes to `toastQueue` and renders the stack top-right;
 * +page.svelte reconciles the queue against the `proposedRules` /
 * `proposedHooks` stores.
 *
 * A toast's `id` is derived from its `kind` + `refId`, so pushing the same
 * proposal twice is a no-op and dismissal can be addressed by reference.
 */
import { writable } from 'svelte/store';

export interface ToastSpec {
	id: string;
	kind: 'rule' | 'hook';
	title: string;
	body: string;
	/** The ProposedRule / ProposedHook id this toast represents. */
	refId: string;
}

export const toastQueue = writable<ToastSpec[]>([]);

function toastId(kind: ToastSpec['kind'], refId: string): string {
	return `${kind}:${refId}`;
}

/** Add a sticky toast. No-op if one for the same kind+refId already exists. */
export function pushToast(spec: Omit<ToastSpec, 'id'>): void {
	const id = toastId(spec.kind, spec.refId);
	toastQueue.update((q) => (q.some((t) => t.id === id) ? q : [...q, { ...spec, id }]));
}

/** Remove a toast by its own id. */
export function dismissToast(id: string): void {
	toastQueue.update((q) => q.filter((t) => t.id !== id));
}

/** Remove the toast representing a given proposal, if present. */
export function dismissToastByRef(kind: ToastSpec['kind'], refId: string): void {
	dismissToast(toastId(kind, refId));
}
