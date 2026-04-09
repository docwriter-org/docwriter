import type { RequestHandler } from './$types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, readFileSync } from 'fs';
import { DOC_FILE, HISTORY_FILE, RENDER_DOC_FILE } from '$lib/server/document-files';
import { writeJsonAtomic } from '$lib/server/file-utils';
import { getSessionId, setSessionId } from '$lib/server/runtime-state';
import { mergeRenderDocumentIntoAtomzFile, normalizeAtomzFile, projectAtomzFileToRenderDocument } from '$lib/atomz';
const MAX_HISTORY = 30;

interface HistoryEntry {
	timestamp: number;
	trigger: string;
	prose: { text: string; frags: string[]; para: number }[];
}

function loadHistory(): HistoryEntry[] {
	try { return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}

function saveHistoryEntry(trigger: string, prose: any[]) {
	const history = loadHistory();
	history.push({
		timestamp: Date.now(),
		trigger,
		prose: prose.map((p: any) => ({ text: p.text, frags: p.frags, para: p.para }))
	});
	// Keep only the last N entries
	const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
	writeJsonAtomic(HISTORY_FILE, trimmed);
}

// Build validation hooks that check edits against atoms, rules, and pinned words
function buildValidationHooks(documentJson: any): { PostToolUse: Array<{ matcher: string; hooks: HookCallback[] }> } {
	const atoms = documentJson.atoms || [];
	const rules: string[] = documentJson.rules || [];
	const prose = documentJson.prose || [];

	// Flatten all atoms (including children) into a map
	const atomMap = new Map<string, { subject: string; predicate: string; pinnedWords?: string[] }>();
	function walk(list: any[]) {
		for (const a of list) {
			atomMap.set(a.id, { subject: a.subject, predicate: a.predicate, pinnedWords: a.pinnedWords });
			if (a.children) walk(a.children);
		}
	}
	walk(atoms);

	const validateEdit: HookCallback = async (input, _toolUseId, _options) => {
		const hookInput = input as any;
		const toolInput = hookInput.tool_input as any;
		const newString = toolInput?.new_string as string;
		if (!newString || toolInput?.file_path !== RENDER_DOC_FILE) return {} as any;

		const violations: string[] = [];

		// Try to figure out which prose entry this edit targets
		for (const p of prose) {
			if (newString.includes(p.text) || (toolInput.old_string && toolInput.old_string.includes(p.text))) continue;
			// Check if this is the entry being edited (new_string replaces old_string in the JSON)
		}

		// Check pinned words: find if any "text" value in new_string violates pinned words
		// Extract the text value from the JSON edit
		const textMatch = newString.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (textMatch) {
			const newText = textMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');

			// Find which prose entry this corresponds to by checking old_string
			const oldString = (toolInput.old_string || '') as string;
			const oldTextMatch = oldString.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);

			if (oldTextMatch) {
				const oldText = oldTextMatch[1].replace(/\\"/g, '"');
				const proseEntry = prose.find((p: any) => p.text === oldText);

				if (proseEntry) {
					// Check pinned words for each linked atom
					for (const fragId of proseEntry.frags) {
						const atom = atomMap.get(fragId);
						if (atom?.pinnedWords) {
							for (const word of atom.pinnedWords) {
								if (!newText.includes(word)) {
									violations.push(`Pinned word "${word}" from atom ${fragId} is missing in: "${newText.slice(0, 50)}..."`);
								}
							}
						}
					}

					// Check rules
					for (const rule of rules) {
						const lower = rule.toLowerCase();
						if (lower.includes('no em dash') && newText.includes('—')) {
							violations.push(`Rule violation: "${rule}" — found em dash in: "${newText.slice(0, 50)}..."`);
						}
						// Check for banned words
						const noWordMatch = lower.match(/no (?:word |use of )?"?(\w+)"?/);
						if (noWordMatch && newText.toLowerCase().includes(noWordMatch[1])) {
							violations.push(`Rule violation: "${rule}" — found "${noWordMatch[1]}" in: "${newText.slice(0, 50)}..."`);
						}
					}
				}
			}
		}

		if (violations.length > 0) {
			return {
				additionalContext: `VALIDATION ERRORS in your edit:\n${violations.map(v => '- ' + v).join('\n')}\n\nPlease fix these issues by making another Edit.`
			} as any;
		}

		return {} as any;
	};

	return {
		PostToolUse: [{ matcher: 'Edit', hooks: [validateEdit] }]
	};
}

function buildPrompt(editedFragId?: string, changes?: string): string {
	const targetFile = RENDER_DOC_FILE;
	if (changes?.includes('[PIN_ACK]')) {
		return `Pin synchronization request:

${changes}

Read ${targetFile} to verify context, then acknowledge completion.
Do NOT edit atoms, prose, rules, or structure for this request.`;
	}

	if (changes?.includes('[PIN_FIX_PROSE]')) {
		return `Pinned-word synchronization request:

${changes}

Read ${targetFile} and apply the minimum required prose edits.
- Edit only prose entries linked to the referenced atom.
- Ensure the pinned text appears verbatim.
- Preserve existing wording as much as possible.
- Do NOT modify unrelated prose, atoms, rules, or headings.`;
	}

	if (changes?.includes('[PIN_FIX_SYNC]')) {
		return `Pinned-word synchronization request:

${changes}

Read ${targetFile} and resolve the mismatch with minimal changes.
- Keep the user's pinned prose text exactly as written.
- Prefer the smallest atom subject/predicate update when possible.
- If atom edits would distort meaning, minimally edit only linked prose instead.
- Do NOT touch unrelated atoms, prose, rules, or headings.`;
	}

	// If we have a specific changes description from the queue, use it as a short delta
	if (changes && getSessionId()) {
		return `The user edited the prose directly. Here is what changed:

${changes}

Read ${targetFile} and respond appropriately:

1. **If the edit is prose** (the user rewrote a sentence, added text, etc.): The user's wording is FINAL. Preserve it exactly in the prose. Update the corresponding atom's subject/predicate to reflect the new meaning. Do NOT rewrite the user's text.

2. **If the edit is an instruction** (e.g., "make this more concise", "add a paragraph about X", "rewrite this"): Follow the instruction. Apply the requested change to the prose, then remove the instruction text. Update atoms if meaning changed.

In both cases:
- Do NOT touch prose entries the user didn't edit.
- Do NOT write a summary. Just make the edits silently.`;
	}

	const task = editedFragId
		? `Atom "${editedFragId}" was just edited. Read ${targetFile}, find the prose entries whose "frags" include "${editedFragId}", and use Edit to update ONLY their "text" values. Don't touch other prose entries.`
		: `Read ${targetFile} and update the prose entries that need changes based on the current atoms. Only edit entries whose text doesn't match their linked atoms. Leave entries that are already good.`;

	return `You are a prose editing agent for atomz, a writing tool.

The file ${targetFile} is JSON with "atoms", "rules", and "prose". Each atom has a "subject" (the topic — preserve it as the grammatical subject or main topic of the sentence) and a "predicate" (the core claim to convey). Each prose entry maps to atoms via "frags".

Prose "text" values can contain markdown (e.g., "# Heading", "**bold**", "- list item"). Entries with frags: [] and markdown headings are structural — preserve them exactly. Only edit text in entries linked to atoms.

${task}

## How to Write
- **Preserve the subject**: The atom's subject must remain the topic/grammatical subject of its sentence. Don't shift focus to something else.
- **Be concise**: Write clear, direct sentences. Each sentence should convey its atom's claim naturally — add just enough context for flow and transitions. Do NOT pad sentences with extra clauses, examples, or filler. One atom = roughly one sentence.
- **Minimal changes**: When editing existing prose, change as little as possible. Preserve the user's existing wording and sentence structure. Only modify what's necessary to reflect the atom change.
- **Match the style**: If style reference files exist in .claude/skills/atomz-style/examples/, read them and match the user's writing style (tone, sentence length, vocabulary).
- **Pinned words**: If an atom has "pinnedWords", those exact words MUST appear verbatim in the rendered sentence.
- **Transitions**: If an atom has a "transition" field (e.g., "Yet", "However"), start that atom's sentence with that transition word. If you use a transition word in a sentence, set the "transition" field on that atom to match.
- **Obey all rules** listed in the document.
- Use Edit to replace specific values in the JSON.
- Do NOT write a summary of changes after editing. Just make the edits silently.
- Do NOT make sentences longer than they need to be. Do NOT add qualifiers, hedges, or elaboration beyond what the atom states.`;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { documentJson, editedFragId, model, changes } = body;
		const canonicalFile = normalizeAtomzFile(documentJson);
		const renderDocument = projectAtomzFileToRenderDocument(canonicalFile);

		// Save pre-edit snapshot to history
		const trigger = changes || (editedFragId ? `Atom edit: ${editedFragId}` : 'Full re-render');
		if (renderDocument.prose.length > 0) {
			saveHistoryEntry(trigger, renderDocument.prose);
		}

		// Separate headings from prose — agent must not touch headings
		const allProse: any[] = renderDocument.prose || [];
		const headingEntries: { index: number; entry: any }[] = [];
		const agentProse: any[] = [];
		for (let i = 0; i < allProse.length; i++) {
			if (typeof allProse[i].text === 'string' && allProse[i].text.match(/^#{1,3}\s/)) {
				headingEntries.push({ index: i, entry: allProse[i] });
			} else {
				agentProse.push(allProse[i]);
			}
		}

		// Write doc with headings stripped — agent only sees prose entries
		const currentSessionId = getSessionId();
		const docForAgent = {
			...renderDocument,
			prose: agentProse
		};
		writeJsonAtomic(RENDER_DOC_FILE, docForAgent);

		const prompt = buildPrompt(editedFragId, changes);
		const hooks = buildValidationHooks(renderDocument);
		const abortController = new AbortController();

		const isPinSync = typeof changes === 'string' && changes.includes('[PIN_');
		const isUserEdit = !!(changes && currentSessionId) || isPinSync;

		// Allow client to abort via request signal
		request.signal.addEventListener('abort', () => abortController.abort());

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();

				const renderStart = Date.now();

				function send(event: string, data: unknown) {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data as object, _elapsed: Date.now() - renderStart })}\n\n`)
					);
				}

				let currentToolName = '';
				let currentToolId = '';
				let toolInputAccum = '';
				let lastStreamedText = '';

				function extractNewString(json: string): string | null {
					const match = json.match(/"new_string"\s*:\s*"((?:[^"\\]|\\.)*)("?)/);
					if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
					return null;
				}

				try {
					const queryOptions: any = {
						allowedTools: isUserEdit ? ['Read', 'Edit'] : ['Read', 'Edit', 'Skill', 'Agent'],
						settingSources: ['project'],
						maxTurns: isUserEdit ? 3 : 8,
						permissionMode: 'acceptEdits',
						includePartialMessages: true,
						abortController,
						enableFileCheckpointing: true,
						extraArgs: { 'replay-user-messages': null },
						hooks,
						...(model ? { model } : {}),
						...(currentSessionId ? { resume: currentSessionId } : {})
					};

					// Give the agent a paragraph-editor subagent it can choose to use
					if (!isUserEdit) {
						const rulesList = (renderDocument.rules || []).map((r: string) => `- ${r}`).join('\n');
						const pinnedWordsInfo = (renderDocument.atoms || [])
							.flatMap((a: any) => {
								const words = [...(a.pinnedWords || []), ...((a.children || []).flatMap((c: any) => c.pinnedWords || []))];
								return words.length ? [`Atom "${a.id}": ${words.join(', ')}`] : [];
							}).join('\n');

						queryOptions.agents = {
							'paragraph-editor': {
								description: 'Edits specific prose entries in the document. Use when you need to edit multiple paragraphs in parallel.',
								prompt: `You edit prose entries in ${RENDER_DOC_FILE} (a JSON file). Read the file, then use Edit to replace specific "text" values. Be concise. Do not write summaries.

## Rules (MUST obey):
${rulesList || 'None'}

## Pinned words (MUST appear verbatim in their sentence):
${pinnedWordsInfo || 'None'}

## Style:
- Keep sentences concise — one atom ≈ one sentence
- Preserve each atom's subject as the grammatical subject
- Do NOT pad with extra clauses or filler`,
								tools: ['Read', 'Edit'],
								model: 'sonnet'
							}
						};
					}

					for await (const message of query({
						prompt,
						options: queryOptions
					})) {
						if (message.type === 'system' && message.session_id) {
							setSessionId(message.session_id);
							send('session', { sessionId: message.session_id });
						}

						if (message.type === 'user' && (message as any).uuid) {
							send('checkpoint', {
								id: (message as any).uuid,
								sessionId: getSessionId(),
								timestamp: Date.now()
							});
						}

						if (message.type === 'stream_event') {
							const event = message.event;

							if (event.type === 'content_block_start') {
								if (event.content_block.type === 'tool_use') {
									currentToolName = event.content_block.name;
									currentToolId = event.content_block.id;
									toolInputAccum = '';
									lastStreamedText = '';
									send('tool_call_start', {
										tool_name: currentToolName,
										tool_use_id: currentToolId
									});
								}
							} else if (event.type === 'content_block_delta') {
								if (event.delta.type === 'text_delta') {
									send('assistant_text', { text: event.delta.text });
								} else if (event.delta.type === 'input_json_delta') {
									toolInputAccum += event.delta.partial_json;

									if (currentToolName === 'Edit') {
										const partial = extractNewString(toolInputAccum);
										if (partial && partial !== lastStreamedText) {
											send('text_streaming', {
												new_text: partial,
												old_text: ''
											});
											lastStreamedText = partial;
										}
									}
								}
							} else if (event.type === 'content_block_stop') {
								if (currentToolName) {
									let parsedInput = {};
									try { parsedInput = JSON.parse(toolInputAccum); } catch {}
									send('tool_call', {
										tool_name: currentToolName,
										tool_use_id: currentToolId,
										input: parsedInput
									});
									currentToolName = '';
									currentToolId = '';
									toolInputAccum = '';
									lastStreamedText = '';
								}
							}
						}
					}
				} catch (err) {
					send('error', { error: String(err) });
				}

				// Read the edited file back and re-insert headings
				try {
					const content = readFileSync(RENDER_DOC_FILE, 'utf-8');
					const parsed = JSON.parse(content);
					// Re-insert heading entries at their original positions
					const mergedProse = [...(parsed.prose || [])];
					for (const h of headingEntries) {
						const insertAt = Math.min(h.index, mergedProse.length);
						mergedProse.splice(insertAt, 0, h.entry);
					}
					// Re-number IDs
					mergedProse.forEach((p: any, i: number) => { p.id = i; });
					parsed.prose = mergedProse;
					const mergedCanonical = mergeRenderDocumentIntoAtomzFile(canonicalFile, parsed);
					// Commit the full merged result atomically to the canonical snapshot.
					writeJsonAtomic(DOC_FILE, mergedCanonical);
					send('result', { document: mergedCanonical });
				} catch (err) {
					send('error', { error: 'Failed to read document: ' + String(err) });
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
	} catch (error) {
		console.error('Render error:', error);
		return new Response(
			JSON.stringify({ error: 'Failed to render', detail: String(error) }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};
