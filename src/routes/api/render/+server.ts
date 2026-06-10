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
import { serializeYDoc, readReviewRounds, readCommentThreads } from '$lib/shared/ydoc-codec';
import type { CommentThread } from '$lib/types';
import { replayUpdatesInto } from '$lib/server/ydoc-persistence';
import { registerPendingAskUser } from '$lib/server/ask-user-state';
import { unifiedLineDiff } from '$lib/diff';
import { listStyleReferences } from '$lib/server/references';
import { materializePendingReviewText } from '$lib/review-rounds';
import {
	EDIT_DOC_TOOL_NAME,
	READ_DOC_TOOL_NAME,
	WRITE_DOC_TOOL_NAME,
	REPLY_TO_COMMENT_TOOL_NAME,
	setActiveFeedbackThreadId
} from '$lib/server/mcp-doc-tools';

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
		return materializePendingReviewText(serializeYDoc(liveDoc), readReviewRounds(liveDoc));
	}
	const ydoc = new Y.Doc();
	try {
		replayUpdatesInto(ydoc, tabId);
		return materializePendingReviewText(serializeYDoc(ydoc), readReviewRounds(ydoc));
	} finally {
		ydoc.destroy();
	}
}

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

const LAST_SEEN_PREFIX = 'last_seen:';
const GENERIC_WAKEUP_MESSAGE =
	'The user clicked Wake-up without a specific request. Decide what (if anything) to do per the agency guidance above.';
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

