import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { IS_HOSTED_LANDING } from '$lib/server/deploy-mode';

/** On the Vercel landing deploy, root goes to /welcome. Main + local CLI skip
 * this. The Clerk userId rides along so hosted Y.Doc names are known
 * synchronously at hydration — no client-side identity reconstruction. */
export const load: PageServerLoad = ({ locals }) => {
	if (IS_HOSTED_LANDING) {
		redirect(307, '/welcome');
	}
	return { userId: locals.auth?.userId ?? null };
};
