import {
	addUrlReference,
	createStoredSampleReference,
	createUploadedFileReference,
	type StyleReference
} from './references';
import { getProvider } from './providers';
import type { ProviderId, ToolDefinition } from './providers/types';

/**
 * One submission of "context" — free text that may contain links, plus any
 * attached files — split into the reference kinds the materializer already
 * knows how to read. The user classifies nothing: whatever they hand over
 * becomes a source, and the analysis agent decides what to make of it.
 */
const SCHEME_URL = String.raw`https?:\/\/[^\s<>"')\]]+`;

/** `sh-reya.com`, `www.example.com/essays` — people rarely type the scheme. */
const BARE_DOMAIN = String.raw`(?<![\w@./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s<>"')\]]*)?`;

/** Last labels that mean "this is a filename", not "this is a host". */
const FILE_EXTENSIONS = new Set([
	'md', 'markdown', 'txt', 'text', 'pdf', 'tex', 'latex', 'html', 'htm', 'doc', 'docx',
	'rtf', 'odt', 'pages', 'json', 'yml', 'yaml', 'toml', 'csv', 'tsv', 'js', 'ts', 'jsx',
	'tsx', 'py', 'rb', 'go', 'rs', 'css', 'scss', 'png', 'jpg', 'jpeg', 'gif', 'svg',
	'webp', 'zip', 'tar', 'gz', 'mp3', 'mp4', 'mov'
]);

// Fresh instances per call: a shared /g regex carries lastIndex between uses.
const schemeUrl = () => new RegExp(SCHEME_URL, 'gi');
const bareDomain = () => new RegExp(BARE_DOMAIN, 'gi');
/** Same patterns, but eating the whitespace on either side so removing a link
 *  from a sentence doesn't leave a gap. */
const paddedSchemeUrl = () => new RegExp(`[ \\t]*${SCHEME_URL}[ \\t]*`, 'gi');
const paddedBareDomain = () => new RegExp(`[ \\t]*${BARE_DOMAIN}[ \\t]*`, 'gi');

function isFilename(host: string): boolean {
	return FILE_EXTENSIONS.has(host.slice(host.lastIndexOf('.') + 1).toLowerCase());
}

function trimTrailingPunctuation(url: string): string {
	return url.replace(/[.,;:!?]+$/, '');
}

/** Links in the note, normalized to absolute URLs and de-duplicated. */
export function extractUrls(note: string): string[] {
	const found: string[] = [];
	let remaining = note;

	for (const match of note.match(schemeUrl()) ?? []) {
		found.push(trimTrailingPunctuation(match));
		remaining = remaining.replace(match, ' ');
	}

	for (const match of remaining.matchAll(bareDomain())) {
		if (isFilename(match[1])) continue;
		found.push(`https://${trimTrailingPunctuation(match[0])}`);
	}

	return [...new Set(found)];
}

/** The note with every link removed — what is left is writing, if anything. */
export function proseWithoutUrls(note: string): string {
	return note
		.replace(paddedSchemeUrl(), ' ')
		.replace(paddedBareDomain(), (match, host: string) => (isFilename(host) ? match : ' '))
		.trim();
}

