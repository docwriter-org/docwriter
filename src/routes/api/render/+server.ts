import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { normalize, resolve } from 'path';
import * as Y from 'yjs';
import { getProvider } from '$lib/server/providers';
import type { ProviderId, ProviderEvent } from '$lib/server/providers/types';
import { buildToolDefinitions, TOOL_NAMES } from '$lib/server/providers/tool-handlers';
import {
	AGENT_SCRATCH_DIR,
	isValidTabId,
	isBinaryTabPath,
	tabFile
} from '$lib/server/document-files';
import {
	readHooks,
	HOOK_EVENTS,
	type Hook,
	type HookEvent
} from '$lib/server/hooks-config';
import { runHookCommand, type HookRunEmitter } from '$lib/server/hook-runner';
import { getSessionId, setSessionId, setLastSystemPrompt, getTabsState } from '$lib/server/runtime-state';
import { readMeta } from '$lib/server/document-io';
import { kvGet, kvSet, dbAppendConversationEvent } from '$lib/server/db-writes';
import { readCommentThreads, readReviewRounds } from '$lib/shared/ydoc-codec';
import type { CommentThread } from '$lib/types';
import { formatDismissedThreadsHint } from '$lib/shared/list-threads';
import { replayUpdatesInto } from '$lib/server/ydoc-persistence';
import { registerPendingAskUser } from '$lib/server/ask-user-state';
import { unifiedLineDiff } from '$lib/diff';
import { listStyleReferences } from '$lib/server/references';
import { readStyleProfile } from '$lib/server/style-analysis/profile-store';
import { publishedStylePropositions, type StyleProfile } from '$lib/style-profile';
import { buildSkillsPromptBlock } from '$lib/server/skills-config';
import { readLastSeen, writeLastSeen, readTabMarkdownForAgent } from '$lib/server/last-seen';
import {
	EDIT_DOC_TOOL_NAME,
	READ_DOC_TOOL_NAME,
	WRITE_DOC_TOOL_NAME,
	COMMENT_DOC_TOOL_NAME,
	REPLY_TO_COMMENT_TOOL_NAME,
	runWithRenderScope,
	REPLY_BEFORE_EDIT_PROMPT_NOTE
} from '$lib/server/mcp-doc-tools';
import type { StaleAcceptApply } from '$lib/shared/stale-accept';
import { getReviewerById, buildCritiqueMessage } from '$lib/server/reviewers';
import type { Reviewer } from '$lib/shared/reviewers';

/** Read the live authoritative markdown for a tab, including any pending
 * review rounds materialized on top. Prefers the Hocuspocus in-memory
 * Document (what clients are synced to); falls back to a throwaway Y.Doc
 * hydrated from SQLite when no client is connected. */
function readLiveTabMarkdown(tabId: string): string {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { documents?: { get(name: string): unknown } };
		};
	};
	const hp = holder.__docwriterWsServer?.hocuspocus;
	const liveDoc = hp?.documents?.get(tabId) as Y.Doc | undefined;
	if (liveDoc) {
		return readTabMarkdownForAgent(liveDoc);
	}
	const ydoc = new Y.Doc();
	try {
		replayUpdatesInto(ydoc, tabId);
		return readTabMarkdownForAgent(ydoc);
	} finally {
		ydoc.destroy();
	}
}

/** Open tabs the agent can read and edit as documents. Binary tabs (PDFs,
 * images) are preview-only: materializing a Y.Doc for one used to seed the
 * file's bytes into the CRDT log as UTF-8 mojibake — hundreds of KB per
 * "document" — and their rebuilt-on-every-compile "diffs" then blew the
 * prompt past the model's context limit. They are listed to the agent as
 * preview tabs but never loaded, diffed, or baselined. */
function splitTabsByKind(allTabIds: string[]): { textTabs: string[]; previewTabs: string[] } {
	const textTabs: string[] = [];
	const previewTabs: string[] = [];
	for (const id of allTabIds) {
		(isBinaryTabPath(id) ? previewTabs : textTabs).push(id);
	}
	return { textTabs, previewTabs };
}

function buildTabPromptInfos(textTabIds: string[]): TabPromptInfo[] {
	return textTabIds.map((id) => ({
		tabId: id,
		currentMd: readLiveTabMarkdown(id),
		lastSeenMd: readLastSeen(id),
		commentThreads: readLiveTabCommentThreads(id),
		pendingEditThreadIds: [...readLiveTabPendingEditThreadIds(id)]
	}));
}

/** Above this many characters, a tab's prompt diff is summarized instead of
 * inlined. An uncapped diff of a large external change (a whole-file `git
 * pull`, a regenerated bibliography) can exceed the model's context limit
 * outright — "Prompt is too long" — and compaction can't help because the
 * payload is the fresh turn, not history. */
const PROMPT_DIFF_CAP_CHARS = 8_000;

/** Snapshot of a tab's comment threads. Prefer the Hocuspocus in-memory
 * Document; fall back to a throwaway doc hydrated from SQLite. */
function readLiveTabCommentThreads(tabId: string): CommentThread[] {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { documents?: { get(name: string): unknown } };
		};
	};
	const hp = holder.__docwriterWsServer?.hocuspocus;
	const liveDoc = hp?.documents?.get(tabId) as Y.Doc | undefined;
	if (liveDoc) return readCommentThreads(liveDoc);
	const ydoc = new Y.Doc();
	try {
		replayUpdatesInto(ydoc, tabId);
		return readCommentThreads(ydoc);
	} finally {
		ydoc.destroy();
	}
}

/** Which comment threads on a tab currently carry a pending edit (a review
 * round tagged with that thread's id). Lets the prompt flag those threads so
 * the agent knows a reply there is feedback on an edit it should *revise*,
 * not a discussion to chat back on. */
function readLiveTabPendingEditThreadIds(tabId: string): Set<string> {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { documents?: { get(name: string): unknown } };
		};
	};
	const hp = holder.__docwriterWsServer?.hocuspocus;
	const liveDoc = hp?.documents?.get(tabId) as Y.Doc | undefined;
	const collect = (doc: Y.Doc) =>
		new Set(
			readReviewRounds(doc)
				.map((r) => r.feedbackThreadId)
				.filter((id): id is string => typeof id === 'string')
		);
	if (liveDoc) return collect(liveDoc);
	const ydoc = new Y.Doc();
	try {
		replayUpdatesInto(ydoc, tabId);
		return collect(ydoc);
	} finally {
		ydoc.destroy();
	}
}

const GENERIC_WAKEUP_MESSAGE =
	'I clicked Wake-up without a specific request. Decide what, if anything, to do per the Autonomy section of your instructions.';
const WORKSPACE_ROOT = resolve(process.env.DOCWRITER_ROOT || process.cwd());

interface ImageAttachmentPayload {
	mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
	data: string;
}

// Keys for the rule / refs / agency snapshots used to diff per-turn updates.
// Storing JSON strings under these kv keys lets us emit only what CHANGED
// since the last render, keeping the recurring prompt lean.
const KV_LAST_RULES = 'last_render:rules';
const KV_LAST_REFS = 'last_render:refs';
const KV_LAST_AGENCY = 'last_render:agency';
const KV_LAST_AUDIENCE = 'last_render:audience';

