import type { RequestHandler } from './$types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

const DOC_FILE = join(process.cwd(), 'document.atomz');

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { text, model } = await request.json();

		const prompt = `You are an atomizer. Decompose the following text into atoms and write the result as JSON to ${DOC_FILE}.

Text to decompose:
${text}

For each sentence or key claim, create an atom with:
- id: short unique ID (f1, f2, f2a — children get parent prefix)
- subject: MINIMAL — drop articles, just the core noun. e.g., "LLMs" not "Large language models"
- label: MINIMAL predicate — compressed claim. e.g., "changed HCI" not "have fundamentally changed human-computer interaction"
- children: sub-claims that elaborate

Write a JSON file to ${DOC_FILE} with this format:
{"atoms":[{"id":"f1","subject":"...","predicate":"...","children":[]}],"rules":[],"paraBreaks":[1,3],"prose":[{"id":0,"frags":["f1"],"para":0,"text":"Original sentence."}]}

paraBreaks is an array of atom indices where paragraph breaks occur. Map every original sentence to its atoms via the frags array.`;

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				function send(event: string, data: unknown) {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				}

				let toolName = '';
				let toolInput = '';

				try {
					for await (const message of query({
						prompt,
						options: {
							allowedTools: ['Write'],
							maxTurns: 5,
							permissionMode: 'acceptEdits',
							includePartialMessages: true,
							...(model ? { model } : {})
						}
					})) {
						if (message.type === 'stream_event') {
							const ev = message.event;
							if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
								toolName = ev.content_block.name;
								toolInput = '';
								send('tool_call_start', { tool_name: toolName });
							} else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
								send('assistant_text', { text: ev.delta.text });
							} else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
								toolInput += ev.delta.partial_json;
							} else if (ev.type === 'content_block_stop' && toolName) {
								let parsed = {};
								try { parsed = JSON.parse(toolInput); } catch {}
								send('tool_call', { tool_name: toolName, input: parsed });
								toolName = '';
							}
						}
					}
				} catch (err) {
					send('error', { error: String(err) });
				}

				// Read the written file
				try {
					const content = readFileSync(DOC_FILE, 'utf-8');
					const parsed = JSON.parse(content);
					send('result', parsed);
				} catch (err) {
					send('error', { error: 'Failed to read output: ' + String(err) });
				}

				send('done', {});
				controller.close();
			}
		});

		return new Response(stream, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
	}
};
