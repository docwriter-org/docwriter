/** Client-safe file-kind helpers. */

export function extensionOf(path: string): string | null {
	const base = path.split('/').pop() || '';
	const idx = base.lastIndexOf('.');
	if (idx <= 0) return null;
	return base.slice(idx + 1).toLowerCase();
}

export function isPdfPath(path: string): boolean {
	return extensionOf(path) === 'pdf';
}

/** Preview / binary files that must never become a Y.Doc tab. Opening one
 * as a tab is fine for PDF preview, but seeding SQLite from the bytes
 * stores a huge `system` update and can stall Accept/Reject. */
const BINARY_OR_PREVIEW_EXTENSIONS = new Set([
	'pdf',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'ico',
	'bmp',
	'tif',
	'tiff',
	'avif',
	'heic',
	'mp3',
	'mp4',
	'wav',
	'mov',
	'zip',
	'gz',
	'tgz',
	'wasm',
	'eot',
	'ttf',
	'otf',
	'woff',
	'woff2',
	'exe',
	'dylib',
	'so',
	'class',
	'jar'
]);

export function isBinaryOrPreviewPath(path: string): boolean {
	const ext = extensionOf(path);
	return ext !== null && BINARY_OR_PREVIEW_EXTENSIONS.has(ext);
}

/** UTF-8 reads of PDFs and other binaries often embed NUL bytes. Never
 * seed a Y.Doc from that content even if the extension check is missed. */
export function looksLikeBinaryText(content: string): boolean {
	return content.includes('\0');
}
