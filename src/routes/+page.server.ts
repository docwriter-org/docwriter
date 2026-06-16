import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** On the landing branch Vercel deploy, root goes to /welcome. Main + local CLI skip this. */
export const load: PageServerLoad = () => {
	if (process.env.LANDING_DEPLOY === '1') {
		redirect(307, '/welcome');
	}
};
