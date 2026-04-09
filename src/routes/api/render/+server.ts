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

function buildPrompt(editedFragId?: string, changes?: string, warmup?: boolean): string {
	const targetFile = RENDER_DOC_FILE;

	if (warmup) {
		return `You are a prose editing agent for atomz, a writing tool. A new editing session is starting.

Read ${targetFile} to understand the current document: its atoms (claims), prose (rendered text), rules, and structure. Also check if there are style reference files in .claude/skills/atomz-style/examples/ — if so, read them to understand the user's writing style.

After reading, briefly acknowledge what the document is about and that you're ready to help edit. Keep it to 1-2 sentences. Do not make any edits yet.`;
	}
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
		return `The user made changes. Here is what happened:

${changes}

Read ${targetFile} and respond appropriately:

1. **If the user edited prose** (rewrote a sentence, added text, etc.): The user's wording is FINAL. Preserve it exactly. Update the corresponding atom's subject/predicate in the "atoms" array to reflect the new meaning.

2. **If the user wrote an instruction** (e.g., "make this more concise", "add a paragraph about X"): Follow the instruction. Apply the change to prose, remove the instruction text, and update atoms to match.

3. **If an atom was edited**: Update the linked prose to reflect the atom's new meaning. Keep changes minimal.

In all cases:
- Keep atoms and prose in sync — if one changes, update the other.
- Do NOT touch entries the user didn't edit.
- Do NOT write a summary. Just make the edits silently.`;
	}

	const task = editedFragId
		? `Atom "${editedFragId}" was just edited. Read ${targetFile}, find the prose entries whose "frags" include "${editedFragId}", and use Edit to update ONLY their "text" values. Don't touch other prose entries.`
		: `Read ${targetFile} and update the prose entries that need changes based on the current atoms. Only edit entries whose text doesn't match their linked atoms. Leave entries that are already good.`;

	return `You are a prose editing agent for atomz, a writing tool.

The file ${targetFile} is JSON with "atoms", "rules", and "prose".

**Atoms** are the meaning layer. Each has a "subject" (topic) and "predicate" (the claim). Each prose entry maps to atoms via "frags" (atom IDs). You can and should edit atoms when prose changes meaning — keep atoms and prose in sync.

**Prose** entries have "text" values. Entries with markdown headings (text starting with #) are section titles — you can edit or add them if needed. Each non-heading entry renders one atom's claim into a sentence.

${task}

## How to Write
- **Preserve the subject**: The atom's subject must remain the topic/grammatical subject of its sentence. Don't shift focus to something else.
- **Be concise**: Write clear, direct sentences. Each sentence should convey its atom's claim naturally — add just enough context for flow and transitions. Do NOT pad with extra clauses, examples, or filler. One atom = roughly one sentence.
- **Minimal changes**: When editing existing prose, change as little as possible. Only modify what's necessary.
- **Keep atoms and prose in sync**: If you edit prose, update the corresponding atom's subject/predicate to match. If you edit an atom, update linked prose to match.
- **Match the style**: If style reference files exist in .claude/skills/atomz-style/examples/, read them and match the user's writing style.
- **Pinned words**: If an atom has "pinnedWords", those exact words MUST appear verbatim in the rendered sentence.
- **Transitions**: If an atom has a "transition" field (e.g., "Yet", "However"), start that atom's sentence with that transition word.
- **Obey all rules** listed in the document.
- Use Edit to replace specific values in the JSON.
- Do NOT write a summary of changes after editing. Just make the edits silently.
- Do NOT make sentences longer than they need to be.`;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { documentJson, editedFragId, model, changes, warmup } = body;
		const canonicalFile = normalizeAtomzFile(documentJson);
		const renderDocument = projectAtomzFileToRenderDocument(canonicalFile);

		// Save pre-edit snapshot to history
		const trigger = changes || (editedFragId ? `Atom edit: ${editedFragId}` : 'Full re-render');
		if (renderDocument.prose.length > 0) {
			saveHistoryEntry(trigger, renderDocument.prose);
		}

		// Write the full render document — agent sees everything including headings and atoms
		const currentSessionId = getSessionId();
		writeJsonAtomic(RENDER_DOC_FILE, renderDocument);

		const prompt = buildPrompt(editedFragId, changes, warmup);
		const hooks = buildValidationHooks(renderDocument);
		const abortController = new AbortController();

		const isPinSync = typeof changes === 'string' && changes.includes('[PIN_');
		const isUserEdit = !!(changes && currentSessionId) || isPinSync;
		const isWarmup = !!warmup;

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
						allowedTools: isWarmup ? ['Read', 'Glob'] : isUserEdit ? ['Read', 'Edit'] : ['Read', 'Edit', 'Skill', 'Agent'],
						settingSources: ['project'],
						maxTurns: isWarmup ? 4 : isUserEdit ? 3 : 8,
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

				// Read the edited file back, merge, persist, then send to client.
				// Server writes document.atomz BEFORE sending the result.
				// If client aborts after this point, document is already saved.
				// The WAL handles replaying any user ops on top — they're idempotent.
				try {
					const content = readFileSync(RENDER_DOC_FILE, 'utf-8');
					const parsed = JSON.parse(content);
					const mergedCanonical = mergeRenderDocumentIntoAtomzFile(canonicalFile, parsed);
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
