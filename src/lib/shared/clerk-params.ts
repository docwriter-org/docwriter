// Clerk appends transient handshake params to URLs mid-auth-flow. These must
// never leak into redirect targets or stored paths. Shared by client and
// server code — keep this module dependency-free.
export const CLERK_TRANSIENT_PARAMS = [
	'__clerk_handshake',
	'__clerk_handshake_nonce',
	'__clerk_help'
] as const;

export function hasClerkParams(url: URL): boolean {
	return CLERK_TRANSIENT_PARAMS.some((param) => url.searchParams.has(param));
}

/** Removes Clerk transient params from `url` in place and returns it. */
export function stripClerkParams(url: URL): URL {
	for (const param of CLERK_TRANSIENT_PARAMS) {
		url.searchParams.delete(param);
	}
	return url;
}
