import { readonly, writable } from 'svelte/store';
import type { Atom, Rule, Action, Annotation, Sentence, HistoryEntry, EditorPin, Section, DocumentOp, NewDocumentOp } from './types';
import type { AtomzBlock, AtomzPin } from './atomz';

// Document state — populated from .atomz file on load
export const atoms = writable<Atom[]>([]);
/** @deprecated Use atoms instead */
export const fragments = atoms;
export const rules = writable<Rule[]>([]);
const projectedParaBreaks = writable<Set<number>>(new Set());
const projectedProse = writable<Sentence[]>([]);
export const annotations = writable<Annotation[]>([]);
const projectedEditorPins = writable<EditorPin[]>([]);
const projectedSections = writable<Section[]>([]);
export const blocks = writable<AtomzBlock[]>([]);
export const pins = writable<AtomzPin[]>([]);
export const paraBreaks = readonly(projectedParaBreaks);
export const prose = readonly(projectedProse);
export const editorPins = readonly(projectedEditorPins);
export const sections = readonly(projectedSections);

// Note: these four .set() calls fire subscribers sequentially. A subscriber on
// prose that synchronously reads sections would see stale sections. Current
// subscribers only set local vars, so this is safe. If that changes, batch with
// a suppression flag.
export function setProjectedRuntimeView(input: {
	prose: Sentence[];
	paraBreaks: Set<number>;
	editorPins: EditorPin[];
	sections: Section[];
}) {
	projectedProse.set(input.prose);
	projectedParaBreaks.set(input.paraBreaks);
	projectedEditorPins.set(input.editorPins);
	projectedSections.set(input.sections);
}

// Signal to clear UserEdit marks in the editor after agent processes edits
export const clearUserEdits = writable<number>(0);

// Actions toolbar
export const pinnedActions: Action[] = [
	{ id: 'a_verbose', label: 'Too verbose', icon: 'scissors', pinned: true, color: '#8b5cf6' },
	{ id: 'a_ai', label: 'AI smell', icon: 'bot', pinned: true, color: '#f43f5e' },
	{ id: 'a_clunky', label: 'Clunky', icon: 'wrench', pinned: true, color: '#f59e0b' },
	{ id: 'a_inaccurate', label: 'Inaccurate', icon: 'x-circle', pinned: true, color: '#ef4444' },
	{ id: 'a_example', label: 'Add example', icon: 'lightbulb', pinned: true, color: '#10b981' },
	{ id: 'a_transition', label: 'Fix transition', icon: 'arrow-right', pinned: true, color: '#0891b2' }
];

export const recentActions = writable<Action[]>([]);
export const selectedAction = writable<Action | null>(null);

// Action usage tracking for rule promotion
export const actionUsageCounts = writable<Record<string, number>>({});

export function trackActionUsage(actionLabel: string) {
	actionUsageCounts.update((counts) => ({
		...counts,
		[actionLabel]: (counts[actionLabel] || 0) + 1
	}));
}

// UI state
export const highlightedFrags = writable<Set<string>>(new Set());
export const highlightedSents = writable<Set<number>>(new Set());
export const isRendering = writable(false);

// Selective rendering
export const renderingSentences = writable<Set<number>>(new Set());

// Sentence transitions: word-by-word typewriter with diff
export interface SentenceTransition {
	oldText: string;
	newText: string;
	wordsRevealed: number;
	done: boolean;
}
export const sentenceTransitions = writable<Map<number, SentenceTransition>>(new Map());

export const documentOps = writable<DocumentOp[]>([]);

// Agent edit highlights — temporarily show which blocks/atoms the agent changed
export const agentChangedBlockIds = writable<Set<string>>(new Set());
export const agentChangedAtomIds = writable<Set<string>>(new Set());

// Queued edit highlights — show which blocks have pending user edits awaiting agent
export const pendingEditBlockIds = writable<Set<string>>(new Set());

function createDocumentOpId(): string {
	return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function pushDocumentOp(item: NewDocumentOp) {
	const op = {
		id: item.id || createDocumentOpId(),
		createdAt: item.createdAt || Date.now(),
		...item
	} as unknown as DocumentOp;
	documentOps.update((ops) => [...ops, op]);
}

// Undo stack (block-level, canonical)
const MAX_UNDO_DEPTH = 20;
interface BlockSnapshot {
	blocks: AtomzBlock[];
	pins: AtomzPin[];
}
export const blockHistory = writable<BlockSnapshot[]>([]);

export function pushBlockSnapshot(currentBlocks: AtomzBlock[], currentPins: AtomzPin[]) {
	blockHistory.update((stack) => {
		const next = [...stack, {
			blocks: currentBlocks.map((b) => ({ ...b })),
			pins: currentPins.map((p) => ({ ...p, anchors: p.anchors.map((a) => ({ ...a })) }))
		}];
		return next.length > MAX_UNDO_DEPTH ? next.slice(-MAX_UNDO_DEPTH) : next;
	});
}

export async function undoBlocks(): Promise<boolean> {
	let didUndo = false;
	blockHistory.update((stack) => {
		if (stack.length === 0) return stack;
		const next = [...stack];
		const snapshot = next.pop()!;
		blocks.set(snapshot.blocks);
		pins.set(snapshot.pins);
		didUndo = true;
		return next;
	});
	if (didUndo) {
		// Dynamic import to avoid circular dependency — runtime-canonical imports from stores.
		const { reproject } = await import('./runtime-canonical');
		reproject();
	}
	return didUndo;
}

// Model & theme
export const selectedModel = writable<string>('opus');
export const selectedTheme = writable<string>('light');

// Editor mode: 'plaintext' or 'markdown'
export const editorMode = writable<'plaintext' | 'markdown'>('markdown');

// Version history (checkpoints from Agent SDK file checkpointing)
export interface Checkpoint {
	id: string;
	sessionId: string;
	timestamp: number;
	description?: string;
	prose?: Sentence[]; // snapshot of prose at this checkpoint
}
export const checkpoints = writable<Checkpoint[]>([]);

// Agent history
export const agentHistory = writable<HistoryEntry[]>([]);
export const showHistory = writable<boolean>(true);

export function pushHistory(entry: HistoryEntry) {
	agentHistory.update((h) => {
		// Deduplicate consecutive render_end entries
		if (entry.type === 'render_end' && h.length > 0 && h[h.length - 1].type === 'render_end') {
			return h;
		}
		return [...h, entry];
	});
}