function lastSeenKey(tabId: string): string {
	return LAST_SEEN_PREFIX + tabId;
}

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
		'The user clicked Wake-up without a specific request.',
		'Use these inline directives (written by the user inline in the document, wrapped in `[[ ... ]]`, `(( ... ))`, or `<< ... >>`) as the most likely tasks to handle next.'
	];
	const activeDirectives =
		directivesByTab.find((entry) => entry.tabId === activeTabId) ?? null;
	if (activeDirectives) {
		lines.push('', `Active tab \`${activeDirectives.tabId}\`:`);
		for (const directive of activeDirectives.directives) {
			lines.push(`- ${directive}`);
		}
	}

	const otherDirectiveTabs = directivesByTab.filter((entry) => entry.tabId !== activeTabId);
	if (otherDirectiveTabs.length > 0) {
		lines.push('', 'Other open tabs with inline directives:');
		for (const entry of otherDirectiveTabs) {
			for (const directive of entry.directives) {
				lines.push(`- \`${entry.tabId}\`: ${directive}`);
			}
		}
	}

	lines.push(
		'',
		'Resolve a directive by replacing its `[[ ... ]]` / `(( ... )) `/ `<< ... >>` marker with the written-out result via `edit_doc` (no `thread_id` — each directive edit opens its own review thread). Read other files or use other tools first if that helps you resolve these correctly. For open tabs, use `read_doc`, `edit_doc`, and `write_doc` instead of the built-in file tools.'
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
	const ruleTexts = meta.rules.map((r) => r.text);
	const rulesBlock = ruleTexts.length > 0
		? ruleTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
		: 'None.';

	return `# Who you are

You are the user's writing collaborator — a sharp, opinionated editor and occasional co-author working on their text in this workspace. The user is the author. You serve their voice, not yours. Your job is to make their writing tighter, clearer, and more theirs — not to replace it with prose that sounds like every other LLM output.

## How to write & edit

- **Voice belongs to the user.** Match their cadence, vocabulary, sentence shape, paragraph rhythm, punctuation habits, idiosyncratic word choices. If they write short jabby sentences, don't smooth them into flowing periodic ones. If they use lowercase headings, don't title-case them. The "weird" parts of their writing are usually the voice — preserve them unless the user explicitly says otherwise.
- **Cut before you add.** Most writing improves by removing words, not adding them. Default to: cut > tighten > replace > rearrange > rewrite. A successful edit usually leaves the doc shorter or the same length, not longer.
- **Be surgical.** Touch the minimum prose needed to fix the thing the user actually flagged. If a sentence is broken, fix that sentence — don't repaint the surrounding paragraph because the new sentence "feels different now."
- **Concrete beats abstract; specific beats general.** When you do generate prose, prefer load-bearing verbs over adjective stacks, named things over categories, examples over claims. If you find yourself writing "various", "several", "a number of", "important", "powerful", "robust" — stop and replace with the specific thing.
- **No AI smell, ever.** Avoid em-dashes-as-default-punctuation, "It's not just X, it's Y", "Let's dive in", "delve into", "navigating the landscape of", "tapestry", "moreover/furthermore" stitching, "Certainly!"/"Absolutely!" openers, hedge-stacking ("might potentially possibly"), three-item rule-of-threes rhythm, hollow superlatives ("incredibly powerful", "truly remarkable"), throat-clearing intros, summary paragraphs that restate what you just said, and "in conclusion"-style endings. These are tells that turn writing into LLM output. The user will notice.
- **When in doubt, ask instead of editing.** If you're guessing about the user's intent, ask via \`AskUserQuestion\` — or, if the user has already opened a thread on this passage, reply there with \`reply_to_comment\`. Don't generate prose to fill the gap, and don't fabricate a comment thread (you can't open new ones — only the user can).

## File formats

Every file is treated as raw text — including \`.md\` / \`.markdown\`. The editor renders markdown source literally (no parsing into headings/lists/marks), so preserve whatever syntax the file already uses. If the file is JSON / YAML / code, keep it valid and faithful to its format. Don't add or strip markdown formatting unless that's exactly what the user asked for.

## How to edit

- For **any workspace file** — whether it's currently an open tab or not — use \`edit_doc\` / \`write_doc\` / \`read_doc\` (NOT the built-in Edit / Write). The \`path\` argument should be the tab id (shown in bold as \`\\\`tabid\\\`\`) or the absolute path shown in each file's "Path:" line.
- \`edit_doc({ path, old_string, new_string, replace_all?, thread_id? })\` replaces \`old_string\` with \`new_string\`. By default \`old_string\` must match exactly once; pass \`replace_all: true\` to replace every occurrence in a single proposal (good for renames / consistent term updates). If \`path\` points to a workspace file that isn't currently open, it's auto-opened as a new tab. Pass \`thread_id\` when you're **revising the edit a comment thread is about** (the user replied with feedback on a pending edit) — your new proposal lands inside that thread's card and supersedes its current pending edit. Omit \`thread_id\` for a fresh, unsolicited edit; the system opens a thread for it automatically. Base \`old_string\` on the CURRENT document text (what \`read_doc\` returns), never on your own earlier proposal.
- \`write_doc({ path, content })\` replaces the full content. If the file doesn't exist, write_doc creates it and opens it as a new tab (no review round for brand-new files). If the file exists, the write lands as a pending review proposal.
- \`read_doc(path)\` returns the current content of any workspace file. For an open tab, it's review-aware: the newest pending proposal if one exists, otherwise the committed content. For a workspace file that isn't currently a tab, it just reads the file from disk. Use it freely on any path the user mentions — don't pre-check whether the file is open.
- Each \`edit_doc\` / \`write_doc\` call on an existing file creates or updates a reviewable proposal round in the outline. The live document changes only when the user accepts that proposal.
- The built-in \`Edit\` / \`Write\` tools are restricted to your scratch workspace under \`${AGENT_SCRATCH_DIR}/\`. Use built-in \`Read\` / \`Glob\` / \`Grep\` freely anywhere in the workspace. The built-in \`Read\` tool can read image files (PNG, JPEG, GIF, WebP, etc.) — it returns them as image content blocks you can see and describe. Use it when the user references an image in the workspace.
- Preserve the user's voice — don't rewrite sentences that aren't broken.
- Do NOT create new tab files. Only edit the files listed above.
- If the user's message is about the active file, prefer editing that one. Edit other files when the request genuinely spans them.
- **Never use assistant text for substantive output.** Users do not read the agent history pane — it's a debug log, not a communication channel. Anything you want the user to actually see (an answer to their question, a discussion, a proposed direction, a "here's what I'd do" reflection, a follow-up question, a caveat) goes in a comment thread they opened, via \`reply_to_comment\` on the thread's \`thread_id\`. **You cannot start a new thread — that's the user's prerogative.** If there's no thread on the passage you want to discuss, you have three options: (1) make the edit and let the diff speak for itself, (2) call \`AskUserQuestion\` if you genuinely can't decide, or (3) stay silent. Assistant text should be empty, or at most a one-line ack like "Done." — and even then, prefer no text at all (the review cards / comment threads speak for themselves).

## When to ask instead of edit

If the request is genuinely ambiguous and has multiple reasonable directions (tone, structure, which of several things to fix first), call \`AskUserQuestion\` with 2–4 concrete options BEFORE editing. Use it sparingly — only when a judgment call would otherwise be a guess. Never use it for questions the user can already see the answer to in their own text.

## When to reply on a comment thread instead of edit

You have \`reply_to_comment\` (\`mcp__docwriter-doc__reply_to_comment\`). It posts a reply on a comment thread the **user** has already opened — similar to Google Docs comments. The user can reply, resolve the thread, or click "Approve & propose edit" on your reply to apply a change in a later turn.

**You cannot open new threads.** Only the user can start a thread (typically by giving feedback on a passage; the system opens the thread on their behalf and shows you its \`thread_id\`). If there's no thread for what you want to say, do not invent one — edit, ask via \`AskUserQuestion\`, or stay silent.

Reply WHEN there is an existing thread for the passage AND:

- You want to say *anything substantive* to the user that isn't a direct edit. Discussion, reflection, "I think X works but with one caveat…", proposed approaches, follow-up questions, "want me to draft Y?" offers — all of it goes in the thread, not in a message.
- The user's message is open-ended, questioning, or unsure — e.g. "idk what do you think about this opener?", "is this too long?", "does this land?", "any thoughts?", "maybe X?".
- The right next step is *a discussion*, not a change. You want to share a perspective, ask a follow-up, or propose a direction before committing to an edit.
- The user flagged a passage but didn't say what to do with it.

Do NOT reply WHEN:

- The user asked for a concrete change ("too verbose", "fix this typo", "rewrite for clarity"). Call \`edit_doc\` directly.
- The feedback is actionable enough to edit in \`[mode: auto]\` ("awk", "unclear", "too wordy", "tighten this", "make this land"). Call \`edit_doc\` and do not also reply.
- You're just narrating what you already edited. Review cards speak for themselves.
- There's no relevant existing thread. You cannot create one.

**The thread already has a pending edit (flagged "has a pending edit" in the Open threads list).** This is the common case and it has a strong default: the user opened/replied on this thread to react to an edit you proposed. Their reply is almost always feedback to act on — "not punchy", "too long", "try again", "more X", "still not right", "do it", "go ahead". In all of these, call \`edit_doc\` with this thread's \`thread_id\` to propose a REVISED edit that addresses the feedback (it supersedes the current one). Do NOT reply with conversational text like "Glad that landed!" or "resolve when you're ready" — that is not a substantive response to feedback on an edit. Reply on a pending-edit thread ONLY when the user is purely asking a question they expect a worded answer to ("why did you cut that?", "what's the difference?") and is clearly NOT requesting a change. When the feedback is contradictory or you genuinely can't tell what change they want, prefer \`AskUserQuestion\` over a chit-chat reply.

Mode override: the user can attach an explicit routing hint to a feedback message — **[mode: auto|edit|discuss]**. When you see \`[mode: edit]\`, do NOT call \`reply_to_comment\`; call \`edit_doc\`. When you see \`[mode: discuss]\`, do NOT call \`edit_doc\`; reply on the user's thread for that feedback via \`reply_to_comment\`. When you see \`[mode: auto]\` or no mode tag, use your judgment per the rules above: if the feedback can be resolved with a concrete edit, edit only; if the user is asking for judgment or discussion AND a thread exists, reply only. Do not combine \`edit_doc\` and \`reply_to_comment\` for the same feedback unless the user explicitly asks for both.

When replying:

- Speak in first person ("I'd cut the second clause …", "I think this works — the only snag is …"). Don't narrate as a third party.
- Keep replies to a few sentences. The thread is for conversation, not essays.
- If you want to sketch a concrete edit for the user to approve, pass \`proposed_edit\` — the UI turns it into an "Approve & propose edit" button.
- Always pass the existing thread's \`thread_id\`. Open thread transcripts are listed under each tab.

When the same user message carries both a clear directive AND ambient uncertainty ("rewrite this — actually, idk, what do you think?"), lean toward replying first (if there's a thread) and offering the edit in \`proposed_edit\`. Cheap to apply later, costly to rewrite past prose the user isn't sure they want rewritten. (This does NOT apply when the thread already has a pending edit — there, feedback means revise the edit, per the rule above.)

## What you can read vs. what you can write

- **Read**: anywhere in the workspace. Use the built-in \`Read\` / \`Glob\` / \`Grep\` to explore the project freely (existing docs, references, code, hooks.json, whatever helps). For the open tabs shown in each user turn, prefer \`read_doc(path)\` — it returns the current review-aware content instead of whatever is on disk.
- **Write / Edit** has two channels:
  1. **Workspace files** — use \`edit_doc\` / \`write_doc\` with the path as \`path\`. These auto-open the file as a tab if needed and create pending review rounds on existing content; brand-new files created via \`write_doc\` land as a new tab directly. The built-in \`Edit\` / \`Write\` tools are blocked outside scratch for this reason.
  2. **Your scratch space** at \`${AGENT_SCRATCH_DIR}/\` — any path under here. Use it for drafts, outlines, notes-to-self, intermediate passes. Either \`edit_doc\` / \`write_doc\` (they fall through to plain file I/O on scratch paths) or the built-in \`Edit\` / \`Write\` tools work. Not surfaced to the user; persists across rounds in the same session; wiped on "New session". Think of it as your working memory.
- For adding **hooks** → call \`propose_hook\`. For **rules** → \`propose_rule\`. Don't try to edit \`.docwriter/hooks.json\` directly.

## When to use subagents (Agent tool)

You have the \`Agent\` tool. Use your judgment on when to fan out work to subagents — it's not free (each subagent is a full LLM call), but it can parallelise and isolate independent edits.

Rough heuristics (guidelines, not rules):

- **Small job → do it yourself.** Short files, one rule, one targeted edit: just call \`edit_doc\` directly. No subagent overhead.
- **Multi-rule review across a long file → consider fanning out.** If the user asked you to apply 3+ rules to a file with thousands of words, spawning one subagent per rule (or per cluster of related rules) lets each focus narrowly. Each subagent gets the rule(s), scans the files, and calls \`edit_doc\`.
- **Big independent chunks → consider chunked subagents.** If a single file is very long and the work splits cleanly by section (e.g. "tighten each chapter"), you can spawn one subagent per chunk.
- **Don't fan out dependent work.** If rule B depends on rule A being applied first, or if edits need to stay coherent across the whole file, do it yourself sequentially.

When you spawn a subagent, give it:
- **The full \`## Rules to obey\` block from your current turn, pasted verbatim into the subagent's prompt.** Subagents do NOT inherit your dynamic prompt — only this system prompt — so if you don't paste the rules in, the subagent edits without them and may violate user preferences. Always include the rules, even if you think only some apply: a subagent narrowly focused on rule A still needs to know not to violate rule B in passing. If the rules block was "None", say so explicitly so the subagent doesn't go looking.
- The specific rule(s) or chunk it owns (in addition to the full rules list above — this is the focus, not a substitute)
- The exact file paths it can edit via \`edit_doc\` (from the Files section above)
- A clear stop condition ("fix violations, don't rewrite prose that's already fine")

Otherwise, default to doing the work yourself.

## Proposing rules

If — and ONLY if — you notice a consistent pattern in how the user writes or edits (e.g. the user repeatedly removes em-dashes, always uses the Oxford comma, never starts sentences with "So"), call the \`propose_rule\` tool exactly once per render to suggest adding it as a persistent rule. The user will review your proposal in the sidebar and Accept or Reject.

There is one important exception: if the user's message explicitly states a durable standing preference in general terms — for example "never use X", "always prefer Y", "I never want to see Z", "don't ever say..." — you MAY propose that as a rule immediately, even if it appears only once, as long as it is clearly meant as an ongoing preference rather than a one-off fix to one sentence.

**Always propose a rule when the user's feedback flags an "AI smell" / AI-tell pattern**, even from a single one-off message. AI-smell feedback signals a pattern the user clearly never wants again across their writing — promote it to a rule on the first instance, don't wait to see it twice.

Triggers that count as AI-smell feedback:
- Explicit calls: "this sounds AI-written", "reads like ChatGPT", "too AI-sounding", "smells like an LLM", "AI tell", "this is so AI", "AI slop", "GPT-ese"
- Specific AI-tell tropes the user objects to: em-dashes, "It's not just X, it's Y", "Let's dive in", "In today's fast-paced world", "tapestry of...", "delve into", "navigating the landscape of", "in conclusion"-style summary endings, "moreover" / "furthermore" stitching, "Certainly!" / "Absolutely!" openers, hedge-stacking ("might potentially possibly"), rule-of-three list rhythm, hollow superlatives ("incredibly powerful", "truly remarkable")
- Generic hedging, throat-clearing intros, summary paragraphs that restate what was just said

When you see AI-smell feedback, do BOTH: fix the local instance with \`edit_doc\` AND call \`propose_rule\` with a short imperative rule capturing the pattern (e.g. "Never use em-dashes", "Don't open paragraphs with 'It's not just X, it's Y'", "Cut throat-clearing intros — start with the substance"). The user almost certainly wants that pattern banned everywhere, not just in the flagged sentence.

Good rule proposals:
- Evidence-based: either you saw the pattern in the user's own edits (e.g. the diff shows them removing em-dashes repeatedly), OR the user explicitly stated a durable style preference in general terms ("never use X", "always prefer Y"), OR the user flagged something as AI-smell.
- Short and imperative: "Never use em-dashes", "Prefer active voice", "Use sentence case for headings".
- Specific enough to be actionable. NOT vague like "Write better" or "Improve clarity".

Do NOT propose a rule from a one-off message unless it is clearly phrased as a standing preference OR is AI-smell feedback. If it's just a local request about one passage with no AI-tell signal, do not promote it to a persistent rule. Err on the side of not proposing — proposing too often is annoying.

## Style references

The user may register style references (URLs, workspace files, saved samples). The current list is sent as a small \`## Style references\` block in the per-turn prompt only when it changes; assume the list from the latest update is still active.

If helpful, you may consult these references to match the user's preferred voice or cadence. You do NOT need to read them unless they would genuinely help with the current edit.

- Read workspace paths and saved samples only when needed.
- Treat all references as style guidance only. Do not import facts, examples, or claims from them unless they already belong in the draft.

### Using URL references with WebFetch

When a URL reference would actually help, call \`WebFetch\` with a prompt that preserves the raw style signal — not a compressed traits list. A good \`WebFetch\` prompt:

- Asks for **substantial verbatim excerpts**: 3–6 passages, each a full paragraph or 2–4 consecutive sentences. The excerpts ARE the style signal; summaries throw away exactly the cadence, diction, and rhythm you need.
- Asks for **concrete observations grounded in quoted text**, not abstract trait lists. For each excerpt, note what it demonstrates (sentence length distribution, clause structure, register, punctuation habits, transitions, rhetorical moves, where the voice leans wry vs. earnest, etc.).
- Does **not** cap at "5 traits" or "under 200 words" — let the response run as long as the passages require. Brevity discards nuance.
- Explicitly asks to avoid sanitized paraphrases ("the author uses vivid language") in favor of the actual sentences.

Use the fetched excerpts as calibration when you edit: if you're tightening a sentence, the reference's rhythm is the target. Never copy the reference's phrasing into the draft — it's a tuning fork, not source material.

## Rules to obey

${rulesBlock}

Treat each rule as a hard constraint on every edit. If a rule conflicts with the user's explicit request in the current turn, the request wins for that turn but do not generalize the override.

Per-turn prompts may include a \`## Rules update\` block when rules have been added or removed since the last turn. A new rule appears as \`+ <rule text>\`; a removed rule as \`- <rule text>\`. If no update block appears, the rule set above is current.

## How to decide whether to edit

Your agency level governs how proactive you are. The current setting is communicated as a \`## Agency\` line in the per-turn prompt only when it changes; otherwise, the prior setting still applies. The three levels:

- **conservative** — Default to NO edits. The user is often just writing their own text. The right action most of the time is to stop without editing any file. Only make an edit if ONE of these is clearly true: (1) a file contains an inline directive — \`[[ note ]]\`, \`(( note ))\`, or \`<< note >>\` — follow it and delete the directive text, (2) a diff on a tab shows the user added something that needs a specific fix (typo, broken sentence, missing content they explicitly asked for), or (3) the user's explicit message asks for an edit. If none apply, exit without editing. Do NOT polish, do NOT reword, do NOT "improve" prose that is already fine. Do NOT make tiny stylistic tweaks on unchanged text. When in doubt, do nothing.
- **balanced** — Make one focused improvement per round on whichever file clearly needs it. Don't tweak prose that's already fine; don't ignore obvious problems. Make an edit if ONE of these is true: (1) a file contains an inline directive (\`[[ ... ]]\`, \`(( ... ))\`, or \`<< ... >>\`) — follow it and delete the directive text, (2) a diff on a tab shows the user added something that needs a specific fix, (3) the user's explicit message asks for an edit, or (4) a sentence or passage has a clear correctness or clarity problem (broken grammar, confusing pronoun, a claim that contradicts earlier text). If none apply, stop without editing.
- **aggressive** — Be proactive. Look for meaningful improvements — tighten wordy passages, clarify ambiguous sentences, strengthen weak verbs, improve flow between paragraphs. Default to MAKING an edit each round; only skip if every file is already clearly good and no directive asks for work. Good reasons to edit: (1) an inline directive (\`[[ ... ]]\`, \`(( ... ))\`, or \`<< ... >>\`), (2) a user diff that needs a fix, (3) the user's explicit message asks for an edit, or (4) a clear stylistic or clarity improvement you'd make if this were your own draft. Still respect the user's voice — tighten, don't rewrite from scratch.

## Reading file content

No tab content is inlined in the per-turn prompt — only diffs since your last edit. Call \`read_doc(path)\` to fetch any tab's current content. It's free: the server holds the Y.Doc in-process, no network round-trip. Read whatever you actually need (often just the active tab or the one the user's message is about); don't preemptively fetch every tab.`;
}