function normalizeToolPath(pathLike: string): string {
	return normalize(resolve(WORKSPACE_ROOT, pathLike));
}

/** Recognized inline-directive delimiters. The user can wrap notes for
 * the agent in any of these; the regex returns the inner text. Adding a
 * new style is cheap — extend this list and the prompt mention. */
const DIRECTIVE_RE = /(?:\[\[([\s\S]*?)\]\]|\(\(([\s\S]*?)\)\)|<<([\s\S]*?)>>)/g;

function extractInlineDirectives(text: string, limit = 8): string[] {
	const directives: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = DIRECTIVE_RE.exec(text)) && directives.length < limit) {
		const inner = match[1] ?? match[2] ?? match[3] ?? '';
		const normalized = inner.replace(/\s+/g, ' ').trim();
		if (!normalized) continue;
		directives.push(
			normalized.length > 280 ? normalized.slice(0, 277) + '...' : normalized
		);
	}
	return directives;
}

function buildImplicitWakeupMessage(
	activeTabId: string | null,
	tabs: TabPromptInfo[]
): string {
	const directivesByTab = tabs
		.map(({ tabId, currentMd }) => ({
			tabId,
			directives: extractInlineDirectives(currentMd)
		}))
		.filter((entry) => entry.directives.length > 0);

	if (directivesByTab.length === 0) {
		return GENERIC_WAKEUP_MESSAGE;
	}

	const lines = [
		'I clicked Wake-up without a specific request. The documents contain inline directives: notes I wrote for you, wrapped in [[ ]], (( )), or << >>. Treat them as the most likely tasks.'
	];
	const activeDirectives =
		directivesByTab.find((entry) => entry.tabId === activeTabId) ?? null;
	if (activeDirectives) {
		lines.push('', `Active tab ${activeDirectives.tabId}:`);
		for (const directive of activeDirectives.directives) {
			lines.push(`- ${directive}`);
		}
	}

	const otherDirectiveTabs = directivesByTab.filter((entry) => entry.tabId !== activeTabId);
	if (otherDirectiveTabs.length > 0) {
		lines.push('', 'Other open tabs with directives:');
		for (const entry of otherDirectiveTabs) {
			for (const directive of entry.directives) {
				lines.push(`- ${entry.tabId}: ${directive}`);
			}
		}
	}

	lines.push(
		'',
		'Resolve a directive by replacing its marker with the written-out result via edit_doc, one thread per directive (no thread_id; each directive edit opens its own review thread). Read other files first if that helps. For open tabs use read_doc, edit_doc, and write_doc, not the built-in file tools.'
	);
	return lines.join('\n');
}

function shellTokenCandidates(command: string): string[] {
	const rawTokens = command.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? [];
	const tokens = new Set<string>();
	for (const rawToken of rawTokens) {
		for (const piece of rawToken.split('=')) {
			const cleaned = piece.replace(
				/^[\s"'`([{<]+|[\s"'`)\]}>;,]+$/g,
				''
			);
			if (!cleaned || cleaned === '-' || cleaned === '--') continue;
			tokens.add(cleaned);
		}
	}
	return [...tokens];
}

function findReferencedOpenTabPath(
	value: unknown,
	openTabPaths: Set<string>
): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const normalized = normalizeToolPath(value.trim());
	return openTabPaths.has(normalized) ? normalized : null;
}

function findOpenTabPathInCommand(
	command: unknown,
	openTabPaths: Set<string>
): string | null {
	if (typeof command !== 'string' || !command.trim()) return null;
	for (const token of shellTokenCandidates(command)) {
		const matched = findReferencedOpenTabPath(token, openTabPaths);
		if (matched) return matched;
	}
	return null;
}


interface TabPromptInfo {
	tabId: string;
	currentMd: string;
	lastSeenMd: string | null;
	commentThreads: CommentThread[];
	/** Thread ids that currently carry a pending edit (review round). A reply
	 * on one of these is feedback on an edit to revise, not a chat. */
	pendingEditThreadIds: string[];
}

interface QueryRoundOutcome {
	usedDocMutationTool: boolean;
}

/** Static instructions that never change between renders in a session. Sent
 * via the SDK's `systemPrompt` option so the Anthropic API caches them and
 * the per-render `prompt` only carries the dynamic file + rules + user
 * message content. Without this split, every render was re-sending ~5KB of
 * boilerplate and burning context + tokens. */
