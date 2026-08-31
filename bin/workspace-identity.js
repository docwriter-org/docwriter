/**
 * CLI-side workspace banner + cwd-conflict warning.
 * Keep the rules aligned with src/lib/shared/workspace-identity.ts.
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export function describeWorkspace(root) {
	const resolved = resolve(root);
	return {
		root: resolved,
		stateDir: join(resolved, '.docwriter'),
		name: basename(resolved) || resolved
	};
}

export function conflictingCwdState(root, cwd = process.cwd()) {
	const resolvedRoot = resolve(root);
	const resolvedCwd = resolve(cwd);
	if (resolvedRoot === resolvedCwd) return null;
	const cwdStateDir = join(resolvedCwd, '.docwriter');
	if (!existsSync(cwdStateDir)) return null;
	return { cwd: resolvedCwd, cwdStateDir };
}

export function printWorkspaceBanner(identity, conflict) {
	console.log(`  workspace  ${identity.root}`);
	console.log(`  state      ${identity.stateDir}`);
	if (!conflict) return;
	console.log('');
	console.log(`  warning    cwd has a separate .docwriter at ${conflict.cwdStateDir}`);
	console.log(`             This process uses ${identity.stateDir} (the folder you opened).`);
	console.log(`             Inspecting the wrong folder looks like an empty database.`);
}
