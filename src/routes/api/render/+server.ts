import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn } from 'child_process';
import * as Y from 'yjs';
import {
	AGENT_SCRATCH_DIR,
	isValidTabId,
	tabKind
} from '$lib/server/document-files';
import {
	readHooks,
	resolveCommand,
	HOOK_EVENTS,
	type Hook,
	type HookEvent
} from '$lib/server/hooks-config';
import { getSessionId, setSessionId, getTabsState } from '$lib/server/runtime-state';
import { readMeta } from '$lib/server/document-io';
import { kvGet, kvSet } from '$lib/server/db-writes';
import { getTabYDoc } from '$lib/server/ydoc-registry';
import { serializeYDocToMarkdown } from '$lib/server/ydoc-markdown';
import { registerPendingAskUser } from '$lib/server/ask-user-state';
import { unifiedLineDiff } from '$lib/diff';
import { buildStyleReferencesPromptBlock } from '$lib/server/references';
import {
	docToolsMcp,
	EDIT_DOC_TOOL_NAME,
	READ_DOC_TOOL_NAME,
	WRITE_DOC_TOOL_NAME
} from '$lib/server/mcp-doc-tools';

/** Read the live authoritative markdown for a tab. Prefers the Hocuspocus
 * in-memory Document (which is what clients are synced to); falls back to
 * the registry Y.Doc (cold-start / no-client-connected state, which in turn
 * seeds from the workspace file via `seedYDocFromContent`). */
function readLiveTabMarkdown(tabId: string): string {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { documents?: { get(name: string): unknown } };
		};
	};
	const hp = holder.__docwriterWsServer?.hocuspocus;
	const liveDoc = hp?.documents?.get(tabId) as Y.Doc | undefined;
	const ydoc = liveDoc ?? getTabYDoc(tabId).ydoc;
	return serializeYDocToMarkdown(ydoc, tabKind(tabId));
}

const LAST_SEEN_PREFIX = 'last_seen:';

function lastSeenKey(tabId: string): string {
	return LAST_SEEN_PREFIX + tabId;
}

function agencyGuidance(
	agency: 'conservative' | 'balanced' | 'aggressive',
	anyDiff: boolean
): string {
	const diffClause = anyDiff
		? 'A diff above shows the user added something that needs a specific fix (typo, broken sentence, missing content they explicitly asked for).'
		: 'A file has an obvious problem (typo, broken sentence, missing content) that the user explicitly asked you to fix.';

	if (agency === 'aggressive') {
		return `**Be proactive.** Look for meaningful improvements — tighten wordy passages, clarify ambiguous sentences, strengthen weak verbs, improve flow between paragraphs. Default to MAKING an edit each round; only skip if every file is already clearly good and no directive asks for work.

Good reasons to edit:
1. A \`[[ note ]]\` directive in any file. Follow it, then delete the directive text.
2. ${diffClause}
3. The user's explicit message asks for an edit.
4. You can see a clear stylistic or clarity improvement you'd make if this were your own draft.

Still respect the user's voice — tighten, don't rewrite from scratch.`;
	}

	if (agency === 'balanced') {
		return `Make one focused improvement per round on whichever file clearly needs it. Don't tweak prose that's already fine; don't ignore obvious problems.

Make an edit if ONE of these is true:
1. A file contains a \`[[ note ]]\` directive asking for something specific. Follow it, then delete the directive text.
2. ${diffClause}
3. The user's explicit message above asks for an edit.
4. A sentence or passage has a clear correctness or clarity problem (broken grammar, confusing pronoun, a claim that contradicts earlier text).

If none apply, stop without editing.`;
	}

	// conservative
	return `**Default to NO edits.** The user is often just writing their own text. The right action most of the time is to stop without editing any file.

Only make an edit if ONE of these is clearly true:
1. A file contains a \`[[ note ]]\` directive asking for something specific. Follow it, then delete the directive text.
2. ${diffClause}
3. The user's explicit message above asks for an edit.

If none of those apply: exit without editing anything. Do NOT polish, do NOT reword, do NOT "improve" prose that is already fine. Do NOT make tiny stylistic tweaks on unchanged text. When in doubt, do nothing.`;
}

interface TabPromptInfo {
	tabId: string;
	currentMd: string;
	lastSeenMd: string | null;
}

