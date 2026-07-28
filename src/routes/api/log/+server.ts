import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logInteraction } from '$lib/server/interaction-log';
import { isValidTabId } from '$lib/server/document-files';
import {
	INTERACTION_EVENT_NAME_RE,
	MAX_LOG_BATCH_EVENTS,
	MAX_LOG_EVENT_DATA_CHARS,
	type ClientLogBatch,
	type InteractionEventName
} from '$lib/shared/interaction-events';

/**
 * POST /api/log — ingest for the client interaction batcher
 * (`$lib/interaction-log-client`). Accepts `ClientLogBatch`; inserts each
 * valid event with `source: 'client'` and a server-stamped `created`
 * (the canonical clock), preserving the client's `clientTs`. Permissive
 * by design: malformed events are skipped, unknown-but-well-formed names
 * are stored (forward compatibility), and the response is always 200 for
 * a parseable body — logging must never surface errors into the UI.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: Partial<ClientLogBatch>;
	try {
		body = (await request.json()) as Partial<ClientLogBatch>;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const windowId =
		typeof body?.windowId === 'string' ? body.windowId.slice(0, 16) : '';
	const events = Array.isArray(body?.events)
		? body.events.slice(0, MAX_LOG_BATCH_EVENTS)
		: [];

	let inserted = 0;
	for (const e of events) {
		if (
			!e ||
			typeof e.event !== 'string' ||
			e.event.length > 64 ||
			!INTERACTION_EVENT_NAME_RE.test(e.event)
		) {
			continue;
		}
		let data: Record<string, unknown> =
			e.data && typeof e.data === 'object' && !Array.isArray(e.data)
				? { ...e.data }
				: {};
		try {
			if (JSON.stringify(data).length > MAX_LOG_EVENT_DATA_CHARS) {
				data = { truncated: true };
			}
		} catch {
			data = { unserializable: true };
		}
		if (windowId) data.windowId = windowId;
		logInteraction(e.event as InteractionEventName, data, {
			source: 'client',
			tabId: typeof e.tabId === 'string' && isValidTabId(e.tabId) ? e.tabId : null,
			clientTs:
				typeof e.clientTs === 'number' && Number.isFinite(e.clientTs)
					? Math.round(e.clientTs)
					: null
		});
		inserted += 1;
	}
	return json({ ok: true, inserted });
};
