import { env } from '$env/dynamic/public';

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
	if (env.PUBLIC_DOCWRITER_HOSTED !== '1') return false;
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