/** Static instructions that never change between renders in a session. Sent
 * via the SDK's `systemPrompt` option so the Anthropic API caches them and
 * the per-render `prompt` only carries the dynamic file + rules + user
 * message content. Without this split, every render was re-sending ~5KB of
 * boilerplate and burning context + tokens. */
function buildSystemPrompt(hasPlain: boolean): string {
	const mixedNote = hasPlain
		? '\n\nSome files are **plain-text** (JSON, YAML, code, etc.). For those, preserve raw text exactly — DO NOT add markdown formatting like `**bold**`, `# headings`, or `- bullets`. Leave the contents faithful to their format.'
		: '';
	return `You are helping a human author maintain a set of text files. You may edit one, several, or none of them per round.${mixedNote}

## How to edit

- For the **open tab files** shown in each user turn, use \`edit_doc\` / \`write_doc\` / \`read_doc\` (NOT the built-in Edit / Write / Read). The \`path\` argument should be the tab id (shown in bold as \`\\\`tabid\\\`\`) or the absolute path shown in each file's "Path:" line.
- \`edit_doc({ path, old_string, new_string })\` replaces exactly one occurrence. Fails if \`old_string\` is not found or matches more than once — in that case call \`read_doc(path)\` to see the current content and retry.
- \`write_doc({ path, content })\` replaces the file's entire content. Only works for already-open tabs; does NOT create new ones.
- \`read_doc(path)\` returns the live content of an open tab.
- Each \`edit_doc\` / \`write_doc\` call lands atomically into the user's live document and shows up as a reviewable round in the outline. Its tool_result reflects reality (success = the user now sees your change).
- For files outside the open-tab list, read with the built-in \`Read\` / \`Glob\` / \`Grep\`, and for your scratch workspace under \`${AGENT_SCRATCH_DIR}/\` you may use either \`edit_doc\` / \`write_doc\` / \`read_doc\` (they fall through to plain filesystem I/O on scratch paths) or the built-in \`Edit\` / \`Write\` tools.
- Preserve the user's voice — don't rewrite sentences that aren't broken.
- Do NOT create new tab files. Only edit the files listed above.
- If the user's message is about the active file, prefer editing that one. Edit other files when the request genuinely spans them.
- Do NOT write a summary. Edit silently and stop.

## When to ask instead of edit

If the request is genuinely ambiguous and has multiple reasonable directions (tone, structure, which of several things to fix first), call \`AskUserQuestion\` with 2–4 concrete options BEFORE editing. Use it sparingly — only when a judgment call would otherwise be a guess. Never use it for questions the user can already see the answer to in their own text.

## What you can read vs. what you can write

- **Read**: anywhere in the workspace. Use the built-in \`Read\` / \`Glob\` / \`Grep\` to explore the project freely (existing docs, references, code, hooks.json, whatever helps). For the open tabs shown in each user turn, prefer \`read_doc(path)\` — it returns the live Y.Doc content instead of whatever is on disk.
- **Write / Edit** has two channels:
  1. **Open tabs** — use \`edit_doc\` / \`write_doc\` exclusively, with the tab id as \`path\`. These land in the live Y.Doc and become the user's reviewable round. The built-in \`Edit\` / \`Write\` tools are intentionally disabled for this render.
  2. **Your scratch space** at \`${AGENT_SCRATCH_DIR}/\` — any path under here. Use it for drafts, outlines, notes-to-self, intermediate passes. Either \`edit_doc\` / \`write_doc\` (they fall through to plain file I/O on scratch paths) or a subagent's shell tools work. Not surfaced to the user; persists across rounds in the same session; wiped on "New session". Think of it as your working memory.
- For adding **hooks** → call \`propose_hook\`. For **rules** → \`propose_rule\`. Don't try to edit \`.docwriter/hooks.json\` directly.

## When to use subagents (Agent tool)

You have the \`Agent\` tool (formerly \`Task\`; both names work). Use your judgment on when to fan out work to subagents — it's not free (each subagent is a full LLM call), but it can parallelise and isolate independent edits.

Rough heuristics (guidelines, not rules):

- **Small job → do it yourself.** Short files, one rule, one targeted edit: just call \`edit_doc\` directly. No subagent overhead.
- **Multi-rule review across a long file → consider fanning out.** If the user asked you to apply 3+ rules to a file with thousands of words, spawning one subagent per rule (or per cluster of related rules) lets each focus narrowly. Each subagent gets the rule(s), scans the files, and calls \`edit_doc\`.
- **Big independent chunks → consider chunked subagents.** If a single file is very long and the work splits cleanly by section (e.g. "tighten each chapter"), you can spawn one subagent per chunk.
- **Don't fan out dependent work.** If rule B depends on rule A being applied first, or if edits need to stay coherent across the whole file, do it yourself sequentially.

When you spawn a subagent, give it:
- The specific rule(s) or chunk it owns
- The exact file paths it can edit via \`edit_doc\` (from the Files section above)
- A clear stop condition ("fix violations, don't rewrite prose that's already fine")

Otherwise, default to doing the work yourself.

## Proposing rules

If — and ONLY if — you notice a consistent pattern in how the user writes or edits (e.g. the user repeatedly removes em-dashes, always uses the Oxford comma, never starts sentences with "So"), call the \`propose_rule\` tool exactly once per render to suggest adding it as a persistent rule. The user will review your proposal in the sidebar and Accept or Reject.

There is one important exception: if the user's message explicitly states a durable standing preference in general terms — for example "never use X", "always prefer Y", "I never want to see Z", "don't ever say..." — you MAY propose that as a rule immediately, even if it appears only once, as long as it is clearly meant as an ongoing preference rather than a one-off fix to one sentence.

Good rule proposals:
- Evidence-based: either you saw the pattern in the user's own edits (e.g. the diff shows them removing em-dashes repeatedly), OR the user explicitly stated a durable style preference in general terms ("never use X", "always prefer Y").
- Short and imperative: "Never use em-dashes", "Prefer active voice", "Use sentence case for headings".
- Specific enough to be actionable. NOT vague like "Write better" or "Improve clarity".

Do NOT propose a rule from a one-off message unless it is clearly phrased as a standing preference. If it's just a local request about one passage, do not promote it to a persistent rule. Err on the side of not proposing — proposing too often is annoying.`;
}

