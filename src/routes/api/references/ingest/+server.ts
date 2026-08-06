import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	extractUrls,
	proseWithoutUrls,
	runIngestAgent,
	sampleNameFrom
} from '$lib/server/references-ingest';
import { addUrlReference, createStoredSampleReference, createUploadedFileReference } from '$lib/server/references';
import type { ProviderId } from '$lib/server/providers/types';

/** Writing samples, not archives — generous enough for a long PDF. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const PROVIDERS: ProviderId[] = ['claude', 'openai', 'codex', 'cursor', 'pi'];

function parseProvider(value: unknown): ProviderId {
	return typeof value === 'string' && (PROVIDERS as string[]).includes(value)
		? (value as ProviderId)
		: 'claude';
}

/**
 * Streams the ingestion of one "context" submission. Attached files are stored
 * immediately so they appear at once; the note itself is handed to the agent
 * for the selected provider, which registers links and passages through tools.
 * Every source is streamed the moment it exists.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData();
	const note = typeof form.get('note') === 'string' ? (form.get('note') as string) : '';
	const providerId = parseProvider(form.get('provider'));
	const model = typeof form.get('model') === 'string' ? (form.get('model') as string) : undefined;

	const files: Array<{ name: string; bytes: Uint8Array }> = [];
	for (const entry of form.getAll('files')) {
		if (!(entry instanceof File) || entry.size === 0) continue;
		if (entry.size > MAX_UPLOAD_BYTES) throw error(413, `${entry.name} is larger than 25 MB`);
		files.push({ name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) });
	}

	if (!note.trim() && files.length === 0) throw error(400, 'Add a file, a link, or some writing.');

	const abortController = new AbortController();
	request.signal.addEventListener('abort', () => abortController.abort());

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			const storedFileNames: string[] = [];
			try {
				for (const file of files) {
					const reference = createUploadedFileReference(file.name, file.bytes);
					storedFileNames.push(file.name);
					send('source', { reference });
				}
			} catch (cause) {
				send('error', { message: cause instanceof Error ? cause.message : String(cause) });
			}

			if (note.trim()) {
				let registered = 0;
				let agentFailed = false;
				try {
					for await (const event of runIngestAgent({
						note,
						storedFileNames,
						providerId,
						model,
						abortSignal: abortController.signal
					})) {
						if (event.type === 'source' && event.reference) {
							registered += 1;
							send('source', { reference: event.reference });
						} else if (event.type === 'status' && event.text) {
							send('status', { text: event.text });
						} else if (event.type === 'thinking' && event.text) {
							send('thinking', { text: event.text });
						} else if (event.type === 'tool' && event.toolName) {
							send('tool', { tool_name: event.toolName, input: event.input ?? {} });
						} else if (event.type === 'error') {
							agentFailed = true;
						}
					}
				} catch {
					agentFailed = true;
				}

				// The agent is an interpreter, not a gatekeeper: if it errored or
				// registered nothing, fall back to the deterministic split so the
				// writer never loses what they submitted.
				if ((agentFailed || registered === 0) && !abortController.signal.aborted) {
					try {
						for (const url of extractUrls(note)) {
							send('source', { reference: addUrlReference(url, undefined, 'authored') });
						}
						const prose = proseWithoutUrls(note);
						if (prose) {
							send('source', {
								reference: createStoredSampleReference(sampleNameFrom(prose), prose)
							});
						}
					} catch (cause) {
						send('error', { message: cause instanceof Error ? cause.message : String(cause) });
					}
				}
			}

			send('done', {});
			controller.close();
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