/** Build the per-render user prompt. Only the DYNAMIC content goes here —
 * files + rules + agency guidance + the user's message. Static instructions
 * are in the systemPrompt (see `buildSystemPrompt`).
 *
 * Content-inlining policy: never inline full content. Every tab gets a
 * header (path + active marker if it's the focused tab) plus the diff
 * since the agent's `last_seen` baseline if there is one. The agent calls
 * `read_doc(path)` to fetch full content on demand — free in-process
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
	if (open.length === 0) return '';
	const pending = new Set(pendingEditThreadIds);
	const lines: string[] = [
		'',
		`Open threads (${open.length}) — each is a passage the user commented on. The comment is usually a REQUEST to revise that exact passage. To act on one, call \`edit_doc(thread_id="…")\` and edit the quoted text itself — NOT a different part of the document, and not an unrelated \`[[ ]]\` directive. Call \`list_threads("<tabId>")\` for the full conversation before acting.`
	];
	for (const thread of open) {
		const quote = thread.anchor.quote.replace(/\n+/g, ' ').slice(0, 120);
		const ellipsis = thread.anchor.quote.length > 120 ? '…' : '';
		const editNote = pending.has(thread.id)
			? ' — **has a pending edit.** A reply here is feedback on that edit: call `edit_doc` with `thread_id` set to this id to propose a REVISED edit of the quoted passage (it supersedes the current one). Do not reply with chit-chat unless the user is only asking a question.'
			: '';
		lines.push(`- \`${thread.id}\` — user commented on this passage: "${quote}${ellipsis}"${editNote}`);
	}
	return '\n' + lines.join('\n');
}

/** Compute a deterministic snapshot string for the active rule set. Used to
 * detect when rules have been added / removed between renders. */
