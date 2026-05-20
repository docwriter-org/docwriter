/**
 * Media paste / drop helpers — Substack-style transforms for the
 * plain-markdown editor.
 *
 * The editor is intentionally plain text: there are no image nodes, no
 * link cards, no rich content in the doc. Pasting visual media must
 * lower into markdown source. The visual side (thumbnails, og cards)
 * is then layered back on top by `media-overlay.ts`.
 *
 * Behavior matrix:
 *
 *   | Input                                        | Markdown inserted        |
 *   | -------------------------------------------- | ------------------------ |
 *   | Image file (clipboard or drop)               | `![](assets/<id>.<ext>)` |
 *   | URL ending in image extension                | `![](url)`               |
 *   | URL pasted with text selected                | `[selected](url)`        |
 *   | URL pasted on empty line                     | `url` (overlay carries)  |
 *   | URL pasted inline in prose                   | `url` (default paste)    |
 *   | Plain text                                   | (default paste)          |
 *
 * The "URL on empty line" case relies on `media-overlay.ts`'s standalone
 * bare-URL detection — pasting just the URL is enough, no special
 * insertion needed.
 */
import type { EditorView } from '@tiptap/pm/view';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;
/** Permissive URL matcher for paste-time triage. Anchored: the entire
 * pasted text must be one URL. We allow any non-whitespace tail so
 * Wikipedia-style links with `(...)` and query strings still register. */
const URL_RE = /^https?:\/\/\S+$/;

/** Allowed image MIME prefixes for paste/drop. We accept the same set
 * the workspace gallery does plus svg, since svg is a perfectly legit
 * blog asset. */
const ACCEPTED_MIME_RE = /^image\/(png|jpe?g|gif|webp|svg(?:\+xml)?|bmp|avif)$/i;

/** Workspace-relative directory for inserted images. Created on demand
 * by `POST /api/files` (which mkdir's parents). */
const ASSET_DIR = 'assets';

interface InsertOptions {
	readonly view: EditorView;
	readonly markdown: string;
	/** When true (drop case), `at` is provided and the editor selection
	 * isn't replaced. When false (paste case), the current selection is
	 * replaced by the inserted markdown. */
	readonly at?: number;
}

function insertText({ view, markdown, at }: InsertOptions): void {
	const { state } = view;
	const tr =
		typeof at === 'number' ? state.tr.insertText(markdown, at) : state.tr.insertText(markdown);
	view.dispatch(tr.scrollIntoView());
}

/** Sniff a clipboard or drag DataTransfer for the first attached image
 * file. Returns the file or null. We don't try to be clever about
 * multiple-file pastes — most platforms only emit one anyway, and
 * concatenating several unrelated images at the same caret position
 * isn't a useful UX. */
function pickFirstImageFile(dataTransfer: DataTransfer | null): File | null {
	if (!dataTransfer) return null;
	const files = dataTransfer.files;
	for (let i = 0; i < files.length; i += 1) {
		const file = files[i];
		if (ACCEPTED_MIME_RE.test(file.type)) return file;
	}
	// `items` covers the clipboard case where `files` is sometimes empty
	// even though an image is attached (Chrome on macOS for screenshots).
	const items = dataTransfer.items;
	if (items) {
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			if (item.kind === 'file' && ACCEPTED_MIME_RE.test(item.type)) {
				const file = item.getAsFile();
				if (file) return file;
			}
		}
	}
	return null;
}

/** Pull an image extension off a MIME type, falling back to a generic
 * `bin` so we never silently drop the file on disk with no extension. */
function pickExtension(file: File): string {
	const fromName = file.name.match(/\.([a-z0-9]+)$/i)?.[1];
	if (fromName) return fromName.toLowerCase();
	const mime = file.type.toLowerCase();
	if (mime === 'image/jpeg') return 'jpg';
	if (mime === 'image/svg+xml') return 'svg';
	const subtype = mime.split('/')[1];
	return (subtype || 'bin').replace(/\W/g, '');
}

/** Random 6-character base36 suffix; collisions per second per workspace
 * are vanishingly rare. The timestamp prefix keeps assets sorted by
 * insertion order in a directory listing. */
