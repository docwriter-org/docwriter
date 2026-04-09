import { writable } from 'svelte/store';
import type { Fragment, Rule, Action, Annotation, Sentence, HistoryEntry, EditorPin, Section, DocumentOp, NewDocumentOp } from './types';
import type { AtomzBlock, AtomzPin } from './atomz';

// Document state — populated from .atomz file on load
export const fragments = writable<Fragment[]>([]);
export const rules = writable<Rule[]>([]);
export const paraBreaks = writable<Set<number>>(new Set());
export const prose = writable<Sentence[]>([]);
export const annotations = writable<Annotation[]>([]);
export const editorPins = writable<EditorPin[]>([]);
export const sections = writable<Section[]>([]);
export const blocks = writable<AtomzBlock[]>([]);
export const pins = writable<AtomzPin[]>([]);

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

// Undo stack
const MAX_UNDO_DEPTH = 20;
export const proseHistory = writable<Sentence[][]>([]);

export function pushProseSnapshot(current: Sentence[]) {
	proseHistory.update((stack) => {
		const next = [...stack, current.map((s) => ({ ...s }))];
		return next.length > MAX_UNDO_DEPTH ? next.slice(-MAX_UNDO_DEPTH) : next;
	});
}

export function undoProse(): boolean {
	let didUndo = false;
	proseHistory.update((stack) => {
		if (stack.length === 0) return stack;
		const next = [...stack];
		const prev = next.pop()!;
		prose.set(prev);
		didUndo = true;
		return next;
	});
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
	agentHistory.update((h) => [...h, entry]);
}
