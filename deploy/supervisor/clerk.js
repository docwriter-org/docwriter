/**
 * Clerk as the identity provider. Clerk handles the sign-in UI (email,
 * magic link, Google, GitHub, whatever the dashboard enables); the
 * supervisor verifies one Clerk session token at sign-in, looks up the
 * user's primary email, and from then on uses its own signed cookie.
 *
 * Why not verify Clerk's cookie on every request: Clerk session tokens
 * live 60 seconds and are refreshed by ClerkJS running on the page. The
 * DocWriter app page does not load ClerkJS, so its requests would start
 * failing a minute after sign-in. Issuing our own cookie keeps Clerk out
 * of the app entirely.
 */
import { createClerkClient } from '@clerk/backend';
import { clerkJSScriptUrl, clerkUIScriptUrl } from '@clerk/shared/loadClerkJsScript';

export function createClerkVerifier({ publishableKey, secretKey, publicOrigin, authorizedParties = [publicOrigin] }) {
	const clerk = createClerkClient({ publishableKey, secretKey });
	// A browser-issued token carries `azp` = the page origin; verifying it
	// stops a token from another site on the same Clerk instance being
	// replayed here. Tokens minted server-side have no `azp` and only pass
	// when the list is empty.
	const authOptions = authorizedParties.length ? { authorizedParties } : {};
	return {
		scriptUrls() {
			return { js: clerkJSScriptUrl({ publishableKey }), ui: clerkUIScriptUrl({ publishableKey }) };
		},
		/** Bearer session token → Clerk user id, or null. */
		async verify(token) {
			const request = new Request(`${publicOrigin}/auth/clerk/session`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` }
			});
			const state = await clerk.authenticateRequest(request, authOptions);
			if (!state.isSignedIn) return null;
			return state.toAuth().userId ?? null;
		},
		/** Clerk user id → primary email (lowercased), or null. */
		async email(userId) {
			const user = await clerk.users.getUser(userId);
			const primary =
				user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
				user.emailAddresses[0]?.emailAddress ??
				null;
			return primary ? primary.toLowerCase() : null;
		}
	};
}
