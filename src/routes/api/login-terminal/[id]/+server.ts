import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	killLoginSession,
	resizeLoginSession,
	subscribeLoginSession,
	writeLoginInput,
	type LoginTerminalEvent
} from '$lib/server/login-terminal';

/** Stream a login terminal's output as SSE: `data` events, then one `exit`. */
export const GET: RequestHandler = async ({ params }) => {
	let unsubscribe: (() => void) | null = null;
	let known = true;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			const send = (event: LoginTerminalEvent) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				);
				if (event.type === 'exit') {
					closed = true;
					unsubscribe?.();
					controller.close();
				}
			};
			unsubscribe = subscribeLoginSession(params.id, send);
			if (!unsubscribe) {
				known = false;
				closed = true;
				controller.close();
			}
		},
		cancel() {
			unsubscribe?.();
		}
	});
	if (!known) return json({ error: 'no such login session' }, { status: 404 });
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};

/** Drive the terminal: { type: 'input', data } | { type: 'resize', cols, rows } | { type: 'kill' }. */
export const POST: RequestHandler = async ({ params, request }) => {
	let body: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const id = params.id;
	switch (body.type) {
		case 'input': {
			if (typeof body.data !== 'string') return json({ error: 'data must be a string' }, { status: 400 });
			return writeLoginInput(id, body.data)
				? json({ ok: true })
				: json({ error: 'login session is not running' }, { status: 409 });
		}
		case 'resize': {
			if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
				return json({ error: 'cols and rows must be numbers' }, { status: 400 });
			}
			return json({ ok: resizeLoginSession(id, body.cols, body.rows) });
		}
		case 'kill':
			return json({ ok: killLoginSession(id) });
		default:
			return json({ error: 'type must be input, resize or kill' }, { status: 400 });
	}
};
