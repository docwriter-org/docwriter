import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { QueueItem } from '$lib/types';
import { appendQueueItems, getUnresolvedQueueItems, resolveQueueItems } from '$lib/server/queue-op-log';

export const GET: RequestHandler = async () => {
	try {
		return json({ items: getUnresolvedQueueItems() });
	} catch (error) {
		return json({ error: String(error), items: [] }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const items = ((body.items || []) as QueueItem[]).filter((item) => item?.id && item?.type && item?.description);
		appendQueueItems(items);
		return json({ ok: true, count: items.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const ids = ((body.ids || []) as string[]).filter((id) => typeof id === 'string' && id.length > 0);
		resolveQueueItems(ids);
		return json({ ok: true, count: ids.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async () => {
	try {
		const ids = getUnresolvedQueueItems().map((item) => item.id);
		resolveQueueItems(ids);
		return json({ ok: true, count: ids.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};