function snapshotRules(rules: { text: string }[]): string {
	return JSON.stringify(rules.map((r) => r.text).sort());
}

/** Snapshot of the active style references (URL list, workspace paths, saved
 * sample paths). Sorted so cosmetic re-ordering doesn't trip the change detector. */
function snapshotRefs(): string {
	const refs = listStyleReferences().map((r) => `${r.type}::${r.target}`);
	return JSON.stringify(refs.sort());
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

	const lines: string[] = ['## Rules update', ''];
	if (priorJson === null) {
		// First render of the session — show full current list as "added".
		if (currentRuleTexts.length === 0) {
			lines.push('No active rules.');
		} else {
			for (const t of currentRuleTexts) lines.push(`+ ${t}`);
		}
	} else {
		for (const t of added) lines.push(`+ ${t}`);
		for (const t of removed) lines.push(`- ${t}`);
	}
	return lines.join('\n');
}

/** Build the active style-reference list as a small bullet block. Returned
 * only when the list has changed since the prior render. */
function buildRefsBlock(): string | null {
	const refs = listStyleReferences().slice(0, 6);
	if (refs.length === 0) return null;
	const lines = ['## Style references', ''];
	for (const ref of refs) {
		if (ref.type === 'url') {
			lines.push(`- URL: \`${ref.target}\`${ref.label !== ref.target ? ` (${ref.label})` : ''}`);
		} else {
			const kind = ref.type === 'stored-sample' ? 'Saved sample' : 'Workspace path';
			lines.push(`- ${kind}: \`${ref.target}\``);
		}
	}
	return lines.join('\n');
}

