/**
 * Manual hook trigger. POST { id, file? } runs the configured hook command
 * outside any agent turn — wired to the "Run" button on each row in
 * HooksPanel. The same `runHookCommand` helper that the render server uses
 * for auto-fired hooks runs here, so the captured stdout/stderr/exit-code
 * shape matches and the client can replay it into the agent history with
 * the same UI as auto runs.
 *
 * Returns the final hook_run entry (status `done` or `failed`) — the
 * client renders that into agent history. We don't stream intermediate
 * `running` events here because manual runs are typically short and the
 * SSE plumbing isn't worth the cost for a one-shot button click.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readHooks } from '$lib/server/hooks-config';
import { runHookCommand } from '$lib/server/hook-runner';

interface FinalEntry {
	hookId: string;
	event: string;
	command: string;
	status: 'done' | 'failed';
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const id = typeof body?.id === 'string' ? body.id : '';
	const file = typeof body?.file === 'string' && body.file ? body.file : undefined;
	if (!id) throw error(400, 'id is required');

	const hook = readHooks().hooks.find((h) => h.id === id);
	if (!hook) throw error(404, 'Hook not found');

	let final: FinalEntry | null = null;
	await runHookCommand(hook, '', file, (entry) => {
		// Only capture the terminal entry; the client doesn't need the
		// `running` ack for a one-shot manual fire.
		if (entry.status === 'done' || entry.status === 'failed') {
			final = entry as FinalEntry;
		}
	});

	if (!final) {
		throw error(500, 'Hook did not emit a terminal status');
	}
	return json({ ok: true, entry: final });
};