/** Build the per-render user prompt. Only the DYNAMIC content goes here —
 * files + rules + agency guidance + the user's message. Static instructions
 * are in the systemPrompt (see `buildSystemPrompt`).
 *
 * Content-inlining policy:
 *   - Active tab: full content + diff against `last_seen` (if any).
 *   - Non-active tab with changes: path + diff only (no full content).
 *   - Non-active tab with no changes: path only.
 *   - First-render tab (no `last_seen`): full content inlined.
 *
 * For tabs the agent needs the full content of but didn't inline, it can
 * call `read_doc(path)` — free in-process fetch against the live Y.Doc.
 */
function buildMultiTabPrompt(
	activeTabId: string,
	tabs: TabPromptInfo[],
	userMessage: string
): string {
	const meta = readMeta();
	const rules = meta.rules.map((r) => `- ${r.text}`).join('\n') || 'None';
	const agency = meta.agentSettings.agency;
	const styleReferencesBlock = buildStyleReferencesPromptBlock();

	const tabSections = tabs
		.map(({ tabId, currentMd, lastSeenMd }) => {
			const kind = tabKind(tabId);
			const isActive = tabId === activeTabId;
			const hasLastSeen = lastSeenMd !== null;
			const hasDiff = hasLastSeen && lastSeenMd !== currentMd;
			const kindNote =
				kind === 'plain'
					? ' (**plain text** — preserve it as-is; do NOT add markdown formatting)'
					: ' (markdown)';
			const fence = kind === 'markdown' ? 'markdown' : 'text';
			const star = isActive ? '⭐ ' : '';
			const activeNote = isActive ? ' (active — the user is currently looking at this one)' : '';
			const header = `### ${star}\`${tabId}\`${kindNote}${activeNote}\n\nPath (use as \`path\` argument to edit_doc / write_doc / read_doc): \`${tabId}\``;

			// Active tab or first-render tab: inline full content.
			if (isActive || !hasLastSeen) {
				const diffBlock = hasDiff
					? `\n\n**User changes since your last edit:**\n\`\`\`diff\n${unifiedLineDiff(lastSeenMd as string, currentMd)}\n\`\`\``
					: '';
				return `${header}\n\n\`\`\`${fence}\n${currentMd}\n\`\`\`${diffBlock}`;
			}

			// Non-active tab WITH changes: path + diff only.
			if (hasDiff) {
				return `${header}\n\n**User changes since your last edit:**\n\`\`\`diff\n${unifiedLineDiff(lastSeenMd as string, currentMd)}\n\`\`\`\n\nFull content not inlined — call \`read_doc("${tabId}")\` if you need it.`;
			}

			// Non-active tab with no changes: path only.
			return `${header}\n\nUnchanged since your last edit. Full content not inlined — call \`read_doc("${tabId}")\` if you need it.`;
		})
		.join('\n\n');

	const anyDiff = tabs.some(
		({ currentMd, lastSeenMd }) => lastSeenMd !== null && lastSeenMd !== currentMd
	);
	const agencyBlock = agencyGuidance(agency, anyDiff);

	return `## Files (${tabs.length})

${tabSections}

Tabs without full content inlined above: call \`read_doc(path)\` to fetch the current content if you need it. \`read_doc\` is free — the server holds the Y.Doc in-process, no network round-trip.

${styleReferencesBlock ? `${styleReferencesBlock}\n\n` : ''}## What the user wants

${userMessage}

## Rules to obey

${rules}

## How to decide whether to edit

${agencyBlock}`;
}