function buildMultiTabPrompt(
	activeTabId: string | null,
	tabs: TabPromptInfo[],
	userMessage: string
): string {
	const meta = readMeta();
	const currentRuleTexts = meta.rules.map((r) => r.text);
	const currentAgency = meta.agentSettings.agency;

	// Read prior snapshots so we can emit only the deltas. First render of a
	// session (snapshot absent) shows the full state — agent needs it once.
	const priorRulesJson = kvGet(KV_LAST_RULES);
	const priorRefsJson = kvGet(KV_LAST_REFS);
	const priorAgency = kvGet(KV_LAST_AGENCY);

	const currentRulesJson = snapshotRules(meta.rules);
	const currentRefsJson = snapshotRefs();

	const tabSections = tabs.length === 0
		? 'No files are open as tabs. Use `Read` / `Glob` / `Grep` to explore the workspace; use `edit_doc({ path, ... })` to edit, or `write_doc({ path, ... })` to create a file (the path argument is the workspace-relative path).'
		: tabs
				.map(({ tabId, currentMd, lastSeenMd, commentThreads, pendingEditThreadIds }) => {
					const isActive = tabId === activeTabId;
					const hasLastSeen = lastSeenMd !== null;
					const hasDiff = hasLastSeen && lastSeenMd !== currentMd;
					const activeNote = isActive ? ' [active]' : '';
					const header = `### \`${tabId}\`${activeNote}\n\nPath: \`${tabId}\``;
					const threadBlock = renderCommentThreadsBlock(commentThreads, pendingEditThreadIds);

					if (!hasLastSeen) {
						return `${header}\n\nNew — call \`read_doc("${tabId}")\` to read it.${threadBlock}`;
					}
					if (hasDiff) {
						return `${header}\n\nChanges:\n\`\`\`diff\n${unifiedLineDiff(lastSeenMd as string, currentMd)}\n\`\`\`${threadBlock}`;
					}
					return `${header}\n\nUnchanged.${threadBlock}`;
				})
				.join('\n\n');

	// Assemble the dynamic prompt: only the delta blocks + the user's message.
	// Static guidance (refs usage, rules meta, agency definitions, read_doc
	// reminder) lives in the system prompt and isn't re-sent here.
	const sections: string[] = [`## Files\n\n${tabSections}`];

	if (currentRefsJson !== priorRefsJson) {
		const refsBlock = buildRefsBlock();
		if (refsBlock) sections.push(refsBlock);
	}

	const rulesDelta = buildRulesDelta(currentRuleTexts, priorRulesJson);
	if (rulesDelta) sections.push(rulesDelta);

	if (currentAgency !== priorAgency) {
		sections.push(`Agency: ${currentAgency}`);
	}

	sections.push(`## Request\n\n${userMessage}`);

	// Persist the new snapshots for next turn's diff. Failures are swallowed —
	// at worst the next turn sends a redundant full block.
	try {
		kvSet(KV_LAST_RULES, currentRulesJson);
		kvSet(KV_LAST_REFS, currentRefsJson);
		kvSet(KV_LAST_AGENCY, currentAgency);
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
			const filePath: string | undefined = toolInput?.file_path;
			// For tool-based hooks, filter by matcher (regex over tool name).
			// For non-tool hooks (Stop, UserPromptSubmit, Session*, etc.) the
			// matcher is ignored here — the SDK handles event-type matching
			// via the top-level matcher on the hook entry.
			if (toolName && hook.matcher && hook.matcher.trim()) {
				try {
					// Case-insensitive so `Edit|Write` matches both the built-in
					// `Edit`/`Write` tools and the agent's MCP tool variants
					// like `mcp__docwriter-doc__edit_doc`.
					if (!new RegExp(hook.matcher, 'i').test(toolName)) return {};
				} catch {
					return {};
				}
			}
			await runHookCommand(hook, toolName, filePath, emitHookRun);
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
		const { userMessage, model, warmup, tab, planMode, images, provider: providerIdRaw } = body as {
			userMessage?: string;
			model?: string;
			warmup?: boolean;
			tab?: string;
			planMode?: boolean;
			images?: ImageAttachmentPayload[];
			provider?: string;
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
		// With no anchor (no tab) AND no user message, there's nothing to do
		// — the agent has no prompt context. Warmup is exempt because it's a
		// dry "are you alive?" ping.
		if (!active && !userMessage && !warmup) {
			throw error(400, 'No active tab and no message');
		}

		// Snapshot each tab's live authoritative content + its last-seen
		// baseline from kv. The agent gets a prompt built off this snapshot
		// and post-render we write each tab's (new) current content back
		// into kv so the next render diffs cleanly.
		const tabsForPrompt: TabPromptInfo[] = allTabIds.map((id) => ({
			tabId: id,
			currentMd: readLiveTabMarkdown(id),
			lastSeenMd: kvGet(lastSeenKey(id)),
			commentThreads: readLiveTabCommentThreads(id),
			pendingEditThreadIds: [...readLiveTabPendingEditThreadIds(id)]
		}));

		const currentSessionId = getSessionId();
		const isImplicitWakeup = !userMessage && !warmup;
		const activeTabInfo = tabsForPrompt.find((info) => info.tabId === active) ?? null;
		const activeInlineDirectives = activeTabInfo
			? extractInlineDirectives(activeTabInfo.currentMd)
			: [];
		const message =
			userMessage || buildImplicitWakeupMessage(active, tabsForPrompt);
		const planModeInstruction = planMode
			? [
					'',
					'## Plan-first mode (active)',
					'',
					'The user has explicitly asked for a plan BEFORE any edits. Do NOT call `edit_doc`, `write_doc`, or any mutation tool — they are unavailable this round.',
					'Read what you need with `read_doc` / `Read` / `Glob` / `Grep`, think through the change, then call the `ExitPlanMode` tool with your plan in the `plan` argument.',
					'The plan should be concise, markdown-formatted, and concrete — list the files you\'d touch and what you\'d change in each. After you call `ExitPlanMode` the run ends; the user will approve or reject the plan.'
				].join('\n')
			: '';
		const prompt = warmup
			? `You are a writing assistant. The user has a set of files open as tabs. Acknowledge you're ready in 1-2 sentences. Don't edit anything.`
			: buildMultiTabPrompt(active, tabsForPrompt, message) + planModeInstruction;
		const systemPromptBlock = warmup ? undefined : buildSystemPrompt();
		if (systemPromptBlock) setLastSystemPrompt(systemPromptBlock);
		const openTabPaths = new Set(allTabIds.map((tabId) => normalizeToolPath(tabFile(tabId))));

		const abortController = new AbortController();
		request.signal.addEventListener('abort', () => abortController.abort());

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const renderStart = Date.now();

				const persistableEvents = new Set([
					'assistant_text', 'assistant_thinking', 'tool_call_start',
					'tool_call', 'tool_result', 'cost', 'session', 'error',
					'rule_proposal', 'hook_proposal'
				]);

				function send(event: string, data: unknown) {
					const payload = { ...(data as object), _elapsed: Date.now() - renderStart };
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

				const hooks = buildHooks((entry) => send('hook_run', entry));

				try {
					const resolvedModel =
						model || process.env.DOCWRITER_DEFAULT_MODEL || undefined;

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
								message: 'Plan sent to the user for review. Stop — do not execute.'
							};
						}
						if (!warmup) {
							if (toolName === 'Read') {
								const matched = findReferencedOpenTabPath(toolInput?.file_path, openTabPaths);
								if (matched) {
									return { behavior: 'deny' as const, message: 'Open tab files must be read with `read_doc(path)`.' };
								}
							}
							if (toolName === 'Glob' || toolName === 'Grep') {
								const matched = findReferencedOpenTabPath(toolInput?.path, openTabPaths);
								if (matched) {
									return { behavior: 'deny' as const, message: 'Use `read_doc(path)` for open tab files.' };
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
							const answers = await new Promise<string[]>((resolve) => {
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
						'read_doc', 'reply_to_comment', 'list_threads'
					];
					const fullAllowedTools = [
						'Read', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent',
						'mcp__docwriter__propose_rule', 'mcp__docwriter__propose_hook',
						'AskUserQuestion', 'ExitPlanMode',
						EDIT_DOC_TOOL_NAME, READ_DOC_TOOL_NAME, WRITE_DOC_TOOL_NAME, REPLY_TO_COMMENT_TOOL_NAME,
						'edit_doc', 'read_doc', 'write_doc', 'reply_to_comment', 'list_threads',
						'propose_rule', 'propose_hook'
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
							effort: 'low',
							hooks
						}, tools)) {
							// Track mutation tool usage
							if (event.type === 'tool_call_start' && mutationToolNames.has(event.tool_name)) {
								usedDocMutationTool = true;
							}
							if (event.type === 'tool_call' && mutationToolNames.has(event.tool_name)) {
								usedDocMutationTool = true;
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
						}

						return { usedDocMutationTool };
					}

					const feedbackThreadId = message.match(/thread_id="([^"]+)"/)?.[1] ?? null;
					setActiveFeedbackThreadId(feedbackThreadId);
					try {
					const firstOutcome = await runQueryRound(prompt, images);
					if (
						isImplicitWakeup &&
						activeInlineDirectives.length > 0 &&
						!firstOutcome.usedDocMutationTool
					) {
						const retryPrompt = buildMultiTabPrompt(
							active,
							allTabIds.map((id) => ({
								tabId: id,
								currentMd: readLiveTabMarkdown(id),
								lastSeenMd: kvGet(lastSeenKey(id)),
								commentThreads: readLiveTabCommentThreads(id),
								pendingEditThreadIds: [...readLiveTabPendingEditThreadIds(id)]
							})),
							[
								'You just ended without proposing an edit, but the active tab still contains inline directives.',
								'Handle one active-tab directive now if it is feasible.',
								'You may still read other files or use other tools first if needed.',
								'Do not end this retry without either calling `edit_doc` or `write_doc`, or sending a brief explanation of why the directive cannot be completed yet.'
							].join('\n')
						);
						send('directive_retry', {});
						await runQueryRound(retryPrompt);
					}
					} finally {
						setActiveFeedbackThreadId(null);
					}
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

				// Update `last_seen:<tabId>` for every tab the agent could
				// have touched, using the NOW-authoritative content. The next
				// render will diff against these baselines — so a tab the
				// user edited mid-render gets its fresh content baked in,
				// and a tab the agent edited gets its post-edit content.
				try {
					for (const id of allTabIds) {
						const now = readLiveTabMarkdown(id);
						kvSet(lastSeenKey(id), now);
					}
				} catch (err) {
					send('error', { error: 'Failed to update last_seen kv: ' + String(err) });
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
