/**
 * Server-side emitter for the append-only `interaction_events` table.
 *
 * Call `logInteraction(...)` from HTTP choke points to record a user
 * interaction; the `/api/log` endpoint calls it with `source: 'client'`
 * for view-layer events that never otherwise reach the server. Same
 * failure posture as every db-writes helper: a logging error can never
 * take down the request that triggered it.
 *
 * Payload discipline (see interaction-events.ts): IDs, kinds, counts and
 * lengths only — never document text.
 */
import { getDb } from './db';
import { getServerInstanceId } from './runtime-state';
import type {
	InteractionEventName,
	InteractionSource
} from '$lib/shared/interaction-events';

export function logInteraction(
	event: InteractionEventName,
	data: Record<string, unknown> = {},
	opts: {
		tabId?: string | null;
		source?: InteractionSource;
		clientTs?: number | null;
	} = {}
) {
	try {
		getDb()
			.prepare(
				`INSERT INTO interaction_events
				 (boot_id, source, event, tab_id, data, client_ts, created)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				getServerInstanceId(),
				opts.source ?? 'server',
				event,
				opts.tabId ?? null,
				JSON.stringify(data ?? {}),
				opts.clientTs ?? null,
				Date.now()
			);
	} catch (err) {
		console.error(`[docwriter] interaction-log failed (${event}):`, err);
	}
}