/**
 * In-process MCP server exposing the `propose_rule` tool. The agent calls it
 * to suggest a writing rule; the tool itself just ACKs — the real side-effect
 * happens in the stream handler, which detects the tool invocation and emits
 * a dedicated `rule_proposal` SSE event so the client can render an
 * Accept/Reject card in the OutlinePane.
 */
const docwriterMcp = createSdkMcpServer({
	name: 'docwriter',
	version: '0.0.1',
	tools: [
		tool(
			'propose_rule',
			'Propose a writing rule for the user to review. Use sparingly — only when you have evidence of a consistent pattern in the user\'s writing or edits. The user will Accept or Reject.',
			{
				text: z
					.string()
					.describe('The rule, written as a short imperative: "Never use em-dashes", "Prefer active voice".'),
				reason: z
					.string()
					.optional()
					.describe('One sentence explaining the pattern you observed.')
			},
			async () => ({
				content: [{ type: 'text', text: 'Rule proposal sent to the user for review.' }]
			})
		),
		tool(
			'propose_hook',
			'Propose a shell hook for the user to review before it gets added to the workspace. Use when the user asks for an automation (e.g. "run pdflatex after every edit", "open preview on accept") — DO NOT edit .docwriter/hooks.json directly, propose the hook instead so the user can Accept/Reject.',
			{
				event: z
					.enum([
						'PreToolUse',
						'PostToolUse',
						'PostToolUseFailure',
						'UserPromptSubmit',
						'Stop',
						'SubagentStop',
						'SessionStart',
						'SessionEnd',
						'Notification'
					])
					.describe(
						'When the hook fires. PostToolUse = after a tool call (most common, for pdflatex/lint/etc). PreToolUse = before. PostToolUseFailure = when a tool errors. UserPromptSubmit = when the user sends a message. Stop = end of response. SubagentStop = a subagent finished. SessionStart/End = session boundaries. Notification = permission/idle messages.'
					),
				matcher: z
					.string()
					.optional()
					.describe('Regex over the tool name (e.g. "Edit|Write"). Omit or empty to match every tool.'),
				command: z
					.string()
					.describe('The shell command. Use {{file}} for the edited file path and {{tool}} for the tool name.'),
				reason: z
					.string()
					.optional()
					.describe('One sentence explaining what this hook does / why the user would want it.')
			},
			async () => ({
				content: [{ type: 'text', text: 'Hook proposal sent to the user for review.' }]
			})
		)
	]
});

/** Names the SDK will give the tools in stream events. SDK MCP tools are
 * namespaced as `mcp__<serverName>__<toolName>`. */
const PROPOSE_RULE_TOOL_NAME = 'mcp__docwriter__propose_rule';
const PROPOSE_HOOK_TOOL_NAME = 'mcp__docwriter__propose_hook';
/** Built-in SDK tool for multiple-choice user clarification questions.
 * We intercept it in canUseTool, surface the questions to the browser
 * via an SSE event, and resolve the canUseTool promise with the user's
 * selections when they arrive back via /api/ask-user-reply. */
