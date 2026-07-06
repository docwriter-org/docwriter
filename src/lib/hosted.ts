import { env } from '$env/dynamic/public';

/**
 * Client-side hosted-deployment flag — the ONE place browser code checks
 * whether it's running against the hosted multi-tenant server. The server
 * counterpart is `isMultiTenant()` in `$lib/server/deploy-mode`; deployments
 * set DOCWRITER_HOSTED and PUBLIC_DOCWRITER_HOSTED together.
 */
export const IS_HOSTED = env.PUBLIC_DOCWRITER_HOSTED === '1';