function buildSystemPrompt(): string {
	const meta = readMeta();
	// Each rule renders with any stored violation examples indented under
	// it — real passages from this user's sessions (rejected edits, flagged
	// text). A concrete "what breaking this looks like" beats restating the
	// rule, so keep them verbatim.
	const rulesBlock = meta.rules.length > 0
		? meta.rules
				.map((r, i) => {
					const lines = [`${i + 1}. ${r.text}`];
					for (const ex of r.examples ?? []) {
						lines.push(`   Violation example: "${ex.violation}"${ex.note ? ` (${ex.note})` : ''}`);
					}
					return lines.join('\n');
				})
				.join('\n')
		: 'None.';

	return `# Who you are

You are my writing collaborator. I am the author. Everything you write, including suggestions, should support my writing and sound like me.

This transcript is the two of us talking. My turns speak as "I"; your replies, comments, and questions address me as "you". Never refer to me in the third person — not "the user", not "the author" — anywhere a person reads your words: thread replies, comments, edit rationales, questions.

## Your instructions

Apply this to every word you write: edits, new prose, and your replies on comment threads. My rules and the document's style override it.

- Use plain, everyday words. Write "use", not "leverage" or "utilize".
- Write complete sentences, and prefer long, explanatory sentences over short, punchy ones. Write the way people explain things out loud, in longer sentences with commas and one or two related clauses that carry the reasoning along. A sentence should end because the thought is complete, not because a short sentence would sound stronger. Plain means explanatory, not terse.
- Keep the writing boring, descriptive, and explanatory. Do not use a catchy phrase, slogan, clever label, metaphorical summary, or wording meant to sound memorable; state the actual concept, action, condition, or relationship in literal terms. This applies to headings, topic sentences, callouts, labels, summaries, and ordinary prose. Never write a staccato run of short sentences for emphasis, and never lead with a colon-headed label fragment such as "The problem: fixed." Explain in prose.
- Prefer concrete verbs and named things. Replace "various", "several", "a number of", "important", "robust", and "powerful" with the specific thing.
- Repeat a word rather than swapping in a synonym.
- Do not use analogies, metaphors, or imagery unless my text uses them.
- Do not pad. Cut throat-clearing openers, summary paragraphs that restate the section, "in conclusion" endings, stacked hedges, and empty intensifiers such as "truly", "incredibly", and "genuinely".
- Punctuation follows my habits. If I do not use em dashes, you do not. If I use the serial comma, you do.
- This is THE TELL LIST. Other sections refer to it by name. Never write any of these: em dashes as default punctuation, "It's not just X, it's Y", "Let's dive in", "delve", "tapestry", "navigating the landscape", "moreover" or "furthermore" as paragraph glue, three-item lists for rhythm, "Certainly!" or "Absolutely!" openers, hollow superlatives, "In today's fast-paced world".

Voice belongs to me. Match my cadence, vocabulary, sentence length, capitalization, and punctuation. If I write short, punchy sentences, do not smooth them into long ones. If I use lowercase headings, keep them lowercase. The odd parts of my writing are usually the voice. Keep them unless I say otherwise.

## Editing discipline

- Cut before you add. Prefer, in order: cut, tighten, replace, rearrange, rewrite. A good edit usually leaves the text shorter.
- Edit only the thing you are fixing. If one sentence is broken, fix that sentence and leave its neighbors alone.
- If the prose is fine, do nothing. "No edit needed" is a correct outcome at every autonomy level.
- When you are guessing at my intent, ask (AskUserQuestion, 2 to 4 concrete options) or reply on the passage's thread. Do not generate prose to fill the gap.

## Files

Every file is raw text, including .md. The editor renders markdown source literally, so preserve whatever syntax the file uses. Keep JSON, YAML, and code valid. Do not add or strip formatting unless asked.

Before your first edit in a session, list the files in the workspace directory with Glob and read nearby files for context. Understanding the project layout — sibling files, naming conventions, and existing structure — helps you make edits that fit the rest of the project.

## Editing tools

- For any workspace file, open tab or not, use edit_doc, write_doc, and read_doc. The path argument is the tab id (e.g. "drafts/chapter-1.md") or the file's absolute path. The built-in Edit and Write tools only work in your scratch space.
- Each edit_doc or write_doc call on an existing file creates or updates a pending proposal. The document changes only when I accept it. write_doc on a file that does not exist creates it and opens it as a new tab, with no proposal.
- Base old_string on the current document text, which read_doc returns. Never base it on your own earlier proposal.
- Do not create new files unless I asked for one.
- If my message is about the active file, edit that one. Edit other files only when the request spans them.
- Your scratch space is ${AGENT_SCRATCH_DIR}/. Use it for drafts, outlines, and notes to yourself. I never see it. It persists across turns and is wiped on "New session".
- Read anywhere in the workspace with the built-in Read, Glob, and Grep. For open tabs, use read_doc instead. The built-in Read can also read images and PDFs (preview-only tabs).
- For hooks call propose_hook. For rules call propose_rule. For skills call add_skill with a GitHub URL or local path. Do not edit .docwriter/hooks.json, .docwriter/skills.json, .claude/skills, or .agents/skills directly.
- Call review_action to accept, reject, dismiss, or reopen only when my current message explicitly asks for that action. Dismissed threads stay on the document. list_threads(include_dismissed=true) reads them; review_action(reopen_thread) puts one back in the gutter.

## Announce edits on a thread

Every edit proposal needs a comment thread that says what is about to happen, so I see your reasoning next to the pending edit instead of a bare diff.

- If the work already has a thread — my feedback arrives with a thread_id, or you are revising a thread's pending edit — use it. If you have not yet explained this edit there, reply first with reply_to_comment, then call edit_doc with that thread_id. ${REPLY_BEFORE_EDIT_PROMPT_NOTE}
- If I clicked Accept on a stale or orphaned proposal, rebase it. Keep that thread_id. Re-read the file, find the current passage that now corresponds to the original old_string, re-attach the thread with reply_to_comment(anchor_text) if the original quote is gone, then edit_doc with that new old_string and the intended replacement. Leave the result as a pending reviewable diff — do not expect it to apply until I Accept the rebased proposal. Do not open a new thread.
- Otherwise, before the edit, call comment_doc anchored to the exact text you are about to change, with one or two first-person sentences addressed to me: what prompted the edit (my words, an inline directive, a rule), what you think is wrong, and what you will do. Then call edit_doc with the thread_id that comment_doc returns.
- Inline directives such as [[ ... ]] follow the same contract: anchor the thread on the directive text, say how you read the directive and what you will write, then propose the edit on that thread.
- For write_doc on an existing file, anchor the thread to the first sentence of the text you are replacing.
- write_doc that creates a new file needs no thread; there is no proposal to explain.
- These announce threads are part of the edit and apply at every autonomy level. The one-comment-per-turn limit and the autonomy gate in "Where a response goes" govern unprompted observations, not announce threads.

## How turns arrive

Each turn may contain these blocks, in this order.

- <workspace_state>: the open tabs, a diff of what changed in each since your last turn, and comment-thread stubs (open threads plus a count of dismissed ones). Unchanged tabs say "Unchanged". Tab content is never inlined. Call read_doc(file_path) when you need it. Calls are cheap because the server holds the document in memory, so read what you need, not every tab.
- <author_style>: how I write, learned from my own writing. Present on every turn once a style has been learned. Follow it whenever you draft or revise prose, unless I ask for something different this turn.
- <session_state>: rules, style references, the agency level, and the intended audience. Sent in full on the first turn, then only when something changed. If the block is absent, nothing changed.
- <mode>: present only in special modes, such as plan-first.
- <user_message>: my words, verbatim.
- <user_feedback thread="..." mode="...">: my reply on a comment thread, verbatim, with the thread id and routing mode as attributes.

A turn with no user_message and no user_feedback is a harness event, such as a Wake-up click, written as plain narration. The tagged state blocks are reports, not requests. My requests arrive only in user_message, user_feedback, and inline directives in the documents.

## Where a response goes

I do not read assistant text. It only appears in the agent log pane. Anything meant for me goes on the document: an edit proposal, a thread reply, or a comment. Leave assistant text empty, or write at most one line.

Decide where to respond in this order. The first rule that matches wins.

1. If the feedback's mode attribute is edit, edit. If it is discuss, reply on the thread.
2. If the thread has a pending edit and I replied, treat the reply as feedback on the edit. Call edit_doc with the thread_id to propose a revision of the thread's anchored passage itself, not a different part of the document. Reply in words only if I asked a question and clearly want no change. If the feedback is contradictory, use AskUserQuestion.
3. If the feedback names a concrete change, e.g. "too wordy" or "tighten", announce per "Announce edits on a thread" and call edit_doc. Beyond the announce, do not also reply.
4. If the message is open-ended or unsure, e.g. "what do you think?", reply on the existing thread. Write in the first person, addressing me as "you", in complete explanatory sentences that carry your reasoning. A few sentences is the right length, but they must be full sentences, not fragments or label-led lines. When that reply says what you would change in the anchored passage, propose the change too: call edit_doc with the thread_id in the same turn, so the diff sits under your explanation and I can accept or dismiss it there. A thread I opened is an explicit request about its passage, so this holds at every autonomy level. There is no approval step between a reply and its edit; a reply that describes an edit without proposing it leaves me nothing to accept.
   The one exception is genuine uncertainty about how to make the change: two readings that lead to different edits, or a fact only I know. Then ask in the reply and propose nothing until I answer. This should be rare.
5. If no thread exists and autonomy is Medium or High, you may open one with comment_doc, anchored to exact text from the current document. Open at most one comment per turn. At Low autonomy, use AskUserQuestion or do nothing.

## Subagents

Every docwriter document tool — read_doc, edit_doc, write_doc, comment_doc, reply_to_comment, list_threads — is connected to this turn and only this turn. A subagent cannot reach them: its calls fail, and the failure takes my connection with them, so the rest of the turn loses the tools too. Never hand document work to a subagent. Read the file, propose the edits, and write the comments yourself, in order, however long the file is.

You may still use the Agent tool for work that touches no document tool, such as searching the wider repository with Read and Grep for background you need. Give any such subagent a stop condition and have it report back; do not let it edit or comment.

## Proposing rules

Propose at most one rule per turn with propose_rule, and only with evidence. Evidence, strongest first:

- An explicit standing preference in any channel — chat, a comment thread reply, or an inline [[ directive ]]: "never use X", "add a rule that Y". Propose in the same turn.
- I accepted an edit that came from my feedback. When a tab's diff shows that an edit you proposed on a thread has landed in the document, re-read that thread and the edit. If the feedback behind it names a pattern that generalizes beyond that one passage — a tell, "sounds AI", "too wordy" — propose the rule, and put the thread's feedback and the accepted change in the reason field.
- The same pattern in my own edits or feedback more than once, including across comment threads and inline directives.

A flagged tell alone is not yet a rule: fix the flagged instance with edit_doc, and propose the rule when I accept a fix for that feedback. A rejected edit is the opposite signal — do not propose a rule from feedback whose edit I rejected.

Write rules as short imperatives that are specific enough to check, e.g. "Never use em dashes". When a concrete passage shows what breaking the rule looks like — a sentence I flagged, the passage a tell appeared in — quote it verbatim in the example_violation field so the rule carries a real example. When unsure, do not propose.

## Style references

I may register style references: URLs, workspace files, and saved samples. The current list arrives in session_state when it changes. Read a reference only when it would help the current edit, and treat it as style guidance only. Do not import facts, examples, or claims from it.

When you fetch a URL reference, ask WebFetch for 3 to 6 verbatim passages, each a full paragraph or a few consecutive sentences, with a note on what each passage shows about sentence length, clause structure, register, and punctuation. Do not ask for a summary or a trait list. The passages themselves are the signal. Use them to judge the rhythm of your own edit, and never copy their phrasing into the draft.

## Rules to obey

${rulesBlock}

Each rule is a hard constraint on every edit. If a rule conflicts with my explicit request this turn, the request wins for this turn only. Rule changes arrive in session_state as + and - lines. If none appear, this list is current.

## Autonomy

The agency level arrives in session_state when it changes.

- Low: no edits, no new comments. Act only on an inline directive, a diff that needs a specific fix, or an explicit request. When in doubt, do nothing.
- Medium: you have Low's edit permissions, and you may also open a comment thread when one would help. Open at most one per turn.
- High: propose an edit or comment when you can name the specific defect: an unclear antecedent, a repeated point, a buried verb, a broken transition. Name the defect in the proposal. If you cannot name a defect, do not edit. Tighten, but do not rewrite.

## Intended audience

When set, the intended reader arrives in session_state. Write for that audience: assume their background, match their jargon, and do not explain what they already know. If the block is absent, the audience is unchanged. If cleared, stop targeting a specific audience.

## What wins when guidance conflicts

Several things tell you how to write, and they will sometimes disagree. Resolve it in this order, highest first.

1. **What I asked for this turn**, in user_message or user_feedback. An explicit request beats everything below it, for this turn only.
2. **The rules in "Rules to obey".** These are my standing hard constraints, written and confirmed by me. They are the most important standing context you have. A rule beats the learned style, the intended audience, and your own judgement every time. If the author style suggests a construction a rule forbids, the rule wins and you write it another way.
3. **The intended audience.** Who the piece is for shapes vocabulary and how much you explain.
4. **The author style in author_style.** How I tend to write, inferred from a small sample. Follow it where it fits; it never overrides a rule or an explicit request.
5. **Your own judgement**, for everything the above leaves open.

Do not narrate this ordering or announce that a conflict occurred. Just write the sentence the highest applicable guidance calls for.`;
}

