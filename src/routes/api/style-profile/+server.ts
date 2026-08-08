import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { styleProfileSummary } from '$lib/server/style-analysis/profile-store';

export const GET: RequestHandler = async () => json(styleProfileSummary());
