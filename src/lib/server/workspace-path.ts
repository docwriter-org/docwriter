import { existsSync, realpathSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { error } from '@sveltejs/kit';
import { getEffectiveRoot } from './document-files';

function rootReal(): string {
	const root = getEffectiveRoot();
	return existsSync(root) ? realpathSync(root) : resolve(root);
}

function assertWithinRoot(realPath: string, relPath: string): void {
	const rel = relative(rootReal(), realPath);
	if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
		throw error(400, `Path escapes workspace root: ${relPath}`);
	}
}

function nearestExistingAncestor(absPath: string): string {
	let cur = absPath;
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) return rootReal();
		cur = parent;
	}
	return realpathSync(cur);
}

export function resolveWorkspacePath(relPath: string): string {
	const abs = resolve(getEffectiveRoot(), relPath);
	const realTarget = existsSync(abs) ? realpathSync(abs) : nearestExistingAncestor(dirname(abs));
	assertWithinRoot(realTarget, relPath);
	return abs;
}
