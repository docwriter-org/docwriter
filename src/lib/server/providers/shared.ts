/**
 * Shared helpers for the agent-provider adapters.
 *
 * Each provider (claude, openai, codex, cursor, pi) normalizes its SDK's
 * streaming events into `ProviderEvent`s. Several pieces of that plumbing were
 * copy-pasted across every adapter: permission/allow-list gating of tools,
 * rule/hook proposal-event mapping, lazy optional-SDK imports, and prompt/
 * status shaping. They live here once so the adapters stay thin and behave
 * identically.
 */
import type {
	ProviderEvent,
	ProviderQueryOptions,
	ToolDefinition,
	ToolResult
} from './types';
import { HOOK_EVENTS, type HookEvent } from '$lib/server/hooks-config';

// ── Tool gating (allowedTools + canUseTool) ─────────────────────────────────

/** Filter a provider-agnostic tool list down to `allowedTools`. When no list
 * is provided (or it's empty), every tool passes through unchanged. */
function filterAllowedTools(
	tools: ToolDefinition[],
	allowedTools?: string[]
): ToolDefinition[] {
	if (!allowedTools || allowedTools.length === 0) return tools;
	const allowed = new Set(allowedTools);
	return tools.filter((toolDef) => allowed.has(toolDef.name));
}

/**
 * Gate a provider's tool list through the same permission semantics codex
 * applied inline:
 *   1. Drop any tool not present in `options.allowedTools` (when provided).
 *   2. Wrap each remaining tool's `execute` so it consults
 *      `options.canUseTool(name, input)` FIRST:
 *        - `deny`  → return an error `ToolResult` carrying the deny message
 *                    (the tool never runs).
 *        - `allow` with `updatedInput` → run with the updated input.
 *        - otherwise → run with the original input.
 *
 * Providers that register these `ToolDefinition`s with their SDK (openai,
 * cursor, pi) get plan-mode's "mutation tools unavailable" filtering and the
 * scratch-only Edit/Write guard for free, matching codex. When `canUseTool`
 * is absent the tools are only filtered, not wrapped — identical to codex's
 * `options.canUseTool?.(...)` no-op path.
 */
export function wrapToolsForProvider(
	tools: ToolDefinition[],
	options: Pick<ProviderQueryOptions, 'allowedTools' | 'canUseTool'>
): ToolDefinition[] {
	const filtered = filterAllowedTools(tools, options.allowedTools);
	const canUseTool = options.canUseTool;
	if (!canUseTool) return filtered;
	return filtered.map((toolDef) => ({
		...toolDef,
		execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
			const permission = await canUseTool(toolDef.name, input);
			if (permission?.behavior === 'deny') {
				return {
					content: [{ type: 'text', text: permission.message }],
					isError: true
				};
			}
			const effectiveInput =
				permission?.behavior === 'allow' && permission.updatedInput
					? permission.updatedInput
					: input;
			return toolDef.execute(effectiveInput);
		}
	}));
}

// ── Proposal event mapping ──────────────────────────────────────────────────

/** Strip a `mcp__<server>__` namespace prefix to the bare tool name so both
 * the Claude SDK's namespaced names and the bare names the other providers use
 * resolve to the same key. */
function bareToolName(name: string): string {
	if (!name.startsWith('mcp__')) return name;
	const idx = name.lastIndexOf('__');
	return idx >= 0 ? name.slice(idx + 2) : name;
}

/**
 * Map a `propose_rule` / `propose_hook` tool call to the `rule_proposal` /
 * `hook_proposal` ProviderEvents the render endpoint expects. Returns `[]` for
 * any other tool. Accepts both bare (`propose_rule`) and namespaced
 * (`mcp__docwriter__propose_rule`) names. The hook `event` is validated against
 * `HOOK_EVENTS`, falling back to `PostToolUse` — preserving the Claude
 * adapter's existing coercion for every provider.
 */
export function emitProposalEvents(
	name: string,
	input: Record<string, unknown>
): ProviderEvent[] {
	const bare = bareToolName(name);
	if (bare === 'propose_rule') {
		return [
			{
				type: 'rule_proposal',
				text: typeof input.text === 'string' ? input.text : '',
				reason: typeof input.reason === 'string' ? input.reason : undefined
			}
		];
	}
	if (bare === 'propose_hook') {
		const ev = input.event;
		const validEvent: HookEvent = HOOK_EVENTS.includes(ev as HookEvent)
			? (ev as HookEvent)
			: 'PostToolUse';
		return [
			{
				type: 'hook_proposal',
				event: validEvent,
				matcher: typeof input.matcher === 'string' ? input.matcher : undefined,
				command: typeof input.command === 'string' ? input.command : '',
				reason: typeof input.reason === 'string' ? input.reason : undefined
			}
		];
	}
	return [];
}

// ── Lazy optional-SDK loading ───────────────────────────────────────────────

/**
 * Build a cached lazy loader for an optional provider SDK. `load` performs the
 * literal dynamic `import(...)` (kept in the calling module so the bundler
 * still sees a static specifier) and returns whatever the adapter needs. On
 * failure the loader throws `installHint` with the underlying error appended —
 * preserving each provider's exact "npm install …" message. The first
 * successful result is cached; failures are not, so a later call can retry.
 */
export function makeLazySdkLoader<T>(
	load: () => Promise<T>,
	installHint: string
): () => Promise<T> {
	let loaded = false;
	let cached: T;
	return async () => {
		if (loaded) return cached;
		try {
			cached = await load();
		} catch (err) {
			throw new Error(installHint + '\n' + (err as Error).message);
		}
		loaded = true;
		return cached;
	};
}

// ── Prompt + status helpers ─────────────────────────────────────────────────

/** Prepend the system prompt to the user prompt for providers without a
 * dedicated system-prompt channel (cursor, pi). */
export function combinePrompt(
	options: Pick<ProviderQueryOptions, 'systemPrompt' | 'prompt'>
): string {
	return options.systemPrompt
		? `${options.systemPrompt}\n\n${options.prompt}`
		: options.prompt;
}

/** The `cleared_stale_session` status event a provider emits when a resume
 * target is gone locally and it falls back to a fresh conversation. */
export function staleSessionEvent(providerLabel: string): ProviderEvent {
	return {
		type: 'sdk_status',
		status: 'cleared_stale_session',
		compactResult: `${providerLabel} was missing locally; starting a fresh conversation.`
	};
}
