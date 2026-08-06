import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { subscribeToStyleAnalysisRun, type StyleRunEvent } from '$lib/server/style-analysis/run-manager';

export const GET: RequestHandler = async ({ params }) => {
	let unsubscribe: (() => void) | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (event: StyleRunEvent) => {
				controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				if (['completed', 'error', 'cancelled'].includes(event.type)
					|| ['completed', 'error', 'cancelled'].includes(event.run.status)) {
					unsubscribe?.();
					controller.close();
				}
			};
			unsubscribe = subscribeToStyleAnalysisRun(params.id, send);
			if (!unsubscribe) controller.error(error(404, 'Style analysis run not found'));
		},
		cancel() {
			unsubscribe?.();
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