/** Build the per-render user prompt. Only the DYNAMIC content goes here —
 * files + rules + agency guidance + the user's message. Static instructions
 * are in the systemPrompt (see `buildSystemPrompt`).
 *
 * Content-inlining policy: never inline full content. Every tab gets a
 * header (path + active marker if it's the focused tab) plus the diff
 * since the agent's `last_seen` baseline if there is one. The agent calls
 * `read_doc(file_path)` to fetch full content on demand — free in-process
 * fetch against the live Y.Doc, no token cost on the prompt side.
 *
 * The previous design re-inlined the active tab's full content on every
 * turn, which (a) burned tokens proportional to doc size and (b) broke
 * prompt caching since the dynamic prompt is a fresh user message each
 * turn. read_doc-on-demand is one extra tool round-trip when the agent
 * needs the file, but most edits start from a diff anyway.
 */
/** Render a tab's open comment threads as a lightweight stub block. Each
 * thread shows the EXACT passage the user commented on (its anchor quote) so
 * the agent knows precisely where to edit — a comment is usually a request to
 * revise that quoted passage. Message content is not inlined; the agent calls
 * `list_threads(path)` to read the conversation, keeping the prompt lean. */
function renderCommentThreadsBlock(
	threads: CommentThread[],
	pendingEditThreadIds: string[] = []
): string {
	const open = threads.filter((t) => !t.resolved);
	const dismissedCount = threads.filter((t) => t.resolved).length;
	if (open.length === 0 && dismissedCount === 0) return '';
	const pending = new Set(pendingEditThreadIds);
	const lines: string[] = [];
	if (open.length > 0) {
		lines.push('Open threads (route per "Where a response goes"):');
		for (const thread of open) {
			const quote = thread.anchor.quote.replace(/\n+/g, ' ').slice(0, 120);
			const ellipsis = thread.anchor.quote.length > 120 ? '…' : '';
			const pendingNote = pending.has(thread.id) ? ' (pending edit)' : '';
			lines.push(`- ${thread.id}${pendingNote} anchored to: "${quote}${ellipsis}"`);
		}
	}
	const dismissedHint = formatDismissedThreadsHint(dismissedCount);
	if (dismissedHint) lines.push(dismissedHint);
	return '\n' + lines.join('\n');
}

/** Compute a deterministic snapshot string for the active rule set. Used to
 * detect when rules have been added / removed between renders. */
function snapshotRules(rules: { text: string }[]): string {
	return JSON.stringify(rules.map((r) => r.text).sort());
}

/** Snapshot of the active style references (URL list, workspace paths, saved
 * sample paths). Sorted so cosmetic re-ordering doesn't trip the change detector. */
function snapshotRefs(profile: StyleProfile | null): string {
	const refs = listStyleReferences().map((r) => `${r.type}::${r.target}`);
	const active = publishedStylePropositions(profile).length;
	return JSON.stringify({ refs: refs.sort(), active, profileUpdatedAt: profile?.updatedAt ?? 0 });
}

/** Build the diff line block for rules vs. the prior snapshot. Returns null
 * when nothing changed (so the section is omitted entirely). */
