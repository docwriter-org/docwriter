import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addCustomSkill,
	listSkills,
	removeCustomSkill,
	setSkillEnabled
} from '$lib/server/skills-config';

export const GET: RequestHandler = async () => {
	return json(listSkills());
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		const source = typeof body?.source === 'string' ? body.source : '';
		addCustomSkill(source);
		return json({ ok: true, ...listSkills() });
	} catch (e) {
		return json({ ok: false, error: (e as Error).message }, { status: 400 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		const id = typeof body?.id === 'string' ? body.id : '';
		const enabled = body?.enabled === true;
		if (!id) return json({ ok: false, error: 'id required' }, { status: 400 });
		setSkillEnabled(id, enabled);
		return json({ ok: true, ...listSkills() });
	} catch (e) {
		return json({ ok: false, error: (e as Error).message }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const id = url.searchParams.get('id') || '';
		if (!id) return json({ ok: false, error: 'id required' }, { status: 400 });
		removeCustomSkill(id);
		return json({ ok: true, ...listSkills() });
	} catch (e) {
		return json({ ok: false, error: (e as Error).message }, { status: 400 });
	}
};
