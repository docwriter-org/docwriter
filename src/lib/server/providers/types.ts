/**
 * Provider-agnostic interface for agent SDK integrations.
 *
 * Each provider (Claude, OpenAI Codex, Cursor) implements `AgentProvider` and
 * normalizes its SDK's streaming events into `ProviderEvent`s that the render
 * endpoint consumes. The render endpoint is provider-agnostic — it iterates
 * the event stream and emits SSE to the browser without caring which SDK
 * produced the events.
 */

// ── Provider identification ─────────────────────────────────────────────────

export type ProviderId = 'claude' | 'openai' | 'cursor' | 'pi';

export interface ProviderModelOption {
	id: string;
	label: string;
	provider: ProviderId;
}

// ── Tool definitions (provider-agnostic) ────────────────────────────────────

export interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

// ── Provider events (normalized) ────────────────────────────────────────────

export type ProviderEvent =
	| { type: 'session'; sessionId: string }
	| { type: 'assistant_text'; text: string }
	| { type: 'assistant_thinking'; text: string }
	| { type: 'tool_call_start'; tool_name: string; tool_use_id: string }
	| { type: 'tool_call'; tool_name: string; tool_use_id: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; is_error: boolean; text: string }
	| { type: 'tool_progress'; tool_name: string; elapsedSeconds: number; taskId?: string }
	| { type: 'cost'; totalCostUsd?: number; durationMs?: number; durationApiMs?: number; numTurns?: number; usage?: unknown; subtype?: string }
	| { type: 'sdk_status'; status: string; compactResult?: string; error?: string }
	| { type: 'sdk_notification'; text: string; priority?: string }
	| { type: 'task_event'; taskId: string; phase: string; description?: string; summary?: string; taskType?: string; lastToolName?: string }
	| { type: 'rule_proposal'; text: string; reason?: string }
	| { type: 'hook_proposal'; event: string; matcher?: string; command: string; reason?: string }
	| { type: 'plan_proposed'; id: string; plan: string; originalMessage: string }
	| { type: 'user_question'; id: string; questions: unknown[] }
	| { type: 'hook_run'; hookId: string; event: string; command: string; status: string; exitCode?: number; stdout?: string; stderr?: string; durationMs?: number };

// ── canUseTool callback ─────────────────────────────────────────────────────

export type CanUseToolResult =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

export type CanUseToolFn = (
	toolName: string,
	toolInput: Record<string, unknown>
) => Promise<CanUseToolResult | undefined>;

// ── Query options ───────────────────────────────────────────────────────────

export interface ProviderQueryOptions {
	prompt: string;
	systemPrompt?: string;
	model?: string;
	sessionId?: string;
	planMode?: boolean;
	warmup?: boolean;
	allowedTools?: string[];
	canUseTool?: CanUseToolFn;
	abortSignal?: AbortSignal;
	images?: Array<{ mediaType: string; data: string }>;
	effort?: 'low' | 'medium' | 'high';
	hooks?: Record<string, unknown>;
}

// ── Provider interface ──────────────────────────────────────────────────────

export interface AgentProvider {
	readonly id: ProviderId;

	/** Run a query and stream normalized events. */
	query(
		options: ProviderQueryOptions,
		tools: ToolDefinition[]
	): AsyncIterable<ProviderEvent>;

	/** List available models for this provider. */
	listModels(): Promise<ProviderModelOption[]>;
}
