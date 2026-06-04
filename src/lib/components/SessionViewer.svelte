<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { X, Search, ChevronDown, ChevronRight, Activity } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { marked } from 'marked';

	// Configure marked: GitHub-flavored markdown + line-break support, sync rendering.
	marked.setOptions({ gfm: true, breaks: true, async: false });

	/** Render a markdown string to HTML. Returns plain escaped HTML if marked
	 * throws for any reason — never throws back to the caller. */
	function renderMarkdown(text: string): string {
		if (!text) return '';
		try {
			return marked.parse(text) as string;
		} catch {
			return escapeHtml(text);
		}
	}

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	interface Props {
		onClose: () => void;
	}
	let { onClose }: Props = $props();

	// ── Data model ────────────────────────────────────────────────────────────

	type EventKind =
		| 'user'
		| 'assistant_text'
		| 'thinking'
		| 'tool_use'
		| 'tool_result';

	interface SessionEvent {
		kind: EventKind;
		ts: string;
		text?: string;
		name?: string;
		inputJson?: string;
		toolId?: string;
		isError?: boolean;
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		cacheCreate?: number;
		cacheRead?: number;
		// Set by pairToolResults — attached result text/error for tool_use cards
		_result?: string;
		_resultError?: boolean;
	}

	let events = $state<SessionEvent[]>([]);
	let sessionId = $state('');
	let systemPrompt = $state<string | null>(null);
	let systemPromptOpen = $state(false);
	let loading = $state(true);
	let error = $state('');
	let searchQuery = $state('');
	let filter = $state<'all' | 'user' | 'assistant' | 'tools' | 'thinking'>('all');
	// Set of tool_use/thinking indices that are expanded
	let expanded = $state<Set<number>>(new Set());
	let allExpanded = $state(false);
	let conversationEl = $state<HTMLDivElement | null>(null);

	function scrollToBottom() {
		conversationEl?.scrollTo({ top: conversationEl.scrollHeight, behavior: 'smooth' });
	}
	function scrollToTop() {
		conversationEl?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	// ── Stats derived from events ─────────────────────────────────────────────

	let totalInTok = $derived(events.reduce((a, e) => a + (e.inputTokens ?? 0) + (e.cacheRead ?? 0), 0));
	let totalOutTok = $derived(events.reduce((a, e) => a + (e.outputTokens ?? 0), 0));

	// ── Context breakdown ─────────────────────────────────────────────────────
	// Estimate token usage by source so the user can see what's filling
	// the context window. Token counts are approximations: chars/4 (a
	// rough rule of thumb for Claude's tokenizer). The "live" buckets
	// (system prompt, rules) come from real workspace data; tools/MCP
	// are estimated from a fixed slate that the SDK ships per render;
	// "conversation" is whatever the latest assistant turn reported as
	// input + cache_read after subtracting the static buckets.
	let rulesText = $state('');
	let contextOpen = $state(false);
	const TOOLS_TOKENS_ESTIMATE = 6000;
	const MCP_TOKENS_ESTIMATE = 1800;
	// Claude Sonnet 4 / Opus 4: 200K context window. If your model has
	// extended context, surface it here.
	const CONTEXT_BUDGET = 200_000;
	function estimateTokens(s: string): number {
		if (!s) return 0;
		return Math.ceil(s.length / 4);
	}
	let systemPromptTokens = $derived(estimateTokens(systemPrompt ?? ''));
	let rulesTokens = $derived(estimateTokens(rulesText));
	// Latest assistant message reflects "what was sent in the last
	// request". The SDK's input_tokens already include cached + fresh
	// content, so taking the last one gives current context size.
	let latestAssistant = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const ev = events[i];
			if (ev.kind === 'assistant_text') return ev;
		}
		return null;
	});
	let lastInTok = $derived(
		(latestAssistant?.inputTokens ?? 0) + (latestAssistant?.cacheRead ?? 0)
	);
	let conversationTokens = $derived(
		Math.max(
			0,
			lastInTok -
				systemPromptTokens -
				rulesTokens -
				TOOLS_TOKENS_ESTIMATE -
				MCP_TOKENS_ESTIMATE
		)
	);
	let totalContextTokens = $derived(
		systemPromptTokens +
			rulesTokens +
			TOOLS_TOKENS_ESTIMATE +
			MCP_TOKENS_ESTIMATE +
			conversationTokens
	);
	let contextPctFull = $derived(
		Math.min(100, Math.round((totalContextTokens / CONTEXT_BUDGET) * 100))
	);
	type ContextBucket = { id: string; label: string; tokens: number; color: string };
	let contextBuckets = $derived<ContextBucket[]>([
		{ id: 'system', label: 'System prompt', tokens: systemPromptTokens, color: 'var(--ctx-color-system)' },
		{ id: 'tools', label: 'Tools', tokens: TOOLS_TOKENS_ESTIMATE, color: 'var(--ctx-color-tools)' },
		{ id: 'rules', label: 'Rules', tokens: rulesTokens, color: 'var(--ctx-color-rules)' },
		{ id: 'mcp', label: 'MCP', tokens: MCP_TOKENS_ESTIMATE, color: 'var(--ctx-color-mcp)' },
		{ id: 'conv', label: 'Conversation', tokens: conversationTokens, color: 'var(--ctx-color-conv)' }
	]);

	// Cursor-following tooltip for the context bar. Native `title` is too
	// slow to surface and looks out of place; this shows the bucket's label,
	// token estimate, and share instantly under the pointer.
	let barWrapEl = $state<HTMLDivElement>();
	let hoveredBar = $state<
		{ label: string; tokens: number; color: string; pct: number; x: number } | null
	>(null);
	function showBarTip(bucket: ContextBucket, pct: number, e: MouseEvent) {
		const rect = barWrapEl?.getBoundingClientRect();
		if (!rect) return;
		// Clamp x so the (centered) tooltip stays within the bar's width.
		const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
		hoveredBar = {
			label: bucket.label,
			tokens: bucket.tokens,
			color: bucket.color,
			pct: Math.round(pct),
			x
		};
	}

	async function fetchRules() {
		try {
			const res = await fetch('/api/document');
			if (!res.ok) return;
			const data = await res.json();
			const rules = (data?.meta?.rules ?? []) as Array<{ text?: string }>;
			rulesText = rules.map((r) => r.text ?? '').join('\n');
		} catch {
			// Best-effort — leave rulesText empty so the bucket reads as 0.
		}
	}
	let toolCounts = $derived.by(() => {
		const m: Record<string, number> = {};
		for (const e of events) {
			if (e.kind === 'tool_use' && e.name) m[e.name] = (m[e.name] ?? 0) + 1;
		}
		return Object.entries(m).sort((a, b) => b[1] - a[1]);
	});
	let userTurns = $derived(events.filter((e) => e.kind === 'user').length);

	// ── Filtered view ─────────────────────────────────────────────────────────

	let visibleIndices = $derived.by(() => {
		const q = searchQuery.toLowerCase();
		return events.map((ev, i) => {
			if (filter === 'user' && ev.kind !== 'user') return false;
			if (filter === 'assistant' && ev.kind !== 'assistant_text') return false;
			if (filter === 'tools' && ev.kind !== 'tool_use') return false;
			if (filter === 'thinking' && ev.kind !== 'thinking') return false;
			if (q) {
				const haystack = (
					(ev.text ?? '') +
					(ev.name ?? '') +
					(ev.inputJson ?? '')
				).toLowerCase();
				return haystack.includes(q);
			}
			return true;
		});
	});

	// ── Fetch + parse ─────────────────────────────────────────────────────────

	function fmtTokens(n: number): string {
		if (n < 1000) return String(n);
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	}

	onMount(async () => {
		void fetchRules();
		try {
			const res = await fetch('/api/history');
			const data = await res.json();
			sessionId = data.sessionId ?? '';
			systemPrompt = typeof data.systemPrompt === 'string' ? data.systemPrompt : null;
			// Prefer raw JSONL entries (direct file read, complete).
			// Fall back to the SDK-wrapped `messages` array if raw is absent.
			const raw: unknown[] = data.raw ?? [];
			const messages: unknown[] = data.messages ?? [];
			const parsed = raw.length > 0 ? parseRaw(raw) : parseMessages(messages);
			events = pairToolResults(parsed);
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	});

	/** Parse raw JSONL entries directly from the transcript file.
	 * Each entry has `type` ('user'|'assistant'|'system'|…), `message`, `timestamp`. */
	function parseRaw(entries: unknown[]): SessionEvent[] {
		const evs: SessionEvent[] = [];
		for (const entry of entries) {
			const e = entry as Record<string, unknown>;
			const t = e.type as string;
			const ts = (e.timestamp ?? '') as string;

			if (t === 'user') {
				const msg = (e.message ?? {}) as Record<string, unknown>;
				const content = msg.content;
				if (typeof content === 'string' && content.trim()) {
					evs.push({ kind: 'user', ts, text: content });
				} else if (Array.isArray(content)) {
					for (const block of content) {
						const b = block as Record<string, unknown>;
						if (b.type === 'text' && (b.text as string)?.trim()) {
							evs.push({ kind: 'user', ts, text: b.text as string });
						} else if (b.type === 'tool_result') {
							evs.push({ kind: 'tool_result', ts, ...extractToolResult(b) });
						}
					}
				}
			} else if (t === 'assistant') {
				const msg = (e.message ?? {}) as Record<string, unknown>;
				const content = (msg.content ?? []) as unknown[];
				const model = (msg.model ?? '') as string;
				const usage = (msg.usage ?? {}) as Record<string, number>;
				for (const block of content) {
					const b = block as Record<string, unknown>;
					if (b.type === 'thinking' && (b.thinking as string)?.trim()) {
						evs.push({ kind: 'thinking', ts, text: b.thinking as string });
					} else if (b.type === 'text' && (b.text as string)?.trim()) {
						evs.push({
							kind: 'assistant_text', ts, text: b.text as string, model,
							inputTokens: (usage.input_tokens ?? 0),
							outputTokens: (usage.output_tokens ?? 0),
							cacheCreate: (usage.cache_creation_input_tokens ?? 0),
							cacheRead: (usage.cache_read_input_tokens ?? 0)
						});
					} else if (b.type === 'tool_use') {
						evs.push({
							kind: 'tool_use', ts,
							name: b.name as string,
							toolId: b.id as string,
							inputJson: JSON.stringify(b.input, null, 2)
						});
					}
				}
			}
		}
		return evs;
	}

	function extractToolResult(b: Record<string, unknown>) {
		const tc = b.content ?? '';
		let text = '';
		if (typeof tc === 'string') text = tc;
		else if (Array.isArray(tc)) {
			text = (tc as Record<string, string>[])
				.filter((x) => x.type === 'text').map((x) => x.text).join('');
		}
		return { toolId: b.tool_use_id as string, text, isError: !!b.is_error };
	}

	function parseMessages(messages: unknown[]): SessionEvent[] {
		const evs: SessionEvent[] = [];
		for (const m of messages) {
			const msg = (m as Record<string, unknown>);
			const inner = (msg.message ?? {}) as Record<string, unknown>;
			const role = inner.role as string;
			const content = (inner.content ?? []) as unknown[];
			const model = (inner.model ?? '') as string;
			const usage = (inner.usage ?? {}) as Record<string, number>;
			const ts = (msg.timestamp ?? '') as string;
			if (role === 'user') {
				for (const block of content) {
					const b = block as Record<string, unknown>;
					if (b.type === 'text' && (b.text as string).trim()) {
						evs.push({ kind: 'user', ts, text: b.text as string });
					} else if (b.type === 'tool_result') {
						evs.push({ kind: 'tool_result', ts, ...extractToolResult(b) });
					}
				}
			} else if (role === 'assistant') {
				for (const block of content) {
					const b = block as Record<string, unknown>;
					if (b.type === 'thinking' && (b.thinking as string).trim()) {
						evs.push({ kind: 'thinking', ts, text: b.thinking as string });
					} else if (b.type === 'text' && (b.text as string).trim()) {
						evs.push({
							kind: 'assistant_text', ts, text: b.text as string, model,
							inputTokens: (usage.input_tokens ?? 0),
							outputTokens: (usage.output_tokens ?? 0),
							cacheCreate: (usage.cache_creation_input_tokens ?? 0),
							cacheRead: (usage.cache_read_input_tokens ?? 0)
						});
					} else if (b.type === 'tool_use') {
						evs.push({
							kind: 'tool_use', ts,
							name: b.name as string,
							toolId: b.id as string,
							inputJson: JSON.stringify(b.input, null, 2)
						});
					}
				}
			}
		}
		return evs;
	}

	/** Merge orphan tool_result events onto their paired tool_use event so
	 * we can show input + output together in one card. */
	function pairToolResults(raw: SessionEvent[]): SessionEvent[] {
		const byToolId: Record<string, SessionEvent> = {};
		for (const ev of raw) {
			if (ev.kind === 'tool_use' && ev.toolId) byToolId[ev.toolId] = ev;
		}
		const out: SessionEvent[] = [];
		for (const ev of raw) {
			if (ev.kind === 'tool_result') {
				const parent = ev.toolId ? byToolId[ev.toolId] : null;
				if (parent) {
					parent._result = ev.text;
					parent._resultError = ev.isError;
				}
				// Don't push orphan tool_result as standalone event
			} else {
				out.push(ev);
			}
		}
		return out;
	}

	function toggleExpand(i: number) {
		const next = new Set(expanded);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		expanded = next;
	}

	function toggleExpandAll() {
		if (allExpanded) {
			expanded = new Set();
			allExpanded = false;
		} else {
			allExpanded = true;
		}
	}

	/** First-line preview of a text message: strips markdown noise so the
	 * snippet reads cleanly when collapsed. Falls back to the first 120 chars. */
	function textPreview(text: string | undefined): string {
		if (!text) return '';
		// Walk lines, skip empty ones, return the first one with content.
		const lines = text.split('\n');
		for (const raw of lines) {
			const line = raw
				.replace(/^#{1,6}\s+/, '') // strip heading hashes
				.replace(/^[-*+]\s+/, '') // strip bullet markers
				.replace(/^\d+\.\s+/, '') // strip ordered-list markers
				.replace(/^>\s*/, '') // strip blockquote
				.replace(/`{1,3}/g, '') // strip code fences/ticks
				.replace(/\*\*([^*]+)\*\*/g, '$1') // unbold
				.replace(/\*([^*]+)\*/g, '$1') // unitalic
				.trim();
			if (line) return line.length > 140 ? line.slice(0, 137) + '…' : line;
		}
		return '';
	}

	/** One-line preview extracted from the tool's input JSON. */
	function toolPreview(inputJson: string | undefined): string {
		if (!inputJson) return '';
		try {
			const obj = JSON.parse(inputJson);
			// Common fields across tools
			const val =
				obj.command ?? obj.path ?? obj.query ?? obj.pattern ?? obj.url ??
				obj.content ?? obj.old_string ?? obj.message ?? obj.description ??
				Object.values(obj)[0];
			if (typeof val === 'string') {
				const first = val.split('\n')[0].trim();
				return first.length > 120 ? first.slice(0, 117) + '…' : first;
			}
		} catch { /* ignore */ }
		return '';
	}


	function truncate(s: string, max = 3000): string {
		if (!s) return '';
		if (s.length <= max) return s;
		return s.slice(0, max) + `\n…(${(s.length - max).toLocaleString()} more chars)`;
	}

	/** Strip the MCP server prefix from tool names so the sidebar reads
	 * cleanly. `mcp__docwriter-doc__edit_doc` → `edit_doc`. */
	function shortToolName(name: string): string {
		const m = name.match(/^mcp__[^_]+(?:-[^_]+)*__(.+)$/);
		return m ? m[1] : name;
	}

	function fmtTs(ts: string): string {
		try {
			const d = new Date(ts);
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		} catch {
			return '';
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop -->
<div
	class="backdrop"
	transition:fade={{ duration: 150 }}
	role="presentation"
	onmousedown={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
	<!-- Panel -->
	<div
		class="panel"
		role="dialog"
		aria-modal="true"
		aria-label="Session transcript"
		transition:fly={{ y: 20, duration: 220, easing: cubicOut }}
	>
		<!-- ── Top bar ──────────────────────────────────────────────────── -->
		<div class="topbar">
			<div class="topbar-left">
				<span class="topbar-title">Session transcript</span>
				{#if sessionId}
					<span class="topbar-sub" title={sessionId}>{sessionId.slice(0,8)}…</span>
				{/if}
				<button class="expand-all-btn" onclick={toggleExpandAll} title={allExpanded ? 'Collapse all' : 'Expand all tool calls'}>
					{allExpanded ? 'Collapse all' : 'Expand all'}
				</button>
				<button class="nav-btn" onclick={scrollToBottom} title="Jump to latest messages">↓ Latest</button>
				<button class="nav-btn" onclick={scrollToTop} title="Jump to top">↑ Top</button>
			</div>
			<div class="topbar-mid">
				<div class="search-wrap">
					<Search size={12} />
					<input
						class="search-input"
						type="text"
						placeholder="Search…"
						bind:value={searchQuery}
					/>
				</div>
				<div class="filter-tabs">
					{#each (['all','user','assistant','tools','thinking'] as const) as f}
						<button
							class="filter-tab"
							class:active={filter === f}
							onclick={() => (filter = f)}
						>
							{f === 'assistant' ? 'Claude' : f === 'tools' ? 'Tools' : f.charAt(0).toUpperCase() + f.slice(1)}
						</button>
					{/each}
				</div>
			</div>
			<div class="topbar-right">
				<div class="stats-pills">
					<span class="stat-pill">{userTurns} turns</span>
					<span class="stat-pill">{toolCounts.reduce((a,[,v])=>a+v,0)} calls</span>
					<span class="stat-pill">{fmtTokens(totalInTok)} in</span>
					<span class="stat-pill">{fmtTokens(totalOutTok)} out</span>
				</div>
				<button
					class="context-toggle"
					class:active={contextOpen}
					onclick={() => (contextOpen = !contextOpen)}
					title="Show how the context window is being used"
				>
					<Activity size={11} />
					<span>Context</span>
					<span class="context-toggle-pct">{contextPctFull}%</span>
				</button>
				<button class="close-btn" onclick={onClose} aria-label="Close">
					<X size={15} />
				</button>
			</div>
		</div>

		{#if contextOpen}
			<div class="context-card" transition:fly={{ y: -6, duration: 160, easing: cubicOut }}>
				<div class="context-card-header">
					<span class="context-card-title">Context</span>
					<button
						class="context-card-close"
						onclick={() => (contextOpen = false)}
						aria-label="Hide context breakdown"
					>
						<X size={12} />
					</button>
				</div>
				<div class="context-card-meta">
					<span class="context-pct">{contextPctFull}% Full</span>
					<span class="context-totals">
						~{fmtTokens(totalContextTokens)} / {fmtTokens(CONTEXT_BUDGET)} Tokens
					</span>
				</div>
				<div class="context-bar-wrap" bind:this={barWrapEl}>
					<div class="context-bar" role="img" aria-label="Context bucket breakdown">
						{#each contextBuckets as bucket (bucket.id)}
							{@const pct = totalContextTokens > 0 ? (bucket.tokens / CONTEXT_BUDGET) * 100 : 0}
							{#if pct > 0}
								<div
									class="context-bar-segment"
									style:flex-basis="{pct}%"
									style:background={bucket.color}
									role="presentation"
									onmouseenter={(e) => showBarTip(bucket, pct, e)}
									onmousemove={(e) => showBarTip(bucket, pct, e)}
									onmouseleave={() => (hoveredBar = null)}
								></div>
							{/if}
						{/each}
						<div class="context-bar-rest"></div>
					</div>
					{#if hoveredBar}
						<div class="context-bar-tip" style:left="{hoveredBar.x}px">
							<span class="context-bar-tip-dot" style:background={hoveredBar.color}></span>
							{hoveredBar.label} · {fmtTokens(hoveredBar.tokens)} · {hoveredBar.pct}%
						</div>
					{/if}
				</div>
				<div class="context-legend">
					{#each contextBuckets as bucket (bucket.id)}
						<div class="context-legend-row">
							<span
								class="context-legend-swatch"
								style:background={bucket.color}
								aria-hidden="true"
							></span>
							<span class="context-legend-label">{bucket.label}</span>
							<span class="context-legend-tokens">{fmtTokens(bucket.tokens)}</span>
						</div>
					{/each}
				</div>
				<div class="context-foot">
					Rough estimates: char-count ÷ 4. Tools / MCP are static-prompt approximations.
				</div>
			</div>
		{/if}

		<!-- ── Body ────────────────────────────────────────────────────── -->
		<div class="body">
			<!-- Sidebar: tool breakdown -->
			{#if toolCounts.length > 0}
				<aside class="sidebar">
					<div class="sidebar-heading">Tools used</div>
					{#each toolCounts as [name, count]}
						<div
							class="tool-row"
							role="button"
							tabindex="0"
							title={name}
							onclick={() => { filter = 'tools'; searchQuery = name; }}
							onkeydown={(e) => { if (e.key === 'Enter') { filter = 'tools'; searchQuery = name; } }}
						>
							<span class="tool-name">{shortToolName(name)}</span>
							<span class="tool-count">{count}</span>
						</div>
					{/each}
				</aside>
			{/if}

			<!-- Conversation -->
			<div class="conversation" bind:this={conversationEl}>
				{#if loading}
					<div class="empty">Loading transcript…</div>
				{:else if error}
					<div class="empty error-text">Failed to load: {error}</div>
				{:else if events.length === 0 && !systemPrompt}
					<div class="empty">No session messages yet — run the agent first.</div>
				{:else}
					{#if systemPrompt}
						{@const sysPreview = textPreview(systemPrompt)}
						<div class="card sys-card">
							<button class="card-header collapsible" onclick={() => (systemPromptOpen = !systemPromptOpen)}>
								<span class="role-badge sys-badge">System</span>
								{#if !systemPromptOpen && sysPreview}
									<span class="msg-preview">{sysPreview}</span>
								{:else}
									<span class="card-ts" title="System prompt — set via the SDK, not stored in the JSONL transcript">live (per render)</span>
								{/if}
								<span class="expand-hint">{systemPromptOpen ? 'collapse' : 'expand'}</span>
								<span class="chevron">
									{#if systemPromptOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
								</span>
							</button>
							{#if systemPromptOpen}
								<div class="card-body md-body">{@html renderMarkdown(systemPrompt)}</div>
							{/if}
						</div>
					{/if}
						{#each events as ev, i}
						{#if visibleIndices[i] !== false}
							{@const result = ev._result}
							{@const resultError = ev._resultError}
							{@const isOpen = allExpanded || expanded.has(i)}

							{#if ev.kind === 'user'}
								{@const preview = textPreview(ev.text)}
								<div class="card user-card">
									<button class="card-header collapsible" onclick={() => toggleExpand(i)}>
										<span class="role-badge user-badge">You</span>
										{#if !isOpen && preview}
											<span class="msg-preview">{preview}</span>
										{:else}
											<span class="card-ts">{fmtTs(ev.ts)}</span>
										{/if}
										<span class="expand-hint">{isOpen ? 'collapse' : 'expand'}</span>
										<span class="chevron">
											{#if isOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
										</span>
									</button>
									{#if isOpen}
										<div class="card-body md-body">{@html renderMarkdown(ev.text ?? '')}</div>
									{/if}
								</div>

							{:else if ev.kind === 'assistant_text'}
								{@const preview = textPreview(ev.text)}
								<div class="card asst-card">
									<button class="card-header collapsible" onclick={() => toggleExpand(i)}>
										<span class="role-badge asst-badge">Claude</span>
										{#if !isOpen && preview}
											<span class="msg-preview">{preview}</span>
										{:else}
											<span class="card-ts">{fmtTs(ev.ts)}</span>
											{#if ev.inputTokens || ev.outputTokens}
												<span class="tok-info">
													{fmtTokens((ev.inputTokens ?? 0) + (ev.cacheRead ?? 0))} in
													· {fmtTokens(ev.outputTokens ?? 0)} out
												</span>
											{/if}
										{/if}
										<span class="expand-hint">{isOpen ? 'collapse' : 'expand'}</span>
										<span class="chevron">
											{#if isOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
										</span>
									</button>
									{#if isOpen}
										<div class="card-body md-body">{@html renderMarkdown(ev.text ?? '')}</div>
									{/if}
								</div>

							{:else if ev.kind === 'thinking'}
								<div class="card think-card">
									<button class="card-header collapsible" onclick={() => toggleExpand(i)}>
										<span class="role-badge think-badge">Thinking</span>
										<span class="card-ts">{fmtTs(ev.ts)}</span>
										<span class="expand-hint">{isOpen ? 'collapse' : 'expand'}</span>
										<span class="chevron">
											{#if isOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
										</span>
									</button>
									{#if isOpen}
										<div class="card-body mono small">{truncate(ev.text ?? '', 6000)}</div>
									{/if}
								</div>

							{:else if ev.kind === 'tool_use'}
								{@const preview = toolPreview(ev.inputJson)}
								<div class="card tool-card" class:has-error={resultError}>
									<button class="card-header collapsible" onclick={() => toggleExpand(i)}>
										<span class="role-badge tool-badge" title={ev.name}>⚙ {shortToolName(ev.name ?? '')}</span>
										{#if !isOpen && preview}
											<span class="tool-preview">{preview}</span>
										{:else}
											<span class="card-ts">{fmtTs(ev.ts)}</span>
										{/if}
										<span class="expand-hint">{isOpen ? 'collapse' : 'expand'}</span>
										<span class="chevron">
											{#if isOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
										</span>
									</button>
									{#if isOpen}
										<div class="tool-body">
											<div class="tool-section">
												<div class="section-label">Input</div>
												<pre class="code-block">{truncate(ev.inputJson ?? '{}', 2000)}</pre>
											</div>
											{#if result !== undefined}
												<div class="tool-section">
													<div class="section-label" class:err-label={resultError}>
														{resultError ? '⚠ Error' : 'Output'}
													</div>
													<pre class="code-block result-block" class:err-block={resultError}>{truncate(result, 3000)}</pre>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						{/if}
					{/each}
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/* ── Backdrop + panel ────────────────────────────────────────── */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.35);
		backdrop-filter: blur(3px);
		display: flex;
		align-items: stretch;
		justify-content: stretch;
		padding: 12px;
	}
	.panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 32px 80px rgba(0, 0, 0, 0.28);
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
		min-height: 0;
	}

	/* ── Top bar ─────────────────────────────────────────────────── */
	.topbar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-light);
		background: var(--header-bg);
		flex-shrink: 0;
	}
	.topbar-left {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}
	.topbar-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.topbar-sub {
		font-size: 11px;
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
	}
	.expand-all-btn {
		font-size: 11px;
		font-family: inherit;
		color: var(--accent);
		background: var(--accent-bg);
		border: 1px solid var(--accent-light);
		border-radius: 4px;
		padding: 2px 8px;
		cursor: pointer;
		white-space: nowrap;
	}
	.expand-all-btn:hover { filter: brightness(0.94); }
	.nav-btn {
		font-size: 11px;
		font-family: inherit;
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 4px;
		padding: 2px 8px;
		cursor: pointer;
		white-space: nowrap;
	}
	.nav-btn:hover { background: var(--bg-hover); color: var(--text); }
	.topbar-mid {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	/* ── Search ──────────────────────────────────────────────────── */
	.search-wrap {
		display: flex;
		align-items: center;
		gap: 6px;
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 4px 8px;
		color: var(--text-faint);
		flex-shrink: 0;
	}
	.search-input {
		border: none;
		background: transparent;
		color: var(--text);
		font-size: 12px;
		font-family: inherit;
		outline: none;
		width: 140px;
	}
	.search-input::placeholder { color: var(--text-faint); }

	/* ── Filter tabs ─────────────────────────────────────────────── */
	.filter-tabs {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}
	.filter-tab {
		padding: 3px 9px;
		border-radius: 5px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		font-size: 11.5px;
		font-family: inherit;
		cursor: pointer;
		transition: all .1s;
	}
	.filter-tab:hover { background: var(--bg-hover); color: var(--text); }
	.filter-tab.active {
		background: var(--accent-bg);
		border-color: var(--accent-light);
		color: var(--accent);
		font-weight: 500;
	}

	/* ── Stats pills ─────────────────────────────────────────────── */
	.stats-pills {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.stat-pill {
		font-size: 11px;
		color: var(--text-faint);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 20px;
		padding: 2px 8px;
		font-family: ui-monospace, monospace;
		white-space: nowrap;
	}

	/* ── Context breakdown ───────────────────────────────────────── */
	/* Per-bucket palette. CSS vars so dark/light themes can override
	 * via the same names if needed without touching this file. */
	.panel {
		--ctx-color-system: #94a3b8;
		--ctx-color-tools: #7c3aed;
		--ctx-color-rules: #16a34a;
		--ctx-color-skills: #d97706;
		--ctx-color-mcp: #c026d3;
		--ctx-color-subagents: #2563eb;
		--ctx-color-conv: #f97316;
	}
	.context-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		font-size: 11px;
		font-family: inherit;
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 999px;
		cursor: pointer;
		white-space: nowrap;
	}
	.context-toggle:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.context-toggle.active {
		background: var(--accent-bg);
		border-color: var(--accent-light);
		color: var(--accent);
	}
	.context-toggle-pct {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		font-variant-numeric: tabular-nums;
	}
	.context-card {
		position: relative;
		margin: 0 14px 0;
		padding: 14px 16px 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-bottom: none;
		border-radius: 10px 10px 0 0;
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
		font-family: 'Inter', -apple-system, sans-serif;
		flex-shrink: 0;
	}
	.context-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.context-card-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.context-card-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		border-radius: 999px;
		cursor: pointer;
	}
	.context-card-close:hover {
		background: var(--bg-surface);
		color: var(--text);
	}
	.context-card-meta {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}
	.context-pct {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.context-totals {
		font-size: 11.5px;
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
	}
	.context-bar-wrap {
		position: relative;
		margin-bottom: 12px;
	}
	.context-bar {
		display: flex;
		width: 100%;
		height: 8px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--bg-surface);
		gap: 2px;
		padding: 0;
	}
	.context-bar-segment {
		height: 100%;
		min-width: 6px;
		flex-grow: 0;
		flex-shrink: 0;
		cursor: default;
	}
	.context-bar-tip {
		position: absolute;
		bottom: calc(100% + 6px);
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		padding: 4px 8px;
		border-radius: 6px;
		background: var(--text-primary, #1f2430);
		color: var(--bg-base, #fff);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.2;
		pointer-events: none;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
		z-index: 5;
	}
	.context-bar-tip::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		border: 4px solid transparent;
		border-top-color: var(--text-primary, #1f2430);
	}
	.context-bar-tip-dot {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		flex-shrink: 0;
	}
	.context-bar-rest {
		flex: 1 1 auto;
	}
	.context-legend {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 4px 18px;
	}
	.context-legend-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 0;
		font-size: 12px;
	}
	.context-legend-swatch {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.context-legend-label {
		color: var(--text);
		flex: 1;
	}
	.context-legend-tokens {
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		font-size: 11.5px;
	}
	.context-foot {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px dashed var(--border-light);
		font-size: 10.5px;
		color: var(--text-faint);
	}

	/* ── Close button ────────────────────────────────────────────── */
	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all .1s;
	}
	.close-btn:hover { background: var(--bg-hover); color: var(--text); }

	/* ── Body layout ─────────────────────────────────────────────── */
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}
	.sidebar {
		width: 200px;
		flex-shrink: 0;
		border-right: 1px solid var(--border-light);
		background: var(--pane-bg);
		padding: 12px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.sidebar-heading {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: .07em;
		color: var(--text-faint);
		margin-bottom: 6px;
		padding: 0 4px;
	}
	.tool-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: 24px;
		padding: 0 8px;
		border-radius: 5px;
		cursor: pointer;
		transition: background .1s;
	}
	.tool-row:hover { background: var(--bg-hover); }
	.tool-name {
		font-size: 12px;
		color: var(--text-secondary);
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: 'Geist Mono', ui-monospace, monospace;
	}
	.tool-count {
		flex-shrink: 0;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-bg);
		border-radius: 10px;
		padding: 1px 6px;
		min-width: 22px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* ── Conversation ────────────────────────────────────────────── */
	.conversation {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 16px 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.empty {
		margin: auto;
		color: var(--text-faint);
		font-size: 13px;
	}
	.error-text { color: #ef4444; }

	/* ── Cards ───────────────────────────────────────────────────── */
	.card {
		flex-shrink: 0;
		border-radius: 8px;
		border: 1px solid var(--border-light);
		overflow: hidden;
		font-size: 13px;
	}
	.user-card {
		background: var(--bg-elevated);
		border-color: var(--accent-light);
	}
	.asst-card {
		background: var(--assistant-bg);
		border-color: var(--assistant-border);
	}
	.think-card {
		background: var(--bg-surface);
		border-color: var(--border-light);
		opacity: 0.8;
	}
	.tool-card {
		background: var(--tool-bg);
		border-color: var(--tool-border);
	}
	.sys-card {
		background: var(--bg-surface);
		border-color: var(--border);
	}
	.tool-card.has-error { border-color: #ef4444; }

	/* ── Card header ─────────────────────────────────────────────── */
	.card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 12px;
		border-bottom: 1px solid rgba(0, 0, 0, 0.04);
	}
	button.card-header {
		width: 100%;
		background: transparent;
		border: none;
		border-bottom: 1px solid rgba(0, 0, 0, 0.04);
		cursor: pointer;
	}
	.collapsible { cursor: pointer; }
	.collapsible:hover { background: color-mix(in srgb, var(--bg-hover) 60%, transparent); }
	.card-ts {
		font-size: 11px;
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
	}
	.tok-info {
		margin-left: auto;
		font-size: 11px;
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
	}
	.tool-preview {
		flex: 1;
		min-width: 0;
		font-size: 11.5px;
		color: var(--text-secondary);
		font-family: 'Geist Mono', ui-monospace, monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.msg-preview {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.expand-hint {
		margin-left: auto;
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
	}
	.chevron { color: var(--text-faint); display: flex; align-items: center; }

	/* ── Role badges ─────────────────────────────────────────────── */
	.role-badge {
		font-size: 10.5px;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 20px;
		letter-spacing: .03em;
		flex-shrink: 0;
		/* Reserve a uniform column on the left so previews start at the same
		 * x-position regardless of badge label length. Long names still grow
		 * past the min and bump the preview right — but for the common case
		 * (You / Claude / short tool names) the column stays aligned. */
		min-width: 110px;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: center;
	}
	.user-badge {
		background: var(--accent-bg);
		color: var(--accent);
		border: 1px solid var(--accent-light);
	}
	.asst-badge {
		background: var(--assistant-bg);
		color: var(--color-agent-edit);
		border: 1px solid var(--assistant-border);
	}
	.think-badge {
		background: var(--bg-hover);
		color: var(--text-muted);
		border: 1px solid var(--border-light);
	}
	.tool-badge {
		background: var(--tool-bg);
		color: var(--tool-accent);
		border: 1px solid var(--tool-border);
	}
	.sys-badge {
		background: var(--bg-surface);
		color: var(--text-secondary);
		border: 1px solid var(--border);
		font-variant: small-caps;
	}

	/* ── Card body ───────────────────────────────────────────────── */
	.card-body {
		padding: 10px 12px;
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.6;
		color: var(--text);
	}
	/* Markdown-rendered body: marked emits real HTML, so we drop the
	 * pre-wrap whitespace handling and let block elements lay out
	 * naturally. The selectors below give those elements the right
	 * spacing without bleeding into the rest of the modal. */
	.card-body.md-body {
		white-space: normal;
	}
	.card-body.md-body :global(p) { margin: 0 0 8px; }
	.card-body.md-body :global(p:last-child) { margin-bottom: 0; }
	.card-body.md-body :global(h1),
	.card-body.md-body :global(h2),
	.card-body.md-body :global(h3),
	.card-body.md-body :global(h4) {
		margin: 12px 0 6px;
		font-weight: 600;
		line-height: 1.3;
	}
	.card-body.md-body :global(h1) { font-size: 18px; }
	.card-body.md-body :global(h2) { font-size: 16px; }
	.card-body.md-body :global(h3) { font-size: 14px; }
	.card-body.md-body :global(h4) { font-size: 13px; }
	.card-body.md-body :global(ul),
	.card-body.md-body :global(ol) {
		margin: 6px 0 8px;
		padding-left: 22px;
	}
	.card-body.md-body :global(li) { margin: 2px 0; }
	.card-body.md-body :global(li > p) { margin: 0; }
	.card-body.md-body :global(code) {
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 3px;
		padding: 1px 5px;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 12px;
	}
	.card-body.md-body :global(pre) {
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 8px 10px;
		overflow-x: auto;
		margin: 6px 0 10px;
		line-height: 1.5;
	}
	.card-body.md-body :global(pre code) {
		background: transparent;
		border: none;
		padding: 0;
		font-size: 12px;
	}
	.card-body.md-body :global(blockquote) {
		border-left: 3px solid var(--border-light);
		padding: 0 12px;
		margin: 6px 0 10px;
		color: var(--text-muted);
	}
	.card-body.md-body :global(a) {
		color: var(--accent);
		text-decoration: underline;
	}
	.card-body.md-body :global(table) {
		border-collapse: collapse;
		margin: 6px 0 10px;
		font-size: 12px;
	}
	.card-body.md-body :global(th),
	.card-body.md-body :global(td) {
		border: 1px solid var(--border-light);
		padding: 4px 8px;
		text-align: left;
	}
	.card-body.md-body :global(th) {
		background: var(--bg-surface);
		font-weight: 600;
	}
	.card-body.md-body :global(hr) {
		border: none;
		border-top: 1px solid var(--border-light);
		margin: 12px 0;
	}
	.card-body.md-body :global(strong) { font-weight: 600; }
	.card-body.md-body :global(em) { font-style: italic; }
	.card-body.mono {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.5;
	}
	.card-body.small { font-size: 12px; }

	/* ── Tool body ───────────────────────────────────────────────── */
	.tool-body {
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.tool-section { display: flex; flex-direction: column; gap: 4px; }
	.section-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: .07em;
		color: var(--text-faint);
	}
	.section-label.err-label { color: #ef4444; }
	.code-block {
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 5px;
		padding: 8px 10px;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 11.5px;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		max-height: 360px;
		overflow-y: auto;
		color: var(--text);
		line-height: 1.5;
	}
	.result-block {
		background: color-mix(in srgb, var(--diff-added-color) 8%, var(--bg));
		border-color: color-mix(in srgb, var(--diff-added-color) 25%, var(--border-light));
	}
	.err-block {
		background: color-mix(in srgb, #ef4444 8%, var(--bg));
		border-color: color-mix(in srgb, #ef4444 30%, var(--border-light));
	}
</style>
