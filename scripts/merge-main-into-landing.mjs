#!/usr/bin/env node
/**
 * Merge origin/main into the current (landing) branch for CI.
 * Resolves recurring package.json conflicts by unioning landing-only
 * scripts/deps with main's updates, then regenerates package-lock.json.
 */
import { execSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';

const MERGE_MSG = 'chore: merge main into landing';

function run(cmd, { inherit = false } = {}) {
	return execSync(cmd, {
		encoding: 'utf8',
		stdio: inherit ? 'inherit' : 'pipe'
	});
}

function unmergedFiles() {
	return run('git diff --name-only --diff-filter=U')
		.trim()
		.split('\n')
		.filter(Boolean);
}

function mergePackageJson() {
	const landing = JSON.parse(run('git show :2:package.json'));
	const main = JSON.parse(run('git show :3:package.json'));
	const merged = {
		...main,
		scripts: { ...main.scripts, ...landing.scripts },
		devDependencies: { ...landing.devDependencies, ...main.devDependencies },
		dependencies: { ...landing.dependencies, ...main.dependencies }
	};
	writeFileSync('package.json', `${JSON.stringify(merged, null, '\t')}\n`);
}

function isPackageConflictOnly(conflicts) {
	return (
		conflicts.length > 0 &&
		conflicts.every((f) => f === 'package.json' || f === 'package-lock.json')
	);
}

execSync('git fetch origin main landing', { stdio: 'inherit' });

try {
	run(`git merge origin/main -m "${MERGE_MSG}"`, { inherit: true });
} catch {
	const conflicts = unmergedFiles();
	if (!isPackageConflictOnly(conflicts)) {
		console.error('Unhandled merge conflict(s):', conflicts.join(', ') || '(none)');
		process.exit(1);
	}

	mergePackageJson();
	try {
		unlinkSync('package-lock.json');
	} catch {
		/* already absent */
	}
	run('git add package.json');
	run('git rm -f --cached package-lock.json 2>/dev/null || true');
	run('npm install', { inherit: true });
	run('git add package.json package-lock.json');
	run(`git commit -m "${MERGE_MSG}"`, { inherit: true });
}
