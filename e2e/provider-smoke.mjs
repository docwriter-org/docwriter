#!/usr/bin/env node
/**
 * Local orchestrator: spawn one isolated worker per provider in parallel.
 * Each worker is a separate Node process with its own Vite server + browser
 * (like CI matrix jobs, but on one machine).
 *
 *   npm run test:e2e                    # all providers in parallel
 *   E2E_PROVIDER=claude npm run test:e2e:provider   # single worker
 *
 * CI does NOT use this file — matrix jobs call e2e/run-provider.mjs directly.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDER_IDS, REPO_ROOT } from './harness.mjs';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'run-provider.mjs');

function providersToRun() {
	const raw = (process.env.E2E_PROVIDER || process.env.PROVIDER || 'all').trim().toLowerCase();
	if (raw === 'all') return PROVIDER_IDS;
	if (!PROVIDER_IDS.includes(raw)) {
		throw new Error(`Unknown E2E_PROVIDER=${raw}. Expected one of: ${PROVIDER_IDS.join(', ')}, all`);
	}
	return [raw];
}

function runWorker(provider) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [WORKER_PATH], {
			cwd: REPO_ROOT,
			env: { ...process.env, E2E_PROVIDER: provider },
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const prefix = (chunk) => {
			for (const line of chunk.toString().split('\n')) {
				if (line.trim()) process.stdout.write(`${line}\n`);
			}
		};
		child.stdout?.on('data', prefix);
		child.stderr?.on('data', prefix);

		child.on('exit', (code) => {
			resolve({
				provider,
				status: code === 0 ? 'passed' : 'failed',
				error: code === 0 ? undefined : `exit ${code}`
			});
		});
		child.on('error', reject);
	});
}

async function main() {
	const providers = providersToRun();

	// Single provider: run in-process via worker (no double-fork).
	if (providers.length === 1) {
		const result = await runWorker(providers[0]);
		if (result.status === 'failed') process.exit(1);
		return;
	}

	console.log(`DocWriter provider smoke — ${providers.length} parallel workers`);
	const results = await Promise.all(providers.map((p) => runWorker(p)));

	const failed = results.filter((r) => r.status === 'failed');
	const passed = results.filter((r) => r.status === 'passed');

	console.log('\n── summary ──');
	for (const r of results) {
		const suffix = r.error ? ` (${r.error})` : '';
		console.log(`  ${r.provider}: ${r.status}${suffix}`);
	}
	console.log(`  passed=${passed.length} failed=${failed.length}`);

	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