function buildRulesDelta(
	currentRuleTexts: string[],
	priorJson: string | null
): string | null {
	let prior: string[] = [];
	if (priorJson) {
		try { prior = JSON.parse(priorJson) as string[]; } catch { prior = []; }
	}
	const priorSet = new Set(prior);
	const currentSet = new Set(currentRuleTexts);
	const added = currentRuleTexts.filter((t) => !priorSet.has(t));
	const removed = prior.filter((t) => !currentSet.has(t));
	if (added.length === 0 && removed.length === 0) return null;

	const lines: string[] = [];
	if (priorJson === null) {
		// First render of the session — show the full current list.
		if (currentRuleTexts.length === 0) {
			lines.push('Rules: none active.');
		} else {
			lines.push('Rules:');
			currentRuleTexts.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
		}
	} else {
		lines.push('Rule changes:');
		for (const t of added) lines.push(`+ ${t}`);
		for (const t of removed) lines.push(`- ${t}`);
	}
	return lines.join('\n');
}

/** Build the active style-reference list as a small bullet block. Returned
 * only when the list has changed since the prior render. A learned profile is
 * handled by buildStyleBlock instead, which is not delta-gated. */
function buildRefsBlock(profile: StyleProfile | null): string | null {
	if (publishedStylePropositions(profile).length > 0) return null;
	const refs = listStyleReferences().slice(0, 6);
	if (refs.length === 0) return null;
	const lines = ['Style references:'];
	for (const ref of refs) lines.push(`- ${ref.description || ref.label}`);
	return lines.join('\n');
}

/**
 * The learned author style, sent with every turn.
 *
 * This was one line in the session-state delta, which emits only on the render
 * where the profile changed, so every turn after that ran with nothing saying a
 * style existed — and on the claude provider that was the only mention at all,
 * since the skills block is skipped there. It lives in the turn prompt rather
 * than the system prompt because almost every render resumes a session, and the
 * SDK does not promise a new system prompt is reapplied when it does. The
 * instructions are short enough to inline; the skill keeps the passages.
 */
function buildStyleBlock(profile: StyleProfile | null): string | null {
	const active = publishedStylePropositions(profile);
	if (active.length === 0) return null;
	return [
		'How I write, learned from a handful of pieces I wrote. Follow this whenever you draft or revise prose here, unless I ask for something different this turn.',
		'',
		...active.map((proposition) => `- ${proposition.instruction}`),
		'',
		'These are tendencies, not rules. Follow the ones that fit and skip the rest. They govern how you write, not what about: take no facts or subject matter from the references. My rules come first.',
		'',
		`Read the \`${profile?.skillId ?? 'author-style'}\` skill before you write. It holds the passages behind each instruction.`
	].join('\n');
}

function buildMultiTabPrompt(
	activeTabId: string | null,
	tabs: TabPromptInfo[],
	userMessage: string,
	opts: { isUserMessage?: boolean; previewTabs?: string[] } = {}
): string {
	const meta = readMeta();
	const currentRuleTexts = meta.rules.map((r) => r.text);
	const currentAgency = meta.agentSettings.agency;
	const currentAudience = (meta.agentSettings.intendedAudience ?? '').trim();

	// Read prior snapshots so we can emit only the deltas. First render of a
	// session (snapshot absent) shows the full state — agent needs it once.
	const priorRulesJson = kvGet(KV_LAST_RULES);
	const priorRefsJson = kvGet(KV_LAST_REFS);
	const priorAgency = kvGet(KV_LAST_AGENCY);
	const priorAudience = kvGet(KV_LAST_AUDIENCE);

	const currentRulesJson = snapshotRules(meta.rules);
	// Read once: three blocks below all describe the same profile, and parsing
	// it is a few milliseconds of Zod validation each time.
	const styleProfile = readStyleProfile();
	const currentRefsJson = snapshotRefs(styleProfile);

	const previewTabs = opts.previewTabs ?? [];
	const openTabLine =
		[
			...tabs.map((t) => t.tabId + (t.tabId === activeTabId ? ' (active)' : '')),
			...previewTabs.map(
				(t) => t + (t === activeTabId ? ' (active, preview-only)' : ' (preview-only)')
			)
		].join(', ') +
		(previewTabs.length > 0
			? '\nPreview-only tabs are binary files (PDF, images): not editable, no document tools. Use the built-in Read if you need to look at one.'
			: '');
	const tabSections = tabs.length === 0 && previewTabs.length === 0
		? 'No files are open as tabs. Use Read / Glob / Grep to explore the workspace; use edit_doc({ path, ... }) to edit, or write_doc({ path, ... }) to create a file (the path argument is the workspace-relative path).'
		: 'Open tabs: ' +
			openTabLine +
			'\n\n' +
			tabs
				.map(({ tabId, currentMd, lastSeenMd, commentThreads, pendingEditThreadIds }) => {
					const hasLastSeen = lastSeenMd !== null;
					const hasDiff = hasLastSeen && lastSeenMd !== currentMd;
					const threadBlock = renderCommentThreadsBlock(commentThreads, pendingEditThreadIds);

					if (!hasLastSeen) {
						return `${tabId}\nNew this session. Call read_doc("${tabId}") to read it.${threadBlock}`;
					}
					if (hasDiff) {
						const diff = unifiedLineDiff(lastSeenMd as string, currentMd);
						if (diff.length > PROMPT_DIFF_CAP_CHARS) {
							const added = (diff.match(/^\+/gm) ?? []).length;
							const removed = (diff.match(/^-/gm) ?? []).length;
							return `${tabId}\nChanged extensively since your last turn (+${added}/−${removed} diff lines — too large to inline). Call read_doc("${tabId}") for the current text.${threadBlock}`;
						}
						return `${tabId}\nChanged since your last turn:\n\`\`\`diff\n${diff}\n\`\`\`${threadBlock}`;
					}
					return `${tabId}\nUnchanged.${threadBlock}`;
				})
				.join('\n\n');

	// Assemble the dynamic prompt per the turn protocol the system prompt
	// defines in "How turns arrive": tagged state blocks first, the user's
	// words last. session_state is omitted entirely when nothing changed.
	const sections: string[] = [`<workspace_state>\n${tabSections}\n</workspace_state>`];

	// Not delta-gated: the style is the point of the feature, so it goes in
	// every turn rather than only the one where it changed.
	const styleBlock = buildStyleBlock(styleProfile);
	if (styleBlock) sections.push(`<author_style>\n${styleBlock}\n</author_style>`);

	const sessionParts: string[] = [];
	const rulesDelta = buildRulesDelta(currentRuleTexts, priorRulesJson);
	if (rulesDelta) sessionParts.push(rulesDelta);
	if (currentRefsJson !== priorRefsJson) {
		const refsBlock = buildRefsBlock(styleProfile);
		if (refsBlock) sessionParts.push(refsBlock);
	}
	if (currentAgency !== priorAgency) {
		sessionParts.push(`Agency: ${currentAgency}`);
	}
	if (currentAudience !== (priorAudience ?? '')) {
		sessionParts.push(
			currentAudience
				? `Intended audience: ${currentAudience}`
				: 'Intended audience: (cleared — no specific audience set.)'
		);
	}
	if (sessionParts.length > 0) {
		sections.push(`<session_state>\n${sessionParts.join('\n\n')}\n</session_state>`);
	}

	if (opts.isUserMessage === false) {
		// Harness event (wakeup, directive retry): plain narration, no user tag.
		sections.push(userMessage);
	} else {
		// The feedback path still transports thread id + mode inside the
		// message string (composed in TiptapEditor); surface them as
		// attributes so the model sees an explicit frame.
		const threadId = userMessage.match(/thread_id="([^"]+)"/)?.[1] ?? null;
		const mode = userMessage.match(/\[mode: (auto|edit|discuss)\]/)?.[1] ?? null;
		sections.push(
			threadId
				? `<user_feedback thread="${threadId}"${mode ? ` mode="${mode}"` : ''}>\n${userMessage}\n</user_feedback>`
				: `<user_message>\n${userMessage}\n</user_message>`
		);
	}

	// Persist the new snapshots for next turn's diff. Failures are swallowed —
	// at worst the next turn sends a redundant full block.
	try {
		kvSet(KV_LAST_RULES, currentRulesJson);
		kvSet(KV_LAST_REFS, currentRefsJson);
		kvSet(KV_LAST_AGENCY, currentAgency);
		kvSet(KV_LAST_AUDIENCE, currentAudience);
	} catch (err) {
		console.error('[render] failed to persist prompt-state snapshot:', err);
	}

	return sections.join('\n\n');
}


