/**
 * One-shot "small win" decoration overlay. The accept handler calls
 * `flashCelebration(editor, range)` after a successful Accept; this
 * plugin paints a soft sage-green halo on the accepted text for ~800ms,
 * then clears itself.
 *
 * Why a separate plugin instead of reusing diff-overlay decorations:
 * after Accept, the diff-overlay state collapses (no more pending
 * rounds → no more diff). The celebration needs to outlive that
 * collapse and follow concurrent typing, which means its own plugin
 * state with PM mapping.
 */
import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface CelebrateEntry {
	from: number;
	to: number;
	expiresAt: number;
}

interface CelebrateState {
	entries: CelebrateEntry[];
}

const FLASH_MS = 800;
const celebrateKey = new PluginKey<CelebrateState>('celebrationOverlay');

export const CelebrationOverlay = Extension.create({
	name: 'celebrationOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: celebrateKey,
				state: {
					init: (): CelebrateState => ({ entries: [] }),
					apply(tr, prev) {
						const meta = tr.getMeta(celebrateKey) as
							| { add?: CelebrateEntry; prune?: true }
							| undefined;
						let next = prev;
						// Map existing ranges through the transaction so they
						// follow concurrent typing.
						if (tr.docChanged && next.entries.length > 0) {
							next = {
								entries: next.entries
									.map((e) => {
										const from = tr.mapping.map(e.from, 1);
										const to = tr.mapping.map(e.to, -1);
										if (to <= from) return null;
										return { from, to, expiresAt: e.expiresAt };
									})
									.filter((e): e is CelebrateEntry => e !== null)
							};
						}
						if (meta?.add) {
							next = { entries: [...next.entries, meta.add] };
						}
						if (meta?.prune) {
							const now = Date.now();
							next = { entries: next.entries.filter((e) => e.expiresAt > now) };
						}
						return next;
					}
				},
				props: {
					decorations(state) {
						const s = celebrateKey.getState(state);
						if (!s || s.entries.length === 0) return null;
						const now = Date.now();
						const decorations: Decoration[] = [];
						for (const entry of s.entries) {
							if (entry.expiresAt <= now) continue;
							decorations.push(
								Decoration.inline(entry.from, entry.to, { class: 'accept-celebrate' })
							);
						}
						if (decorations.length === 0) return null;
						return DecorationSet.create(state.doc, decorations);
					}
				}
			})
		];
	}
});

/** Pick the search string we'll actually look for. If `needle` is a single
 * line, use it as-is. If it spans paragraphs (contains `\n`), use the
 * longest non-empty line — the celebration anchors on that line, which
 * is a fine approximation for "show me where the change landed." A
 * stricter cross-paragraph match would need a parallel plain-text
 * builder that inserts `\n` between paragraphs and maps positions back;
 * not worth the complexity for a 800ms visual cue. */
function pickSearchKey(needle: string): string | null {
	if (!needle) return null;
	if (!needle.includes('\n')) return needle;
	let best = '';
	for (const line of needle.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length > best.length) best = trimmed;
	}
	return best.length >= 4 ? best : null;
}

/** Walk the editor doc and try to locate the search key. Returns null if
 * not found yet. Cheap enough to call on every animation frame during
 * the retry window. */
function locateRange(
	editor: Editor,
	key: string
): { from: number; to: number } | null {
	const doc = editor.view.state.doc;
	const positions: number[] = [];
	let plain = '';
	doc.descendants((node, pos) => {
		if (node.isText && node.text) {
			const text = node.text;
			for (let i = 0; i < text.length; i += 1) {
				positions.push(pos + i);
			}
			plain += text;
		}
		return true;
	});
	const idx = plain.indexOf(key);
	if (idx < 0) return null;
	const endIdx = idx + key.length - 1;
	if (endIdx >= positions.length) return null;
	const from = positions[idx];
	const to = positions[endIdx] + 1;
	if (to <= from) return null;
	return { from, to };
}

/** Locate `needle` in the editor's plain text and flash a sage-green
 * halo on that range for ~800ms. The accept flow calls this right after
 * a successful POST, but the Yjs sync (server → WebSocket → Y.Doc → PM
 * binding) takes a few frames to land — so we retry locating the text
 * for up to ~500ms before giving up. */
export function flashCelebration(editor: Editor, needle: string): void {
	if (!editor) return;
	const key = pickSearchKey(needle);
	if (!key) return;
	const view = editor.view;

	const RETRY_BUDGET_MS = 500;
	const startedAt = Date.now();

	const attempt = () => {
		// Editor may have been destroyed by remount / tab close mid-retry.
		// `view.dom` becoming null is the signal.
		if (!view.dom) return;
		const range = locateRange(editor, key);
		if (!range) {
			if (Date.now() - startedAt < RETRY_BUDGET_MS) {
				requestAnimationFrame(attempt);
			}
			return;
		}
		const expiresAt = Date.now() + FLASH_MS;
		try {
			view.dispatch(view.state.tr.setMeta(celebrateKey, { add: { ...range, expiresAt } }));
		} catch {
			return;
		}
		// Prune after the animation completes so the decoration is removed
		// and the editor stops re-rendering it on every subsequent tx.
		setTimeout(() => {
			try {
				view.dispatch(view.state.tr.setMeta(celebrateKey, { prune: true }));
			} catch {
				/* editor destroyed; ignore */
			}
		}, FLASH_MS + 50);
	};

	attempt();
}
