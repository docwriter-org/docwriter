#!/usr/bin/env node
/**
 * Merge origin/main into the current (landing) branch for CI.
 * Resolves recurring package.json conflicts by unioning landing-only
 * scripts/deps with main's updates, then regenerates package-lock.json.
 * CI-owned files on main always win (merge script + sync workflow).
 */
import { execSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';

const MERGE_MSG = 'chore: merge main into landing';
const MAIN_REF = process.env.DOCWRITER_MAIN_REF || 'origin/main';

/** Files maintained on main; landing should not fork these. */
const MAIN_OWNED = new Set([
	'scripts/merge-main-into-landing.mjs',
	'.github/workflows/sync-landing.yml',
	'docs/docs.json',
	'docs/reference/how-it-works.mdx',
	'src/lib/components/LogoMark.svelte',
	'src/routes/welcome/+page.server.ts',
	'src/routes/welcome/+page.svelte',
	'src/routes/welcome/+page.ts'
]);

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

function isAutoResolvable(conflicts) {
	return (
		conflicts.length > 0 &&
		conflicts.every(
			(f) => f === 'package.json' || f === 'package-lock.json' || MAIN_OWNED.has(f)
		)
	);
}

function resolveMainOwned(conflicts) {
	for (const file of conflicts) {
		if (!MAIN_OWNED.has(file)) continue;
		try {
			run(`git cat-file -e ":3:${file}"`);
			run(`git checkout --theirs -- ${file}`);
			run(`git add ${file}`);
		} catch {
			run(`git rm -- ${file}`);
		}
	}
}

execSync('git fetch origin main landing', { stdio: 'inherit' });

try {
	run(`git merge ${MAIN_REF} -m "${MERGE_MSG}"`, { inherit: true });
} catch {
	const conflicts = unmergedFiles();
	if (!isAutoResolvable(conflicts)) {
		console.error('Unhandled merge conflict(s):', conflicts.join(', ') || '(none)');
		process.exit(1);
	}

	resolveMainOwned(conflicts);

	if (conflicts.some((f) => f === 'package.json' || f === 'package-lock.json')) {
		if (conflicts.includes('package.json')) mergePackageJson();
		try {
			unlinkSync('package-lock.json');
		} catch {
			/* already absent */
		}
		run('git add package.json');
		run('git rm -f --cached package-lock.json 2>/dev/null || true');
		run('npm install', { inherit: true });
		run('git add package.json package-lock.json');
	}

	run(`git commit -m "${MERGE_MSG}"`, { inherit: true });
}
