import type { RequestHandler } from './$types';
import { getStyleRun, subscribeStyleRun } from '$lib/server/style/pipeline';

export const GET: RequestHandler = async ({ params }) => {
	const runId = params.id;
	const run = getStyleRun(runId);
	if (!run) {
		return new Response('Run not found', { status: 404 });
	}

	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (event: unknown) => {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			const unsub = subscribeStyleRun(runId, (e) => {
				send(e);
				const cancelled =
					e.type === 'status' && (e as { phase?: string }).phase === 'cancelled';
				if (e.type === 'done' || e.type === 'error' || cancelled) {
					unsub();
					try {
						controller.close();
					} catch {
						/* ignore */
					}
				}
			});
			// If already finished before subscribe replay completed
			if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
				unsub();
				try {
					controller.close();
				} catch {
					/* ignore */
				}
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
