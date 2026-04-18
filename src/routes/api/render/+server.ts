import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn } from 'child_process';
import {
	tabAgentFile,
	parseTabIdFromAgentPath,
	AGENT_DIR,
	AGENT_SCRATCH_DIR,
	ensureAgentScratchDir,
	isAgentScratchPath,
	isValidTabId,
	tabKind
} from '$lib/server/document-files';
import { readHooks, resolveCommand, HOOK_EVENTS, type Hook, type HookEvent } from '$lib/server/hooks-config';
import { getSessionId, setSessionId, getTabsState } from '$lib/server/runtime-state';
import {
	readMeta,
	resetAllAgentDocs,
	readAllAgentDocs,
	readAgentDoc,
	syncUserEditsToAgent
} from '$lib/server/document-io';
import { startRender, endRender } from '$lib/server/document-lock';
import { registerPendingAskUser } from '$lib/server/ask-user-state';
import { unifiedLineDiff } from '$lib/diff';

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

/** Build a single prompt covering every open file. The active file is
 * flagged so the agent treats the user's message as primarily about that
 * file, but it can and should edit other files when the request spans
 * them (e.g. "pull the intro from `notes` into `document`"). Each file
 * section inlines current content plus, if present, a non-empty diff
 * since the last render. */
function buildMultiTabPrompt(
	activeTabId: string,
	tabs: Array<{ tabId: string; currentMd: string; lastMd: string | null }>,
	userMessage: string
): string {
	const meta = readMeta();
	const rules = meta.rules.map((r) => `- ${r.text}`).join('\n') || 'None';
	const agency = meta.agentSettings.agency;

	const tabSections = tabs
		.map(({ tabId, currentMd, lastMd }) => {
			const path = tabAgentFile(tabId);
			const kind = tabKind(tabId);
			const isActive = tabId === activeTabId;
			const hasDiff = lastMd !== null && lastMd !== currentMd;
			const diffBlock = hasDiff
				? `\n\n**User changes since last round:**\n\`\`\`diff\n${unifiedLineDiff(lastMd as string, currentMd)}\n\`\`\``
				: '';
			const kindNote =
				kind === 'plain'
					? ' (**plain text** — preserve it as-is; do NOT add markdown formatting)'
					: ' (markdown)';
			const fence = kind === 'markdown' ? 'markdown' : 'text';
			return `### ${isActive ? '⭐ ' : ''}\`${tabId}\`${kindNote}${isActive ? ' (active — the user is currently looking at this one)' : ''}

Path: \`${path}\`

\`\`\`${fence}
${currentMd}
\`\`\`${diffBlock}`;
		})
		.join('\n\n');

	const anyDiff = tabs.some(
		({ currentMd, lastMd }) => lastMd !== null && lastMd !== currentMd
	);
	const agencyBlock = agencyGuidance(agency, anyDiff);

	const hasPlain = tabs.some(({ tabId }) => tabKind(tabId) === 'plain');
	const mixedNote = hasPlain
		? '\n\nSome files are **plain-text** (JSON, YAML, code, etc.). For those, preserve raw text exactly — DO NOT add markdown formatting like `**bold**`, `# headings`, or `- bullets`. Leave the contents faithful to their format.'
		: '';

	return `You are helping a human author maintain a set of text files. You may edit one, several, or none of them per round.${mixedNote}

## Files (${tabs.length})

${tabSections}

## What the user wants

${userMessage}

## Rules to obey

${rules}

## How to decide whether to edit

${agencyBlock}

## How to edit

- Edit any file by calling the Edit tool with its path (shown above).
- The content is inlined above. Jump straight to Edit using that content. Only call Read if an Edit fails on \`old_string\` mismatch (meaning the user typed into the range you were targeting).
- Preserve the user's voice — don't rewrite sentences that aren't broken.
- Do NOT create new files. Only edit the files listed above.
- If the user's message is about the active file, prefer editing that one. Edit other files when the request genuinely spans them.
- Do NOT write a summary. Edit silently and stop.

## When to ask instead of edit

If the request is genuinely ambiguous and has multiple reasonable directions (tone, structure, which of several things to fix first), call \`AskUserQuestion\` with 2–4 concrete options BEFORE editing. Use it sparingly — only when a judgment call would otherwise be a guess. Never use it for questions the user can already see the answer to in their own text.

## What you can read vs. what you can write

- **Read**: anywhere in the workspace. Use Read, Glob, Grep to explore the project freely (existing docs, references, code, hooks.json, whatever helps).
- **Write / Edit** is sandboxed to two places. Everywhere else is hard-denied by a PreToolUse hook.
  1. **Open-file shadows** — the paths listed in the Files section above (under \`${AGENT_DIR}/\`). Edits here become the user's reviewable proposal.
  2. **Your scratch space** at \`${AGENT_SCRATCH_DIR}/\` — any path under here. Use it for drafts, outlines, notes-to-self, intermediate passes. Not surfaced to the user; persists across rounds in the same session; wiped on "New session". Think of it as your working memory.
- For adding **hooks** → call \`propose_hook\`. For **rules** → \`propose_rule\`. Don't try to edit \`.docwriter/hooks.json\` or anywhere outside the sandbox directly.

## When to use subagents (Agent tool)

You have the \`Agent\` tool (formerly \`Task\`; both names work). Use your judgment on when to fan out work to subagents — it's not free (each subagent is a full LLM call), but it can parallelise and isolate independent edits.

Rough heuristics (guidelines, not rules):

- **Small job → do it yourself.** Short files, one rule, one targeted edit: just Edit directly. No subagent overhead.
- **Multi-rule review across a long file → consider fanning out.** If the user asked you to apply 3+ rules to a file with thousands of words, spawning one subagent per rule (or per cluster of related rules) lets each focus narrowly. Each subagent gets the rule(s), scans the files, and makes the Edits.
- **Big independent chunks → consider chunked subagents.** If a single file is very long and the work splits cleanly by section (e.g. "tighten each chapter"), you can spawn one subagent per chunk.
- **Don't fan out dependent work.** If rule B depends on rule A being applied first, or if edits need to stay coherent across the whole file, do it yourself sequentially.

When you spawn a subagent, give it:
- The specific rule(s) or chunk it owns
- The exact file paths it can Edit (from the Files section above)
- A clear stop condition ("fix violations, don't rewrite prose that's already fine")

Otherwise, default to doing the work yourself.

## Proposing rules

If — and ONLY if — you notice a consistent pattern in how the user writes or edits (e.g. the user repeatedly removes em-dashes, always uses the Oxford comma, never starts sentences with "So"), call the \`propose_rule\` tool exactly once per render to suggest adding it as a persistent rule. The user will review your proposal in the sidebar and Accept or Reject.

Good rule proposals:
- Evidence-based: you saw the pattern in the user's own edits (e.g. the diff shows them removing em-dashes repeatedly).
- Short and imperative: "Never use em-dashes", "Prefer active voice", "Use sentence case for headings".
- Specific enough to be actionable. NOT vague like "Write better" or "Improve clarity".

Do NOT propose a rule just because the user said it once in a message. Wait until you see a real pattern. Err on the side of not proposing — proposing too often is annoying.`;
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

type IncrementalApplyEmitter = (entry: { tabId: string; agentMd: string }) => void;

function buildHooks(
	allowedTabIds: Set<string>,
	emitHookRun: HookRunEmitter,
	emitIncrementalApply: IncrementalApplyEmitter
): Partial<Record<HookEvent | 'PreToolUse', HookEntry[]>> {
	// Before each agent Edit/Write:
	//   1. If the target is an open tab's shadow (.docwriter/agent/<tabId>),
	//      sync the user's latest keystrokes into the shadow so the agent's
	//      edit lands on fresh text. Allow.
	//   2. If the target is under .docwriter/agent/scratch/, allow — this is
	//      the agent's private working dir for drafts / notes-to-self. Not
	//      surfaced to the user, persists across rounds in the same session.
	//   3. Otherwise hard-deny. Read/Glob/Grep stay unrestricted; this is
	//      purely a write guard.
	const preEdit: HookCallback = async (input) => {
		const inp = input as any;
		if (inp.hook_event_name !== 'PreToolUse') return {};
		const toolInput = inp.tool_input;
		const filePath: string | undefined = toolInput?.file_path;
		if (!filePath) return {};

		// (2) Scratch writes: always allowed.
		if (isAgentScratchPath(filePath)) return {};

		// (1) Open-tab shadow: sync user deltas, allow.
		const tabId = parseTabIdFromAgentPath(filePath);
		if (tabId && allowedTabIds.has(tabId)) {
			await syncUserEditsToAgent(tabId);
			return {};
		}

		// (3) Everywhere else: hard-deny.
		return {
			systemMessage:
				`Write blocked: you can Edit/Write open-tab shadows under ` +
				`\`${AGENT_DIR}/\` and anywhere under \`${AGENT_SCRATCH_DIR}/\` ` +
				`(your scratch space). For hooks/rules, call propose_hook / ` +
				`propose_rule instead of editing files directly.`,
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason:
					`Write blocked: ${filePath} is outside the agent's sandbox. ` +
					`Allowed: shadow paths for currently-open tabs, or anywhere ` +
					`under ${AGENT_SCRATCH_DIR}/.`
			}
		};
	};

	// After each agent Edit/Write, read the shadow for that tab and push
	// the current content to the client as an incremental_apply event.
	// This lets the editor stream agent edits in real time — you see each
	// Edit tool call land as it happens, instead of waiting for the whole
	// round to finish.
	//
	// Not a user-exposed hook — registered on the SDK directly, not stored
	// in .docwriter/hooks.json, and not surfaced in the history pane.
	const postEditStream: HookCallback = async (input) => {
		const toolInput = (input as any).tool_input;
		const filePath: string | undefined = toolInput?.file_path;
		if (!filePath) return {};
		const tabId = parseTabIdFromAgentPath(filePath);
		if (!tabId || !allowedTabIds.has(tabId)) return {};
		const agentMd = readAgentDoc(tabId);
		if (typeof agentMd === 'string') {
			emitIncrementalApply({ tabId, agentMd });
		}
		return {};
	};

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

	// Start every supported event as an empty bucket + our two internal
	// hooks (preEdit for user-delta sync, postEditStream for live apply).
	const buckets: Record<string, HookEntry[]> = {
		PreToolUse: [{ matcher: 'Edit|Write', hooks: [preEdit] }],
		PostToolUse: [{ matcher: 'Edit|Write', hooks: [postEditStream] }]
	};
	for (const ev of HOOK_EVENTS) {
		if (!buckets[ev]) buckets[ev] = [];
	}

	for (const h of userHooks) {
		const cb = buildUserHookCallback(h);
		// Tool-based events: pass the matcher through (SDK regexes on tool name).
		// For non-tool events, omit the matcher so the hook always fires.
		const toolEvent =
			h.event === 'PreToolUse' ||
			h.event === 'PostToolUse' ||
			h.event === 'PostToolUseFailure';
		const matcher = toolEvent && h.matcher && h.matcher.trim() ? h.matcher : '';
		buckets[h.event].push({ matcher, hooks: [cb], timeout: USER_HOOK_TIMEOUT_SEC });
	}

	// Drop empty buckets so we don't pass noise to the SDK.
	const out: Partial<Record<string, HookEntry[]>> = {};
	for (const [k, v] of Object.entries(buckets)) {
		if (v.length > 0) out[k] = v;
	}
	return out as Partial<Record<HookEvent | 'PreToolUse', HookEntry[]>>;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { userMessage, model, warmup, lastMarkdownByTab, tab } = body as {
			userMessage?: string;
			model?: string;
			warmup?: boolean;
			/** Map from tab id → last agentMd the client applied, per tab. Used
			 * to compute a per-tab "what changed since last round" diff. */
			lastMarkdownByTab?: Record<string, string>;
			tab?: string;
		};

		const active = tab || getTabsState().active;
		if (!active || !isValidTabId(active)) {
			throw error(400, 'No active tab');
		}

		// Reset EVERY tab's shadow to match its user doc — the deterministic
		// starting point for this render round. The agent can edit any of them.
		const allTabIds = resetAllAgentDocs();
		if (!allTabIds.includes(active)) {
			throw error(400, `Active tab "${active}" not found on disk`);
		}
		// Make sure the scratch sandbox exists so the agent can immediately
		// Write into it without a first-time mkdir failure.
		ensureAgentScratchDir();

		// Snapshot the user docs right now (same content as the freshly-reset
		// shadows) so we can compute "did the agent actually change this tab?"
		// at result time by diffing the shadow against this snapshot.
		const userDocsAtStart = readAllAgentDocs().reduce<Record<string, string>>(
			(acc, { tabId, userMd }) => {
				acc[tabId] = userMd;
				return acc;
			},
			{}
		);

		// Mark render active (document-lock). startRender only takes one seed
		// string because lastSyncedUserMd is shared across tabs for the duration
		// of a single render — which is fine because the PreToolUse hook looks
		// up the current user md per-tab each time it runs.
		startRender(userDocsAtStart[active] || '');

		const currentSessionId = getSessionId();
		const message = userMessage || "The user clicked Wake-up without a specific request. Decide what (if anything) to do per the agency guidance above.";
		const tabsForPrompt = allTabIds.map((id) => ({
			tabId: id,
			currentMd: userDocsAtStart[id] || '',
			lastMd: lastMarkdownByTab?.[id] ?? null
		}));
		const prompt = warmup
			? `You are a writing assistant. The user has a set of files under ${AGENT_DIR}/. Acknowledge you're ready in 1-2 sentences. Don't edit anything.`
			: buildMultiTabPrompt(active, tabsForPrompt, message);

		const abortController = new AbortController();
		request.signal.addEventListener('abort', () => abortController.abort());

		const allowedTabIds = new Set(allTabIds);

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const renderStart = Date.now();

				function send(event: string, data: unknown) {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...(data as object), _elapsed: Date.now() - renderStart })}\n\n`)
					);
				}

				const hooks = buildHooks(
					allowedTabIds,
					(entry) => send('hook_run', entry),
					(entry) => send('incremental_apply', entry)
				);

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
									'Read',
									'Edit',
									'Write',
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
									ASK_USER_TOOL_NAME
								],
						mcpServers: { docwriter: docwriterMcp },
						// 'user' lets the SDK pick up Claude.ai subscription credentials
						// stored by `claude login` (in addition to ANTHROPIC_API_KEY).
						settingSources: ['user', 'project'],
						permissionMode: 'acceptEdits',
						includePartialMessages: true,
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
						...(currentSessionId ? { resume: currentSessionId } : {})
					};

					for await (const msg of query({ prompt, options: queryOptions })) {
						if (msg.type === 'system' && msg.session_id) {
							setSessionId(msg.session_id);
							send('session', { sessionId: msg.session_id });
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

				// Final sync pass per tab, then emit one `edits` array listing
				// every tab whose shadow differs from its user doc at start.
				try {
					for (const id of allTabIds) {
						await syncUserEditsToAgent(id);
					}
					const finals = readAllAgentDocs();
					const edits = finals
						.filter(({ tabId, agentMd }) => (userDocsAtStart[tabId] ?? '') !== agentMd)
						.map(({ tabId, agentMd }) => ({ tabId, agentMd }));
					send('result', { activeTabId: active, edits });
				} catch (err) {
					send('error', { error: 'Failed to read agent docs: ' + String(err) });
				}
				endRender();

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
