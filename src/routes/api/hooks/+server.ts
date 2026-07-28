import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readHooks, writeHooks, type Hook } from '$lib/server/hooks-config';
import { logInteraction } from '$lib/server/interaction-log';

export const GET: RequestHandler = async () => {
	return json(readHooks());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const hooks: Hook[] = Array.isArray(body?.hooks) ? body.hooks : [];
	logHookChanges(hooks);
	writeHooks({ hooks });
	return json({ ok: true, hooks });
};

/** Interaction log: hooks are written wholesale, so diff by id against the
 * current set and log one hook.change with add/remove/edit counts. Covers
 * both toast-accepted hook proposals and manual hook edits. */
function logHookChanges(next: Hook[]) {
	try {
		const prev = readHooks().hooks;
		const prevById = new Map(prev.map((h) => [h.id, h]));
		const nextById = new Map(next.map((h) => [h.id, h]));
		let added = 0;
		let removed = 0;
		let edited = 0;
		for (const [id, hook] of nextById) {
			const p = prevById.get(id);
			if (!p) added += 1;
			else if (
				p.event !== hook.event ||
				p.matcher !== hook.matcher ||
				p.command !== hook.command ||
				(p.enabled !== false) !== (hook.enabled !== false)
			) {
				edited += 1;
			}
		}
		for (const id of prevById.keys()) {
			if (!nextById.has(id)) removed += 1;
		}
		if (added || removed || edited) {
			logInteraction('hook.change', { added, removed, edited, total: nextById.size });
		}
	} catch (err) {
		console.error('[docwriter] hook-change logging failed:', err);
	}
}
