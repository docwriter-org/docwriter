/**
 * /api/live — server-sent event bus for the docwriter CLI's file watcher.
 *
 * GET  /api/live  — clients subscribe; the server streams keepalives + events
 * POST /api/live  — the bin watcher calls this to push events to all clients
 *
 * Events the client acts on:
 *   reload  — re-read workspace files (sent when --watch detects a change)
 */
import type { RequestHandler } from './$types';

const encoder = new TextEncoder();

// Module-level set: all connected SSE response controllers.
// Single-process adapter-node keeps this in memory across requests.
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function push(ctrl: ReadableStreamDefaultController<Uint8Array>, chunk: string) {
	try {
		ctrl.enqueue(encoder.encode(chunk));
	} catch {
		clients.delete(ctrl);
	}
}

// Keepalive comment every 25 seconds so proxies don't close idle connections.
const keepalive = setInterval(() => {
	for (const ctrl of clients) push(ctrl, ': keepalive\n\n');
}, 25_000);
if (typeof keepalive.unref === 'function') keepalive.unref();

export const GET: RequestHandler = () => {
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			ctrl = c;
			clients.add(c);
			push(c, 'event: connected\ndata: {}\n\n');
		},
		cancel() {
			clients.delete(ctrl);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no' // disable nginx buffering
		}
	});
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		/* ignore */
	}
	const event = typeof body.event === 'string' ? body.event : 'reload';
	const data = JSON.stringify(body);
	for (const ctrl of clients) push(ctrl, `event: ${event}\ndata: ${data}\n\n`);
	return new Response('ok');
};
