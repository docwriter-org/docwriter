/**
 * Cached char-index helper used by both the diff overlay and the comment
 * overlay. Walks the PM doc once to build:
 *   - `plainText`: the doc's plain text (text nodes concatenated, no
 *     paragraph separators)
 *   - `charPositions`: array where index i maps plain-text char i to its
 *     PM position
 *
 * Both overlays previously inlined the same loop, and both ran it on every
 * transaction. With long docs (10K+ chars) the per-char push + string
 * concatenation showed up as visible typing lag. Caching by doc identity
 * (PM creates a new doc node on every transaction, so reference equality
 * is precise) makes repeated calls in the same render-pass effectively
 * free.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface CharIndex {
	charPositions: number[];
	plainText: string;
}

const cache = new WeakMap<PMNode, CharIndex>();

export function buildCharIndex(doc: PMNode): CharIndex {
	const cached = cache.get(doc);
	if (cached) return cached;

	// Build segments first; one allocation per text node is cheap. Single
	// `join('')` at the end avoids the quadratic-ish string concatenation
	// pattern of the prior `plainText += text[i]` loop.
	const segments: string[] = [];
	const positions: number[] = [];
	doc.descendants((node, pos) => {
		if (node.isText && node.text) {
			const text = node.text;
			segments.push(text);
			for (let i = 0; i < text.length; i += 1) {
				positions.push(pos + i);
			}
		}
		return true;
	});
	const result: CharIndex = {
		charPositions: positions,
		plainText: segments.join('')
	};
	cache.set(doc, result);
	return result;
}