export function sampleNameFrom(prose: string): string {
	const firstLine = prose.split(/\r?\n/).find((line) => line.trim()) ?? '';
	const words = firstLine
		.replace(/^#+\s*/, '')
		.trim()
		.split(/\s+/)
		.slice(0, 6)
		.join(' ');
	return words || 'Pasted writing';
}

/**
 * Deterministic split of a note into sources. Used to store whatever the user
 * submitted without waiting on a model, and as the fallback when no provider
 * is reachable.
 */
export function ingestContext(input: {
	note: string;
	files: Array<{ name: string; bytes: Uint8Array }>;
}): StyleReference[] {
	const created: StyleReference[] = [];

	for (const file of input.files) {
		created.push(createUploadedFileReference(file.name, file.bytes));
	}

	const note = input.note ?? '';
	for (const url of extractUrls(note)) {
		created.push(addUrlReference(url, undefined, 'authored'));
	}

	// Anything left over is kept verbatim. Whether a short line is a writing
	// sample or a note about the links is the analysis agent's call, not a
	// gate the user has to satisfy up front.
	const prose = proseWithoutUrls(note);
	if (prose) created.push(createStoredSampleReference(sampleNameFrom(prose), prose));

	if (created.length === 0) throw new Error('Add a file, a link, or some writing.');
	return created;
}

const INGEST_SYSTEM_PROMPT = `You are collecting writing samples so a writing assistant can
learn to sound like this writer. You are given a note they typed and the names of any
files they attached. Attached files are already stored — never re-add them.

Research with WebFetch and WebSearch. When you are done, end your reply with one line per
source, in exactly this format and nothing else on the line:

SOURCE: <absolute url> | <title of the piece>

Those lines are parsed literally, so emit them verbatim — no bullets, no numbering, no
markdown links.

Do not stop at what is literally in the note. Treat it as a starting point and go find
the writer's work:

1. If the note names a site, handle, or person, fetch it and follow it. A personal site
   usually links to a blog, essays, writing, notes, papers, or talks index — go there and
   pull out the individual pieces.
2. Search the web for more of their writing: their name plus "blog", "essay", "writing",
   "substack", "newsletter", or their arXiv or Google Scholar papers. Look for pieces
   they wrote themselves, not pieces written about them.
3. Report each distinct piece you find, using the piece's real title as the label. Prefer
   individual posts and essays over index pages, and include the index too.

Rules:
- Only collect things this person actually wrote. Skip interviews, press coverage,
  coauthored boilerplate, and social profiles with no prose.
- Aim for 8-15 sources when the writer has a body of work; fewer is fine if that is all
  there is.
- Never invent a URL — every link must be one you actually saw.
- Narrate briefly what you are doing as you go. Do not ask questions.`;

export interface IngestAgentEvent {
	type: 'source' | 'status' | 'thinking' | 'tool' | 'error';
	reference?: StyleReference;
	text?: string;
	toolName?: string;
	input?: Record<string, unknown>;
}

/** MCP-qualified names carry the transport prefix; the bare name is the useful part. */
function bareToolName(toolName: string): string {
	return toolName.split('__').pop() ?? toolName;
}

/** The agent's prose, with the machine-readable SOURCE block at the end cut off. */
export function visibleNarration(text: string): string {
	const index = text.search(/\bSOURCE:/i);
	return (index >= 0 ? text.slice(0, index) : text).trim();
}

/**
 * Pull `SOURCE: <url> | <title>` lines out of the agent's reply. Falls back to
 * every URL in the reply if it ignored the format, so a research pass is never
 * wasted just because the agent wrote prose instead of the requested lines.
 */
export function parseReportedSources(reply: string): Array<{ url: string; label?: string }> {
	const found: Array<{ url: string; label?: string }> = [];
	const seen = new Set<string>();

	for (const line of reply.split(/\r?\n/)) {
		const match = /^\s*SOURCE:\s*(\S+)\s*(?:\|\s*(.*))?$/i.exec(line);
		if (!match) continue;
		const raw = match[1].replace(/[.,;:]+$/, '');
		const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		if (seen.has(url)) continue;
		seen.add(url);
		const label = match[2]?.trim().replace(/^[|\-–—\s]+/, '');
		found.push({ url, label: label || undefined });
	}

	if (found.length === 0) {
		for (const url of extractUrls(reply)) {
			if (seen.has(url)) continue;
			seen.add(url);
			found.push({ url });
		}
	}
	return found;
}

/**
 * Hand the submitted note to the provider the user has selected and let it
 * register sources through tools, streaming each one as it lands. Files are
 * stored by the caller first, so the writer sees them immediately.
 */
export async function* runIngestAgent(input: {
	note: string;
	storedFileNames: string[];
	providerId: ProviderId;
	model?: string;
	abortSignal: AbortSignal;
}): AsyncGenerator<IngestAgentEvent> {
	const queue: IngestAgentEvent[] = [];
	const seenUrls = new Set<string>();
	let narration = '';
	let thinking = '';
	let reply = '';

	// No custom tools during the research pass. Enabling WebSearch/WebFetch makes
	// the SDK defer the in-process MCP tools, and they stop resolving mid-run
	// ("No such tool available") — so the agent reports its findings as text and
	// the server, which cannot forget how to save, does the saving.
	const tools: ToolDefinition[] = [];

	const attached = input.storedFileNames.length
		? `\n\nFiles already attached and stored: ${input.storedFileNames.join(', ')}.`
		: '';

	const provider = await getProvider(input.providerId);
	for await (const event of provider.query(
		{
			prompt: `The writer submitted this context:\n\n${input.note}${attached}`,
			systemPrompt: INGEST_SYSTEM_PROMPT,
			model: input.model,
			// The custom tools are added by the provider; these are the built-ins
			// it needs to go looking for the writer's other work.
			allowedTools: ['WebSearch', 'WebFetch'],
			abortSignal: input.abortSignal,
			effort: 'medium',
			isolatedTools: true
		},
		tools
	)) {
		// Providers stream assistant text as deltas ("I", "'ll register…"), so
		// emit the accumulated message rather than each fragment — otherwise the
		// status line flickers through half-words. A tool call ends the message.
		if (event.type === 'assistant_text') {
			narration += event.text;
			reply += event.text;
			// The SOURCE: block is machine-readable payload, not something to
			// show the writer — it is the tail of the reply, so cut there.
			const visible = visibleNarration(narration);
			if (visible) queue.push({ type: 'status', text: visible });
		}
		if (event.type === 'assistant_thinking') {
			thinking += event.text;
			if (thinking.trim()) queue.push({ type: 'thinking', text: thinking.trim() });
		}
		if (event.type === 'tool_call') {
			narration = '';
			thinking = '';
			queue.push({ type: 'tool', toolName: bareToolName(event.tool_name), input: event.input });
		}
		if (event.type === 'error') queue.push({ type: 'error', text: event.error });
		while (queue.length) yield queue.shift()!;
	}

	// Discovered sources arrive unselected: the writer opts a handful in rather
	// than pruning everything the agent turned up.
	for (const found of parseReportedSources(reply)) {
		if (seenUrls.has(found.url)) continue;
		seenUrls.add(found.url);
		try {
			yield {
				type: 'source',
				reference: addUrlReference(found.url, found.label, 'authored', false)
			};
		} catch {
			// A malformed URL must not lose the rest of the batch.
		}
	}
	while (queue.length) yield queue.shift()!;
}
