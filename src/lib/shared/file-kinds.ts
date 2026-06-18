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