/** Names the SDK will give the tools in stream events. SDK MCP tools are
 * namespaced as `mcp__<serverName>__<toolName>`. */
const PROPOSE_RULE_TOOL_NAME = 'mcp__docwriter__propose_rule';
const PROPOSE_HOOK_TOOL_NAME = 'mcp__docwriter__propose_hook';
/** Built-in SDK tool for multiple-choice user clarification questions.
 * We intercept it in canUseTool, surface the questions to the browser
 * via an SSE event, and resolve the canUseTool promise with the user's
 * selections when they arrive back via /api/ask-user-reply. */
const ASK_USER_TOOL_NAME = 'AskUserQuestion';
/** Built-in SDK tool the agent calls to leave plan mode. Its `plan` input
 * is the final plan text. We intercept it, forward the plan to the browser
 * as `plan_proposed`, abort the run, and let the user decide whether to
 * re-run without plan mode via the modal's "Run it" button. If we let it
 * through, the SDK auto-approves and the agent immediately starts
 * executing edits — defeating the entire point of plan mode. */
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

// Hook runner extracted to $lib/server/hook-runner so the manual-run
// /api/hooks/run endpoint can reuse the same spawn/emit logic.

/** Default timeout for user-configured hook commands (seconds). Matches the
 * SDK default; keeps slow runaway commands from blocking the agent. */
const USER_HOOK_TIMEOUT_SEC = 60;

type HookCallback = (input: any) => Promise<any>;
type HookEntry = { matcher: string; hooks: HookCallback[]; timeout?: number };

function hookToolInputFilePath(toolInput: unknown): string | undefined {
	if (!toolInput || typeof toolInput !== 'object') return undefined;
	const input = toolInput as Record<string, unknown>;
	for (const key of ['file_path', 'path', 'file', 'target', 'source']) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return undefined;
}

function hookMatchesTool(hook: Hook, toolName: string): boolean {
	if (!hook.matcher?.trim()) return true;
	if (!toolName) return false;
	try {
		// Case-insensitive so `Edit|Write` matches both built-in tools and
		// namespaced MCP variants like `mcp__docwriter-doc__edit_doc`.
		return new RegExp(hook.matcher, 'i').test(toolName);
	} catch {
		return false;
	}
}

async function runUserHooksForEvent(
	event: HookEvent,
	emitHookRun: HookRunEmitter,
	opts: { toolName?: string; toolInput?: unknown } = {}
): Promise<void> {
	const userHooks = readHooks().hooks.filter((h) => h.enabled !== false && h.event === event);
	const isToolEvent =
		event === 'PreToolUse' ||
		event === 'PostToolUse' ||
		event === 'PostToolUseFailure';
	const toolName = opts.toolName ?? '';
	for (const hook of userHooks) {
		if (isToolEvent && !hookMatchesTool(hook, toolName)) continue;
		await runHookCommand(
			hook,
			toolName,
			hookToolInputFilePath(opts.toolInput),
			emitHookRun
		);
	}
}

/** Build the hook map for this render. Only user-defined shell hooks
 * (from `.docwriter/hooks.json`) are wired in. Agent writes to open tabs
 * go through `edit_doc` / `write_doc`, which mutate the live Y.Doc
 * atomically and stream to the browser directly — no internal sync
 * hooks needed. */
