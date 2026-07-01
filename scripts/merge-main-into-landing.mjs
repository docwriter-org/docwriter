#!/usr/bin/env node
/**
 * Merge origin/main into the current (landing) branch for CI.
 * Auto-resolves the recurring package.json scripts/deps conflict by unioning
 * landing-only entries with main's updates for shared keys.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
	run('git add package.json');
}

execSync('git fetch origin main landing', { stdio: 'inherit' });

try {
	run(`git merge origin/main -m "${MERGE_MSG}"`, { inherit: true });
} catch {
	const conflicts = unmergedFiles();
	if (conflicts.length === 1 && conflicts[0] === 'package.json') {
		mergePackageJson();
		run(`git commit -m "${MERGE_MSG}"`, { inherit: true });
	} else {
		console.error('Unhandled merge conflict(s):', conflicts.join(', ') || '(none)');
		process.exit(1);
	}
}