function buildAssetPath(file: File): string {
	const ext = pickExtension(file);
	const stamp = new Date()
		.toISOString()
		.replace(/[-:T]/g, '')
		.replace(/\..+$/, '');
	const rand = Math.random().toString(36).slice(2, 8);
	const safeBase = file.name
		.replace(/\.[^.]+$/, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	const stem = safeBase ? `${stamp}-${safeBase}-${rand}` : `${stamp}-${rand}`;
	return `${ASSET_DIR}/${stem}.${ext}`;
}

/** Read a Blob into a base64 string suitable for `POST /api/files`'s
 * base64 encoding. Skips the `data:` prefix that `FileReader` adds. */
async function blobToBase64(file: Blob): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunk = 0x8000;
	// Chunk to avoid `Maximum call stack size exceeded` on large images
	// — `String.fromCharCode(...bytes)` blows the stack at ~64 KB args.
	for (let i = 0; i < bytes.length; i += chunk) {
		const slice = bytes.subarray(i, i + chunk);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

interface SaveResult {
	readonly path: string;
}

async function saveImageToWorkspace(file: File): Promise<SaveResult | null> {
	const path = buildAssetPath(file);
	try {
		const base64 = await blobToBase64(file);
		const response = await fetch('/api/files', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, kind: 'file', content: base64, encoding: 'base64' })
		});
		if (!response.ok) return null;
		return { path };
	} catch {
		return null;
	}
}

/** Hand-off for image paste/drop. Inserts a placeholder while the
 * upload is in flight, then swaps in the final markdown reference once
 * the file lands on disk. We use a placeholder rather than blocking
 * the dispatch because the upload is async and we don't want to freeze
 * the editor while a 5MB screenshot encodes. */
async function handleImageFile(view: EditorView, file: File, at?: number): Promise<void> {
	const result = await saveImageToWorkspace(file);
	if (!result) {
		console.error('[docwriter] failed to save pasted image to workspace');
		return;
	}
	insertText({ view, markdown: `![](${result.path})`, at });
}

/** Returns true when the event's clipboard / drag carried something we
 * handled (image file, transformed URL). When true, the caller must
 * call `event.preventDefault()` and return `true` from PM's hook so PM
 * skips its default paste/drop logic. */
export interface MediaPasteResult {
	readonly handled: boolean;
}

export function handleEditorPaste(view: EditorView, event: ClipboardEvent): MediaPasteResult {
	const data = event.clipboardData;
	if (!data) return { handled: false };

	const imageFile = pickFirstImageFile(data);
	if (imageFile) {
		event.preventDefault();
		void handleImageFile(view, imageFile);
		return { handled: true };
	}

	const text = data.getData('text/plain').trim();
	if (!text || !URL_RE.test(text)) return { handled: false };

	// Image URL → render as inline image markdown so the media overlay
	// shows a thumbnail. No download for v1.
	if (IMAGE_EXT_RE.test(text)) {
		event.preventDefault();
		insertText({ view, markdown: `![](${text})` });
		return { handled: true };
	}

	const { state } = view;
	const { selection } = state;
	const hasSelection = !selection.empty;
	if (hasSelection) {
		// Wrap the selected text as the link's title — same as Cmd-K
		// would in any other editor.
		const selected = state.doc.textBetween(selection.from, selection.to, ' ');
		event.preventDefault();
		insertText({ view, markdown: `[${selected}](${text})` });
		return { handled: true };
	}

	// URL with no selection: let the default paste insert the URL as
	// plain text. The media overlay's standalone-bare-URL detection
	// (scanParagraphTokens in media-overlay.ts) decides per-paragraph
	// whether the line is alone enough to justify a card. Substack does
	// the same: inline URLs don't card, only own-line URLs do.
	return { handled: false };
}

export function handleEditorDrop(view: EditorView, event: DragEvent): MediaPasteResult {
	const data = event.dataTransfer;
	if (!data) return { handled: false };

	const imageFile = pickFirstImageFile(data);
	if (!imageFile) return { handled: false };

	const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
	if (!coords) return { handled: false };

	event.preventDefault();
	void handleImageFile(view, imageFile, coords.pos);
	return { handled: true };
}