function buildHooks(
	emitHookRun: HookRunEmitter
): Partial<Record<HookEvent | 'PreToolUse', HookEntry[]>> {
	const userHooks = readHooks().hooks.filter((h) => h.enabled !== false);

	function buildUserHookCallback(hook: Hook): (input: any) => Promise<any> {
		return async (input) => {
			const toolInput = (input as any).tool_input;
			const toolName: string = (input as any).tool_name || '';
			// For tool-based hooks, filter by matcher (regex over tool name).
			// For non-tool hooks (Stop, UserPromptSubmit, Session*, etc.) the
			// matcher is ignored here — the SDK handles event-type matching
			// via the top-level matcher on the hook entry.
			if (toolName && !hookMatchesTool(hook, toolName)) return {};
			await runHookCommand(hook, toolName, hookToolInputFilePath(toolInput), emitHookRun);
			return {};
		};
	}

	const buckets: Record<string, HookEntry[]> = {};
	for (const ev of HOOK_EVENTS) buckets[ev] = [];

	for (const h of userHooks) {
		const cb = buildUserHookCallback(h);
		const toolEvent =
			h.event === 'PreToolUse' ||
			h.event === 'PostToolUse' ||
			h.event === 'PostToolUseFailure';
		const matcher = toolEvent && h.matcher && h.matcher.trim() ? h.matcher : '';
		buckets[h.event].push({ matcher, hooks: [cb], timeout: USER_HOOK_TIMEOUT_SEC });
	}

	const out: Partial<Record<string, HookEntry[]>> = {};
	for (const [k, v] of Object.entries(buckets)) {
		if (v.length > 0) out[k] = v;
	}
	return out as Partial<Record<HookEvent | 'PreToolUse', HookEntry[]>>;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { userMessage, model, warmup, tab, planMode, images, reviewerId, provider: providerIdRaw, staleAccept } = body as {
			userMessage?: string;
			model?: string;
			warmup?: boolean;
			tab?: string;
			planMode?: boolean;
			images?: ImageAttachmentPayload[];
			/** Reviewer agent id — runs a critique pass on the active tab
			 * instead of an ordinary render. */
			reviewerId?: string;
			provider?: string;
			/** User Accepted a stale proposal: commit the agent's rebased
			 * edit_doc immediately instead of leaving another review card. */
			staleAccept?: StaleAcceptApply;
		};
		const providerId = (providerIdRaw || 'claude') as ProviderId;
		// Switching providers invalidates the persisted session id: each
		// provider mints ids in its own format (Claude wants a UUID, OpenAI
		// uses `openai-…`, etc.) and can't resume another's. Clear it so the
		// new provider starts a fresh session instead of trying to --resume a
		// foreign id (which errors).
		const prevProvider = kvGet('provider');
		if (prevProvider && prevProvider !== providerId) {
			setSessionId('');
		}
		kvSet('provider', providerId);

		const allTabIds = getTabsState().order;
		// `active` is nullable: the user can message the agent with zero tabs
		// open (e.g. "create a new file with X"). We only resolve it when a
		// tab is actually open and valid.
		const candidateActive = tab || getTabsState().active;
		const active: string | null =
			candidateActive && isValidTabId(candidateActive) && allTabIds.includes(candidateActive)
				? candidateActive
				: null;
		// Critique pass: resolve the reviewer up front. It needs an active
		// tab — the pass reviews one concrete draft.
		let critiqueReviewer: Reviewer | null = null;
		if (reviewerId) {
			critiqueReviewer = getReviewerById(String(reviewerId));
			if (!critiqueReviewer) throw error(400, `Unknown reviewer: ${reviewerId}`);
			if (!active) throw error(400, 'Open a file to run a critique pass');
		}

		// With no anchor (no tab) AND no user message, there's nothing to do
		// — the agent has no prompt context. Warmup is exempt because it's a
		// dry "are you alive?" ping.
		if (!active && !userMessage && !warmup) {
			throw error(400, 'No active tab and no message');
		}

		// Snapshot each text tab's live authoritative content + its last-seen
		// baseline. The agent gets a prompt built off this snapshot and
		// post-render we write each tab's (new) current content back as the
		// baseline so the next render diffs cleanly. Binary tabs are listed
		// as preview-only and never materialized.
		const { textTabs, previewTabs } = splitTabsByKind(allTabIds);
		const tabsForPrompt: TabPromptInfo[] = buildTabPromptInfos(textTabs);

		const currentSessionId = getSessionId();
		const isImplicitWakeup = !userMessage && !warmup && !critiqueReviewer;
		const activeTabInfo = tabsForPrompt.find((info) => info.tabId === active) ?? null;
		const activeInlineDirectives = activeTabInfo
			? extractInlineDirectives(activeTabInfo.currentMd)
			: [];
		const message = critiqueReviewer
			? buildCritiqueMessage(critiqueReviewer, active as string)
			: userMessage || buildImplicitWakeupMessage(active, tabsForPrompt);
		const planModeInstruction = planMode
			? [
					'',
					'<mode>',
					'Plan-first mode is active. I asked for a plan before any edits. Do not call edit_doc, write_doc, or any other mutation tool this round. Read what you need with read_doc, Read, Glob, and Grep, then call ExitPlanMode with your plan in the plan argument.',
					'For each change, the plan states: the diagnosis (why the current text reads wrong, concretely), the intended change in one or two sentences, and the files it touches. Keep the plan short and concrete. After ExitPlanMode the run ends and I approve or reject it.',
					'</mode>'
				].join('\n')
			: '';
		const prompt = warmup
			? `You are my writing collaborator. I have files open as tabs. Say you are ready in one or two sentences. Do not edit anything.`
			: buildMultiTabPrompt(active, tabsForPrompt, message, {
					isUserMessage: !!userMessage,
					previewTabs
				}) + planModeInstruction;
		const baseSystemPromptBlock = warmup ? undefined : buildSystemPrompt();
		const skillsPromptBlock =
			!warmup && providerId !== 'claude'
				? buildSkillsPromptBlock()
				: null;
		const systemPromptBlock = [baseSystemPromptBlock, skillsPromptBlock]
			.filter(Boolean)
			.join('\n\n') || undefined;
		if (systemPromptBlock) setLastSystemPrompt(systemPromptBlock);
		// Only TEXT tabs are fenced off from the built-in tools (they must go
		// through read_doc/edit_doc against the live Y.Doc). Binary tabs are
		// exactly what the built-in Read is for.
		const openTabPaths = new Set(textTabs.map((tabId) => normalizeToolPath(tabFile(tabId))));

		const abortController = new AbortController();
		request.signal.addEventListener('abort', () => abortController.abort());

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const renderStart = Date.now();
				let currentModelForTranscript = '';

				const persistableEvents = new Set([
					'assistant_text', 'assistant_thinking', 'tool_call_start',
					'tool_call', 'tool_result', 'cost', 'session', 'error',
					'rule_proposal', 'hook_proposal'
				]);

				function send(event: string, data: unknown) {
					const payload = {
						...(data as object),
						...(currentModelForTranscript ? { model: currentModelForTranscript } : {}),
						_elapsed: Date.now() - renderStart
					};
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
						)
					);
					if (providerId !== 'claude' && persistableEvents.has(event)) {
						// Only persist once the session id is established (the
						// provider yields `session` first, and the handler sets it
						// before send()). Using a throwaway fallback id would split
						// events into a bucket /api/history never reads.
						const sid = getSessionId();
						if (sid) {
							dbAppendConversationEvent(sid, providerId, event, JSON.stringify(payload));
						}
					}
				}

				const emitHookRun: HookRunEmitter = (entry) => send('hook_run', entry);
				const hooks = buildHooks(emitHookRun);

				try {
					const resolvedModel =
						model || process.env.DOCWRITER_DEFAULT_MODEL || undefined;
					kvSet('model', resolvedModel ?? '');
					currentModelForTranscript = resolvedModel ?? '';

					const provider = await getProvider(providerId);
					const tools = buildToolDefinitions();

					// Mutation tool names (both Claude SDK namespaced and bare)
					const mutationToolNames = new Set([
						EDIT_DOC_TOOL_NAME, WRITE_DOC_TOOL_NAME,
						'edit_doc', 'write_doc'
					]);

					// canUseTool logic (provider-agnostic permission checks)
					const canUseTool = async (toolName: string, toolInput: any) => {
						if (toolName === 'ExitPlanMode') {
							const plan = typeof toolInput?.plan === 'string' ? toolInput.plan : '';
							const planId =
								'plan_' +
								Date.now().toString(36) +
								Math.random().toString(36).slice(2, 6);
							send('plan_proposed', {
								id: planId,
								plan: plan.trim(),
								originalMessage: userMessage ?? ''
							});
							abortController.abort();
							return {
								behavior: 'deny' as const,
								message: 'Plan sent for review. Stop — do not execute.'
							};
						}
						if (!warmup) {
							if (toolName === 'Read') {
								const matched = findReferencedOpenTabPath(toolInput?.file_path, openTabPaths);
								if (matched) {
									return { behavior: 'deny' as const, message: 'Open tab files must be read with `read_doc(file_path)`.' };
								}
							}
							if (toolName === 'Glob' || toolName === 'Grep') {
								const matched = findReferencedOpenTabPath(toolInput?.path, openTabPaths);
								if (matched) {
									return { behavior: 'deny' as const, message: 'Use `read_doc(file_path)` for open tab files.' };
								}
							}
							if (toolName === 'Bash') {
								const matched = findOpenTabPathInCommand(toolInput?.command, openTabPaths);
								if (matched) {
									return { behavior: 'deny' as const, message: 'Open tab files must be accessed through `read_doc`, `edit_doc`, or `write_doc`.' };
								}
							}
							if (toolName === 'Edit' || toolName === 'Write') {
								const target = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';
								const underScratch = target === AGENT_SCRATCH_DIR || target.startsWith(AGENT_SCRATCH_DIR + '/') || target.includes('.docwriter/agent/scratch/');
								if (!underScratch) {
									return { behavior: 'deny' as const, message: 'Built-in Edit / Write are restricted to your scratch directory. Use `edit_doc` or `write_doc` instead.' };
								}
							}
						}
						if (toolName === 'AskUserQuestion') {
							const id = 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
							const questions = toolInput?.questions ?? [];
							send('user_question', { id, questions });
							// The SDK's AskUserQuestion schema requires `answers` to be a
							// record keyed by question text (multi-select answers
							// comma-joined). An array here fails schema validation and the
							// tool call errors out for every question the agent asks.
							const answers = await new Promise<Record<string, string>>((resolve) => {
								registerPendingAskUser(id, resolve, 15 * 60_000);
							});
							return { behavior: 'allow' as const, updatedInput: { ...toolInput, answers } };
						}
						return { behavior: 'allow' as const, updatedInput: toolInput };
					};

					// Build allowed tools list based on mode
					const planAllowedTools = [
						'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent',
						'AskUserQuestion', 'ExitPlanMode',
						READ_DOC_TOOL_NAME, REPLY_TO_COMMENT_TOOL_NAME,
						'read_doc', 'reply_to_comment', 'list_threads', TOOL_NAMES.READ_SKILL
					];
					const fullAllowedTools = [
						'Read', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent',
						'mcp__docwriter__propose_rule', 'mcp__docwriter__propose_hook', 'mcp__docwriter__add_skill', 'mcp__docwriter__review_action',
						'AskUserQuestion', 'ExitPlanMode',
						EDIT_DOC_TOOL_NAME, READ_DOC_TOOL_NAME, WRITE_DOC_TOOL_NAME, COMMENT_DOC_TOOL_NAME, REPLY_TO_COMMENT_TOOL_NAME,
						'edit_doc', 'read_doc', 'write_doc', 'comment_doc', 'reply_to_comment', 'list_threads',
						'propose_rule', 'propose_hook', TOOL_NAMES.READ_SKILL, TOOL_NAMES.ADD_SKILL, TOOL_NAMES.REVIEW_ACTION
					];
					const allowedTools = warmup
						? ['Read', 'Glob', 'WebSearch', 'WebFetch']
						: planMode
							? planAllowedTools
							: fullAllowedTools;

					// Persist the user's message into the transcript exactly once,
					// the moment the session id is known (see the session handler
					// below). Non-Claude providers only — Claude logs it in its
					// own JSONL transcript.
					let userMsgPersisted = false;

					async function runQueryRound(
						roundPrompt: string,
						roundImages?: ImageAttachmentPayload[]
					): Promise<QueryRoundOutcome> {
						let usedDocMutationTool = false;
						const toolInputsForHooks = new Map<string, {
							toolName: string;
							input: Record<string, unknown>;
						}>();

						for await (const event of provider.query({
							prompt: roundPrompt,
							systemPrompt: systemPromptBlock,
							model: resolvedModel,
							sessionId: getSessionId() || currentSessionId || undefined,
							planMode: !!planMode,
							warmup: !!warmup,
							allowedTools,
							canUseTool,
							abortSignal: abortController.signal,
							images: roundImages,
							// Critique passes read the whole draft and judge it;
							// give them more thinking room than routine edits.
							effort: critiqueReviewer ? 'medium' : 'low',
							hooks
						}, tools)) {
							// Track mutation tool usage
							if (event.type === 'tool_call_start' && mutationToolNames.has(event.tool_name)) {
								usedDocMutationTool = true;
							}
							if (event.type === 'tool_call' && mutationToolNames.has(event.tool_name)) {
								usedDocMutationTool = true;
							}
							if (providerId !== 'claude' && event.type === 'tool_call') {
								toolInputsForHooks.set(event.tool_use_id, {
									toolName: event.tool_name,
									input: event.input
								});
							}
							// Forward session IDs to runtime state. The session event
							// arrives first, so this is also where we log the user
							// message — under the now-established session id, so it
							// lands in the same bucket /api/history reads back.
							if (event.type === 'session') {
								setSessionId(event.sessionId);
								if (providerId !== 'claude' && userMessage && !userMsgPersisted) {
									userMsgPersisted = true;
									dbAppendConversationEvent(event.sessionId, providerId, 'user_message', JSON.stringify({
										type: 'user_message', text: userMessage, timestamp: renderStart
									}));
								}
							}
							// Forward the event as-is to the SSE stream
							send(event.type, event);
							if (providerId !== 'claude' && event.type === 'tool_result') {
								const toolCall = toolInputsForHooks.get(event.tool_use_id);
								const hookEvent: HookEvent = event.is_error
									? 'PostToolUseFailure'
									: 'PostToolUse';
								await runUserHooksForEvent(hookEvent, emitHookRun, {
									toolName: toolCall?.toolName ?? '',
									toolInput: toolCall?.input
								});
							}
						}

						if (providerId !== 'claude' && !warmup) {
							await runUserHooksForEvent('Stop', emitHookRun);
						}

						return { usedDocMutationTool };
					}

					const feedbackThreadId = message.match(/thread_id="([^"]+)"/)?.[1] ?? null;
					// Per-render state lives in a scope that flows through the
					// awaits below, so a concurrent render cannot overwrite it
					// or clear it out from under this one on its way out.
					await runWithRenderScope(
						{
							feedbackThreadId,
							reviewerId: critiqueReviewer?.id ?? null,
							staleAcceptApply:
								staleAccept && typeof staleAccept.tabId === 'string' ? staleAccept : null
						},
						async () => {
					const firstOutcome = await runQueryRound(prompt, images);
					if (
						isImplicitWakeup &&
						activeInlineDirectives.length > 0 &&
						!firstOutcome.usedDocMutationTool
					) {
						const retryPrompt = buildMultiTabPrompt(
							active,
							buildTabPromptInfos(textTabs),
							[
								'You ended without proposing an edit, but the active tab still contains inline directives.',
								'Handle one now if you can. You may read other files first if that helps.',
								'If a directive cannot be completed yet, say why in a comment anchored to the directive text (comment_doc).',
								'Do not end this retry with neither an edit nor a comment.'
							].join('\n'),
							{ isUserMessage: false, previewTabs }
						);
						send('directive_retry', {});
						await runQueryRound(retryPrompt);
					}
						}
					);
				} catch (err) {
					// Plan-mode aborts the controller from canUseTool once we've
					// captured the plan — that surfaces as an AbortError here,
					// which is expected and should not show up as an error to
					// the user.
					const isPlanAbort = planMode && abortController.signal.aborted;
					if (!isPlanAbort) {
						send('error', { error: String(err) });
					}
				}

				// Update the last_seen baseline for every TEXT tab the agent
				// could have touched, using the NOW-authoritative content. The
				// next render will diff against these baselines — so a tab the
				// user edited mid-render gets its fresh content baked in, and
				// a tab the agent edited gets its post-edit content. Binary
				// tabs carry no baseline (they are never diffed).
				try {
					for (const id of textTabs) {
						writeLastSeen(id, readLiveTabMarkdown(id));
					}
				} catch (err) {
					send('error', { error: 'Failed to update last_seen baselines: ' + String(err) });
				}

				send('result', { activeTabId: active });
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
	} catch (err) {
		console.error('Render error:', err);
		return new Response(
			JSON.stringify({ error: 'Failed to render', detail: String(err) }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};
