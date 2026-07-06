import { IS_HOSTED } from '$lib/hosted';

const AUTH_RECOVERY_KEY = 'docwriter.authRecoveryAt';
const AUTH_RECOVERY_COOLDOWN_MS = 15_000;

let recoveryScheduled = false;

export function isAuthFailureStatus(status: number): boolean {
	return status === 401 || status === 403;
}

export function clearAuthRecovery() {
	recoveryScheduled = false;
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.removeItem(AUTH_RECOVERY_KEY);
	} catch {
		// Storage can be unavailable in strict browser modes.
	}
}

export function scheduleAuthRecovery(): boolean {
	if (typeof window === 'undefined') return false;
	if (!IS_HOSTED) return false;
	if (recoveryScheduled) return true;

	const now = Date.now();
	let lastRecovery = 0;
	try {
		lastRecovery = Number(sessionStorage.getItem(AUTH_RECOVERY_KEY) || 0) || 0;
	} catch {
		lastRecovery = 0;
	}
	if (now - lastRecovery < AUTH_RECOVERY_COOLDOWN_MS) return false;

	try {
		sessionStorage.setItem(AUTH_RECOVERY_KEY, String(now));
	} catch {
		// Non-fatal: still schedule one in-memory recovery for this page.
	}
	recoveryScheduled = true;
	setTimeout(() => window.location.reload(), 250);
	return true;
}

export function authRecoveryMessage(scheduled: boolean): string {
	return scheduled ? 'Refreshing sign-in...' : 'Sign-in expired. Refresh or sign in again.';
}

/** Thrown by authFetch when a request came back 401/403. `message` is
 * user-presentable. */
export class AuthFailureError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(authRecoveryMessage(scheduleAuthRecovery()));
		this.name = 'AuthFailureError';
		this.status = status;
	}
}

/**
 * fetch() with uniform auth handling: a 401/403 schedules hosted-mode
 * recovery (page reload behind a cooldown) and throws AuthFailureError with
 * a user-presentable message; any other response clears the recovery flag
 * and is returned as-is. Use this for every /api call so an expired session
 * recovers no matter which panel hits it first.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const res = await fetch(input, init);
	if (isAuthFailureStatus(res.status)) {
		throw new AuthFailureError(res.status);
	}
	clearAuthRecovery();
	return res;
}

/**
 * authFetch + JSON parsing in one call. A 401/403 throws AuthFailureError
 * (and schedules hosted recovery) via authFetch before we ever get here;
 * any other non-ok response throws an Error carrying the server's
 * `error`/`message` field (falling back to `HTTP <status>`). On success the
 * parsed JSON body is returned. Collapses the repeated
 * fetch → res.json() → `if (!res.ok) throw` block used across the panels.
 */
export async function apiJson<T = any>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
	const res = await authFetch(input, init);
	const data = await res.json().catch(() => null);
	if (!res.ok) {
		throw new Error(data?.error ?? data?.message ?? `HTTP ${res.status}`);
	}
	return data as T;
}