const ASK_USER_TOOL_NAME = 'AskUserQuestion';

type HookRunEmitter = (entry: {
	hookId: string;
	event: string;
	command: string;
	status: 'running' | 'done' | 'failed';
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}) => void;

/** Spawn a shell command, capture output (clipped), and emit start/end
 * events via `emit`. Resolves when the process exits. */
function runHookCommand(
	hook: Hook,
	toolName: string,
	filePath: string | undefined,
	emit: HookRunEmitter
): Promise<void> {
	return new Promise((resolve) => {
		const command = resolveCommand(hook.command, { tool: toolName, file: filePath });
		const startedAt = Date.now();
		emit({ hookId: hook.id, event: hook.event, command, status: 'running' });

		const child = spawn(command, {
			shell: true,
			cwd: process.env.DOCWRITER_ROOT || process.cwd(),
			env: process.env
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (c) => {
			stdout += c.toString();
			if (stdout.length > 2000) stdout = stdout.slice(-2000);
		});
		child.stderr?.on('data', (c) => {
			stderr += c.toString();
			if (stderr.length > 2000) stderr = stderr.slice(-2000);
		});
		child.on('error', (err) => {
			emit({
				hookId: hook.id,
				event: hook.event,
				command,
				status: 'failed',
				stderr: err.message,
				durationMs: Date.now() - startedAt
			});
			resolve();
		});
		child.on('exit', (code) => {
			emit({
				hookId: hook.id,
				event: hook.event,
				command,
				status: code === 0 ? 'done' : 'failed',
				exitCode: code ?? -1,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt
			});
			resolve();
		});
	});
}

/** Default timeout for user-configured hook commands (seconds). Matches the
 * SDK default; keeps slow runaway commands from blocking the agent. */
const USER_HOOK_TIMEOUT_SEC = 60;

type HookEntry = { matcher: string; hooks: HookCallback[]; timeout?: number };

/** Build the hook map for this render. Only user-defined shell hooks are
 * wired in — the legacy PreToolUse / PostToolUse internal hooks that
 * synced shadow files and streamed partial applies are gone (Phase 5+6).
 * Agent writes to open tabs go through `edit_doc` / `write_doc`, which
 * mutate the live Y.Doc atomically and stream to the browser directly. */
function buildHooks(
	emitHookRun: HookRunEmitter
): Partial<Record<HookEvent | 'PreToolUse', HookEntry[]>> {
	const userHooks = readHooks().hooks.filter((h) => h.enabled !== false);

	function buildUserHookCallback(hook: Hook): HookCallback {
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
					if (!new RegExp(hook.matcher).test(toolName)) return {};
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
		const { userMessage, model, warmup, tab } = body as {
			userMessage?: string;
			model?: string;
			warmup?: boolean;
			tab?: string;
		};

		const active = tab || getTabsState().active;
		if (!active || !isValidTabId(active)) {
			throw error(400, 'No active tab');
		}

		const allTabIds = getTabsState().order;
		if (!allTabIds.includes(active)) {
			throw error(400, `Active tab "${active}" not found on disk`);
		}

		// Snapshot each tab's live authoritative content + its last-seen
		// baseline from kv. The agent gets a prompt built off this snapshot
		// and post-render we write each tab's (new) current content back
		// into kv so the next render diffs cleanly.
		const tabsForPrompt: TabPromptInfo[] = allTabIds.map((id) => ({
			tabId: id,
			currentMd: readLiveTabMarkdown(id),
			lastSeenMd: kvGet(lastSeenKey(id))
		}));

		const currentSessionId = getSessionId();
		const message =
			userMessage ||
			"The user clicked Wake-up without a specific request. Decide what (if anything) to do per the agency guidance above.";
		const prompt = warmup
			? `You are a writing assistant. The user has a set of files open as tabs. Acknowledge you're ready in 1-2 sentences. Don't edit anything.`
			: buildMultiTabPrompt(active, tabsForPrompt, message);
		const hasPlain = tabsForPrompt.some(({ tabId }) => tabKind(tabId) === 'plain');
		const systemPromptBlock = warmup ? undefined : buildSystemPrompt(hasPlain);

		const abortController = new AbortController();
		request.signal.addEventListener('abort', () => abortController.abort());

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const renderStart = Date.now();

				function send(event: string, data: unknown) {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify({ ...(data as object), _elapsed: Date.now() - renderStart })}\n\n`
						)
					);
				}

				const hooks = buildHooks((entry) => send('hook_run', entry));

				let currentToolName = '';
				let currentToolId = '';
				let toolInputAccum = '';

				try {
					// Resolve the model: per-request > CLI default > nothing (SDK picks).
					const resolvedModel =
						model || process.env.DOCWRITER_DEFAULT_MODEL || undefined;

					const queryOptions: any = {
						allowedTools: warmup
							? ['Read', 'Glob', 'WebSearch', 'WebFetch']
							: [
									// Built-in Edit/Write intentionally omitted — tab
									// edits go through the custom MCP tools
									// (edit_doc/write_doc/read_doc) so the agent's
									// tool_result reflects what the user sees. Built-in
									// Read is kept because the agent may want to look at
									// files outside the open-tab set.
									'Read',
									'Bash',
									'Glob',
									'Grep',
									'WebSearch',
									'WebFetch',
									// Subagent invocation: renamed from Task → Agent in
									// Claude Code v2.1.63. Include both for SDK version
									// compatibility (init list still references Task).
									'Agent',
									'Task',
									PROPOSE_RULE_TOOL_NAME,
									PROPOSE_HOOK_TOOL_NAME,
									ASK_USER_TOOL_NAME,
									EDIT_DOC_TOOL_NAME,
									READ_DOC_TOOL_NAME,
									WRITE_DOC_TOOL_NAME
								],
						mcpServers: { docwriter: docwriterMcp, 'docwriter-doc': docToolsMcp },
						// 'user' lets the SDK pick up Claude.ai subscription credentials
						// stored by `claude login` (in addition to ANTHROPIC_API_KEY).
						settingSources: ['user', 'project'],
						permissionMode: 'acceptEdits',
						includePartialMessages: true,
						agentProgressSummaries: true,
						abortController,
						hooks,
						// Intercept AskUserQuestion: surface the questions to the
						// browser, wait for the user's selections, inject them into
						// the tool call's `updatedInput`. Every other tool passes
						// through with `allow` + no modification.
						canUseTool: async (toolName: string, toolInput: any) => {
							if (toolName !== ASK_USER_TOOL_NAME) {
								return { behavior: 'allow' as const, updatedInput: toolInput };
							}
							const id =
								'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
							const questions = toolInput?.questions ?? [];
							send('user_question', { id, questions });
							const answers = await new Promise<string[]>((resolve) => {
								registerPendingAskUser(id, resolve, 15 * 60_000);
							});
							return {
								behavior: 'allow' as const,
								updatedInput: { ...toolInput, answers }
							};
						},
						...(resolvedModel ? { model: resolvedModel } : {}),
						...(currentSessionId ? { resume: currentSessionId } : {}),
						// Static boilerplate lives here (how-to-edit, tool rules,
						// sandbox, subagents, propose_rule protocol). Anthropic
						// caches the system prompt, so we're not re-paying for
						// it every render. Per-turn prompt only carries dynamic
						// content (files, rules, agency, user message).
						...(systemPromptBlock ? { systemPrompt: systemPromptBlock } : {})
					};

					// Scratch workspace is created lazily (by `mcp-doc-tools`
					// on the first scratch write). No render-start mkdir here
					// — otherwise a `.docwriter/agent/` dir gets created on
					// every render even when the agent never writes scratch.
					for await (const msg of query({ prompt, options: queryOptions })) {
						if (msg.type === 'system' && msg.session_id) {
							setSessionId(msg.session_id);
							send('session', { sessionId: msg.session_id });
						}

						if (msg.type === 'system') {
							const anyMsg = msg as any;
							if (anyMsg.subtype === 'status') {
								send('sdk_status', {
									status: anyMsg.status,
									compactResult: anyMsg.compact_result,
									error: anyMsg.compact_error
								});
							} else if (anyMsg.subtype === 'notification') {
								send('sdk_notification', {
									text: anyMsg.text,
									priority: anyMsg.priority
								});
							} else if (anyMsg.subtype === 'task_started' && !anyMsg.skip_transcript) {
								send('task_event', {
									taskId: anyMsg.task_id,
									phase: 'started',
									description: anyMsg.description,
									taskType: anyMsg.task_type
								});
							} else if (anyMsg.subtype === 'task_progress') {
								send('task_event', {
									taskId: anyMsg.task_id,
									phase: 'progress',
									description: anyMsg.description,
									summary: anyMsg.summary,
									lastToolName: anyMsg.last_tool_name
								});
							} else if (anyMsg.subtype === 'task_updated') {
								send('task_event', {
									taskId: anyMsg.task_id,
									phase: 'updated',
									description: anyMsg.patch?.description,
									summary: anyMsg.patch?.error,
									taskType: anyMsg.patch?.status
								});
							} else if (anyMsg.subtype === 'task_notification' && !anyMsg.skip_transcript) {
								send('task_event', {
									taskId: anyMsg.task_id,
									phase: anyMsg.status,
									summary: anyMsg.summary
								});
							}
						}

						if (msg.type === 'tool_progress') {
							const anyMsg = msg as any;
							send('tool_progress', {
								tool_name: anyMsg.tool_name,
								elapsedSeconds: anyMsg.elapsed_time_seconds,
								taskId: anyMsg.task_id
							});
						}

						// SDK `result` message carries per-round cost + usage.
						// See https://code.claude.com/docs/en/agent-sdk/cost-tracking
						if (msg.type === 'result') {
							const anyMsg = msg as any;
							send('cost', {
								totalCostUsd: anyMsg.total_cost_usd,
								durationMs: anyMsg.duration_ms,
								durationApiMs: anyMsg.duration_api_ms,
								numTurns: anyMsg.num_turns,
								usage: anyMsg.usage,
								subtype: anyMsg.subtype
							});
						}

						if (msg.type === 'stream_event') {
							const event = msg.event;
							if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
								currentToolName = event.content_block.name;
								currentToolId = event.content_block.id;
								toolInputAccum = '';
								// Skip the generic tool_call_start for propose_* tools —
								// they emit their own dedicated events at stop time, so
								// we don't want them cluttering the agent activity log.
								if (currentToolName !== PROPOSE_RULE_TOOL_NAME && currentToolName !== PROPOSE_HOOK_TOOL_NAME) {
									send('tool_call_start', { tool_name: currentToolName, tool_use_id: currentToolId });
								}
							} else if (event.type === 'content_block_delta') {
								if (event.delta.type === 'text_delta') {
									send('assistant_text', { text: event.delta.text });
								} else if (event.delta.type === 'thinking_delta') {
									send('assistant_thinking', { text: event.delta.thinking });
								} else if (event.delta.type === 'input_json_delta') {
									toolInputAccum += event.delta.partial_json;
								}
							} else if (event.type === 'content_block_stop') {
								if (currentToolName) {
									let parsedInput: Record<string, unknown> = {};
									try { parsedInput = JSON.parse(toolInputAccum); } catch { /* ignore */ }
									if (currentToolName === PROPOSE_RULE_TOOL_NAME) {
										send('rule_proposal', {
											text: typeof parsedInput.text === 'string' ? parsedInput.text : '',
											reason: typeof parsedInput.reason === 'string' ? parsedInput.reason : undefined
										});
									} else if (currentToolName === PROPOSE_HOOK_TOOL_NAME) {
										const ev = parsedInput.event;
										const valid = HOOK_EVENTS.includes(ev as HookEvent) ? (ev as HookEvent) : 'PostToolUse';
										send('hook_proposal', {
											event: valid,
											matcher: typeof parsedInput.matcher === 'string' ? parsedInput.matcher : undefined,
											command: typeof parsedInput.command === 'string' ? parsedInput.command : '',
											reason: typeof parsedInput.reason === 'string' ? parsedInput.reason : undefined
										});
									} else {
										send('tool_call', { tool_name: currentToolName, tool_use_id: currentToolId, input: parsedInput });
									}
									currentToolName = '';
									currentToolId = '';
									toolInputAccum = '';
								}
							}
						}
					}
				} catch (err) {
					send('error', { error: String(err) });
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
