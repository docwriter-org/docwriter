/** Vercel landing deploy — marketing + study sign-in only, not the local CLI editor. */
export const IS_HOSTED_LANDING =
	process.env.VERCEL === '1' || process.env.LANDING_DEPLOY === '1';
