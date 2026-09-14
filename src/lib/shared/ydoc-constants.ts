/**
 * Y.Doc schema constants and the typography normalizer, split out so the
 * proposals codec and the Y.Doc codec can both import them without a cycle.
 * Client and server import the same values; never redefine them locally.
 */

/**
 * Normalize typographic characters to their ASCII equivalents. Applied at
 * serialization so all consumers (read_doc, edit_doc, prompt diffs, disk
 * writes) see consistent plain-ASCII text. This prevents agent edit failures
 * when LLMs generate old_string with straight quotes/hyphens but the document
 * contains curly quotes/en-dashes.
 */
export function normalizeTypography(text: string): string {
	return text
		// Curly double quotes → straight double quote
		.replace(/[“”„‟″‶]/g, '"')
		// Curly single quotes, apostrophes → straight single quote
		.replace(/[‘’‚‛′‵]/g, "'")
		// En-dash, em-dash, figure dash, horizontal bar → hyphen-minus
		.replace(/[–—‒―]/g, '-')
		// Ellipsis → three dots
		.replace(/…/g, '...')
		// Non-breaking space → regular space
		.replace(/ /g, ' ');
}

export const FRAGMENT_NAME = 'default';
export const COMMENTS_MAP_NAME = 'comments';
export const AGENT_ORIGIN = 'agent';
/** Origin for user-initiated server-side mutations (accept / reject /
 * dismiss). Anything `ydoc.transact(..., USER_ORIGIN)` tags becomes
 * client-undoable: the Tiptap Collaboration extension is configured to
 * include this origin in its `Y.UndoManager.trackedOrigins`, so ctrl+z
 * in the editor reverses these transactions one step at a time. Reuse
 * carefully — adding a new USER_ORIGIN transact site opts it into undo
 * by default. Use SYSTEM_ORIGIN (or a fresh origin) for mutations that
 * should NOT be reversible from the editor. */
export const USER_ORIGIN = 'user';
export const SYSTEM_ORIGIN = 'system';

/** Yjs text-format attribute (and Tiptap mark name) that flags a run of text
 * as AI-authored. Stamped when a proposal's inserted text is accepted; the
 * client renders it as `span[data-ai-text]` and the provenance toggle colors
 * it. Absence of the attribute means human-authored. Provenance lives only in
 * the CRDT; every text view strips it. */
export const AI_ATTR = 'ai';
