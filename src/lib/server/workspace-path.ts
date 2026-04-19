import { existsSync, realpathSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { error } from '@sveltejs/kit';

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();
const ROOT_REAL = existsSync(ROOT) ? realpathSync(ROOT) : resolve(ROOT);

function assertWithinRoot(realPath: string, relPath: string): void {
	const rel = relative(ROOT_REAL, realPath);
	if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
		throw error(400, `Path escapes workspace root: ${relPath}`);
	}
}

function nearestExistingAncestor(absPath: string): string {
	let cur = absPath;
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) return ROOT_REAL;
		cur = parent;
	}
	return realpathSync(cur);
}

/**
 * Resolve a workspace-relative path and reject any access that would follow a
 * symlink outside DOCWRITER_ROOT. Missing paths are validated against the
 * nearest existing ancestor so writes like `linked/new.txt` can't escape via a
 * symlinked parent directory.
 */
export function resolveWorkspacePath(relPath: string): string {
	const abs = resolve(ROOT, relPath);
	const realTarget = existsSync(abs) ? realpathSync(abs) : nearestExistingAncestor(dirname(abs));
	assertWithinRoot(realTarget, relPath);
	return abs;
}
