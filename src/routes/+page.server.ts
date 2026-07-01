import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { IS_HOSTED_LANDING } from '$lib/server/deploy-mode';

/** On the Vercel landing deploy, root goes to /welcome. Main + local CLI skip this. */
export const load: PageServerLoad = () => {
	if (IS_HOSTED_LANDING) {
		redirect(307, '/welcome');
	}
};
