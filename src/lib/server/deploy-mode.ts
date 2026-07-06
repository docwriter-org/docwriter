/** Vercel landing deploy — marketing + study sign-in only, not the local CLI editor. */
export const IS_HOSTED_LANDING =
	process.env.VERCEL === '1' || process.env.LANDING_DEPLOY === '1';

/**
 * Fly hosted multi-tenant deployment — Clerk auth, per-user workspaces,
 * provider locked to Claude. This is the ONLY server-side hosted check;
 * deployments must set DOCWRITER_HOSTED=1 (and PUBLIC_DOCWRITER_HOSTED=1
 * for the client bundle) together — setting only the PUBLIC var would lock
 * providers without enabling auth or tenant isolation.
 */
export function isMultiTenant(): boolean {
	return process.env.DOCWRITER_HOSTED === '1';
}
