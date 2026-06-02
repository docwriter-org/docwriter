import { loadClerkJSScript, loadClerkUIScript } from '@clerk/shared/loadClerkJsScript';
import type { Clerk as ClerkType } from '@clerk/clerk-js';

declare global {
	interface Window {
		__internal_ClerkUICtor?: unknown;
	}
}

export async function createBrowserClerk(publishableKey: string): Promise<ClerkType> {
	await Promise.all([
		loadClerkJSScript({ publishableKey }),
		loadClerkUIScript({ publishableKey })
	]);

	if (!window.Clerk || !window.__internal_ClerkUICtor) {
		throw new Error('Unable to load Clerk.');
	}

	const clerk = window.Clerk as ClerkType;
	await clerk.load({
		ui: { ClerkUI: window.__internal_ClerkUICtor as never }
	});

	return clerk;
}
