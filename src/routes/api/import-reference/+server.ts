import type { RequestHandler } from './$types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(process.cwd(), '.claude/skills/atomz-style/examples');

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { text, name, tag, model } = await request.json();

		mkdirSync(SKILL_DIR, { recursive: true });

		const baseName = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '-');
		const outputFile = join(SKILL_DIR, `${baseName}-${Date.now()}.atomz`);
		const isUrl = text.startsWith('Fetch and analyze');

		let prompt: string;
		if (isUrl) {
			prompt = `${text}\n\nFetch the content using WebFetch. Then pass the fetched text directly to the atomizer agent to decompose into ${outputFile} with tag="${tag || 'inspo'}" and source="${name}".`;
		} else {
			prompt = `Use the atomizer agent to decompose the following text into ${outputFile} with tag="${tag || 'inspo'}" and source="${name}".\n\nText to decompose:\n${text}`;
		}

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
							allowedTools: ['Read', 'Write', 'WebFetch', 'Agent'],
							agents: {
								atomizer: {
									description: 'Takes text from a file and decomposes it into atoms. Writes a .atomz JSON file.',
									prompt: `Decompose text into atoms. Write a .atomz JSON file using Write.

Format: {"version":2,"tag":"...","source":"...","atoms":[{"id":"f1","subject":"...","predicate":"...","children":[]}],"rules":[{"id":"r1","text":"..."}],"blocks":[{"id":"b1","type":"markdown","markdown":"Original sentence.","atomIds":["f1"]}],"pins":[]}

IMPORTANT: Subjects and predicates must be MINIMAL — drop articles, drop filler words. Examples:
- Good: subject="LLMs" predicate="changed HCI"
- Bad: subject="Large language models" predicate="have fundamentally changed human-computer interaction"
- Good: subject="conversation" predicate="wrong paradigm for writing"
- Bad: subject="The conversational interface" predicate="is often the wrong interaction paradigm for AI-assisted writing"

Keep them as compressed as possible. Group related atoms as children. Map sentences to atoms. Use Write to save.`,
									tools: ['Read', 'Write'],
									model: 'sonnet'
								}
							},
							maxTurns: 15,
							permissionMode: 'acceptEdits',
							hooks: {
								PreToolUse: [{
									matcher: 'Write',
									hooks: [async (input) => {
										const toolInput = (input as any).tool_input;
										const filePath: string = toolInput?.file_path || '';
										const allowed = filePath.startsWith(SKILL_DIR);
										if (!allowed) {
											return { decision: 'block', reason: `Write blocked: ${filePath} is outside allowed directories` } as any;
										}
										return { decision: 'approve' } as any;
									}]
								}]
							},
							includePartialMessages: true,
							...(model ? { model } : {})
						}
					})) {
						const isSubagent = !!(message as any).parent_tool_use_id;

						if (message.type === 'stream_event') {
							const ev = message.event;
							if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
								toolName = ev.content_block.name;
								toolInput = '';
								send('tool_call_start', { tool_name: toolName, subagent: isSubagent });
							} else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
								send('assistant_text', { text: ev.delta.text, subagent: isSubagent });
							} else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
								toolInput += ev.delta.partial_json;
							} else if (ev.type === 'content_block_stop' && toolName) {
								let parsed = {};
								try { parsed = JSON.parse(toolInput); } catch {}
								send('tool_call', { tool_name: toolName, input: parsed, subagent: isSubagent });
								toolName = '';
							}
						}
					}
				} catch (err) {
					send('error', { error: String(err) });
				}

				send('result', { saved: true, path: outputFile });
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
