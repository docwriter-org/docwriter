import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Worker-scoped Vite + DocWriter server. Each Playwright worker gets:
 *   - a unique port (5300 + workerIndex)
 *   - a unique tmp DOCWRITER_ROOT, so notes/ and .docwriter/ are fully
 *     isolated from other workers (and from the user's real workspace)
 *   - its own dev server process, killed at worker teardown
 *
 * `baseURL` is overridden per worker so `page.goto('/')` lands on this
 * worker's server. Specs import `test` and `expect` from here instead of
 * `@playwright/test`.
 */

export type IsolatedServer = { baseURL: string; root: string; port: number };

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { method: 'GET' });
			if (res.status < 500) return;
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Server at ${url} did not become ready in ${timeoutMs}ms: ${lastErr}`);
}

type WorkerFixtures = {
	isolatedServer: IsolatedServer;
};

export const test = base.extend<{ baseURL: string }, WorkerFixtures>({
	isolatedServer: [
		async ({}, use, workerInfo) => {
			const port = 5300 + workerInfo.workerIndex;
			const root = mkdtempSync(join(tmpdir(), `docwriter-w${workerInfo.workerIndex}-`));
			const proc: ChildProcess = spawn(
				'npx',
				['vite', 'dev', '--port', String(port), '--strictPort'],
				{
					env: {
						...process.env,
						DOCWRITER_ROOT: root,
						BROWSER: 'none',
						FORCE_COLOR: '0'
					},
					cwd: process.cwd(),
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			// Surface Vite errors to the worker's console so failures are
			// debuggable. Stdout is noisy (every HMR ping) so we drop it.
			proc.stderr?.on('data', (b) =>
				process.stderr.write(`[w${workerInfo.workerIndex}] ${b}`)
			);

			const baseURL = `http://localhost:${port}`;
			await waitForServer(baseURL);

			await use({ baseURL, root, port });

			proc.kill('SIGTERM');
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		},
		{ scope: 'worker', auto: true }
	],
	// Override the built-in test-scoped `baseURL` so `page.goto('/')` lands
	// on this worker's server rather than the global one in playwright.config.
	baseURL: async ({ isolatedServer }, use) => {
		await use(isolatedServer.baseURL);
	}
});

export { expect };
