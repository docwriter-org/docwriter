import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { readHooks, resolveCommand } from './hooks-config';
import { WORKSPACE_ROOT } from './document-files';

/** If `file` is a `.tex` tab and a same-stem `.pdf` exists beside it
 * (e.g. `main.tex` → `main.pdf`), return the absolute PDF path. */
export function findCompanionPdfForTex(file: string): string | null {
	const dot = file.lastIndexOf('.');
	const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
	if (dot <= slash) return null;
	const ext = file.slice(dot + 1).toLowerCase();
	if (ext !== 'tex') return null;
	const pdfRel = `${file.slice(0, dot)}.pdf`;
	const abs = resolvePath(WORKSPACE_ROOT, pdfRel);
	return existsSync(abs) ? abs : null;
}

/** Resolve the preview output for an active tab: companion PDF for `.tex`
 * files first, then the first enabled hook with an `output` template. */
export function resolvePreviewOutputPath(file: string): string | null {
	const companionPdf = findCompanionPdfForTex(file);
	if (companionPdf) return companionPdf;

	const hooks = readHooks().hooks.filter((h) => h.enabled !== false && h.output);
	for (const hook of hooks) {
		const resolved = resolveCommand(hook.output ?? '', { file, tool: '' });
		if (!resolved) continue;
		const abs = resolvePath(WORKSPACE_ROOT, resolved);
		if (existsSync(abs)) return abs;
	}
	return null;
}
