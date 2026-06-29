#!/usr/bin/env node
/**
 * Provider smoke e2e: one browser session per backend.
 *
 * Each provider run:
 *   1. Wake agent on essay.md with a [[ ... ]] directive → expect a pending edit card.
 *   2. Send a chat message → expect assistant text in the history pane.
 *
 * Usage:
 *   npm run test:e2e                              # all providers with credentials
 *   E2E_PROVIDER=claude npm run test:e2e          # single provider
 *   E2E_PROVIDER=all npm run test:e2e             # explicit all (parallel)
 *
 * Env:
 *   E2E_PROVIDER     claude | openai | codex | cursor | pi | all (default: all)
 *   E2E_MODEL        override the default fast model for the provider
 *   AGENT_TIMEOUT_MS per-agent wait (default 120000)
 *   E2E_VERBOSE      stream vite logs
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import {
	PROVIDER_IDS,
	REPO_ROOT,
	VIEWPORT,
	agentTimeoutMs,
	browserInitScript,
	findFreePort,
	hasProviderCredentials,
	modelForProvider,
	openFile,
	restartAgentSession,
	seedFixture,
	sendChatMessage,
	setDockExpanded,
	startViteDev,
	waitForAssistantText,
	waitForAgentIdle,
	waitForKeyStatus,
	wakeAgent,
	waitForPendingReview,
	PROVIDER_ENV_VARS
} from './harness.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function log(provider, message) {
	console.log(`[${provider}] ${message}`);
}

async function runProviderSmoke(provider) {
	if (!hasProviderCredentials(provider)) {
		const envVar = PROVIDER_ENV_VARS[provider];
		log(provider, `SKIP — set ${envVar} (or use desktop login locally)`);
		return { provider, status: 'skipped', reason: `missing ${envVar}` };
	}

	const timeoutMs = agentTimeoutMs();
	const model = modelForProvider(provider);
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	const fixture = await seedFixture();

	log(provider, `model=${model} http=${httpPort} ws=${wsPort}`);
	log(provider, `fixture ${fixture}`);

	let server;
	let browser;
	try {
		server = await startViteDev(fixture, httpPort, wsPort);
		const keyStatus = await waitForKeyStatus(httpPort, provider);
		if (!keyStatus?.usable) {
			throw new Error(`Provider ${provider} not usable according to /api/keys`);
		}

		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: VIEWPORT });
		await context.addInitScript(browserInitScript(provider, model));
		const page = await context.newPage();

		await page.goto(`http://127.0.0.1:${httpPort}`, { waitUntil: 'domcontentloaded' });
		await sleep(2500);

		// ── Test 1: [[ directive ]] → pending review card ─────────────────
		log(provider, 'test 1: directive wake-up → pending edit');
		await openFile(page, 'essay.md');
		await wakeAgent(page);
		await waitForPendingReview(page, timeoutMs);
		log(provider, 'test 1: PASS — pending review card appeared');

		// ── Test 2: chat message → assistant reply in history ─────────────
		log(provider, 'test 2: chat message → assistant reply');
		await restartAgentSession(page);
		await waitForAgentIdle(page);
		await sendChatMessage(
			page,
			'Reply with exactly the single word PONG and nothing else. Do not edit the document.'
		);
		await waitForAssistantText(page, /PONG/i, timeoutMs);
		log(provider, 'test 2: PASS — assistant text contained PONG');

		await setDockExpanded(page, false);
		return { provider, status: 'passed' };
	} catch (err) {
		log(provider, `FAIL — ${err.message}`);
		return { provider, status: 'failed', error: err.message };
	} finally {
		if (browser) await browser.close().catch(() => undefined);
		if (server) {
			server.kill('SIGTERM');
			await sleep(500);
			if (!server.killed) server.kill('SIGKILL');
		}
		if (!process.env.KEEP_FIXTURE) {
			await rm(fixture, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

function providersToRun() {
	const raw = (process.env.E2E_PROVIDER || process.env.PROVIDER || 'all').trim().toLowerCase();
	if (raw === 'all') return PROVIDER_IDS;
	if (!PROVIDER_IDS.includes(raw)) {
		throw new Error(`Unknown E2E_PROVIDER=${raw}. Expected one of: ${PROVIDER_IDS.join(', ')}, all`);
	}
	return [raw];
}

async function runSequential(providers) {
	const results = [];
	for (const provider of providers) {
		results.push(await runProviderSmoke(provider));
	}
	return results;
}

function runParallel(providers) {
	return new Promise((resolve, reject) => {
		const children = providers.map((provider) => {
			const child = spawn(process.execPath, [SCRIPT_PATH], {
				cwd: REPO_ROOT,
				env: { ...process.env, E2E_PROVIDER: provider },
				stdio: 'inherit'
			});
			return { provider, child };
		});

		const results = [];
		let pending = children.length;
		for (const { provider, child } of children) {
			child.on('exit', (code) => {
				results.push({
					provider,
					status: code === 0 ? 'passed' : 'failed',
					error: code === 0 ? undefined : `exit ${code}`
				});
				pending -= 1;
				if (pending === 0) resolve(results);
			});
			child.on('error', reject);
		}
	});
}

async function main() {
	const providers = providersToRun();
	console.log(`DocWriter provider smoke — ${providers.join(', ')}`);

	const results =
		providers.length === 1
			? await runSequential(providers)
			: await runParallel(providers);

	const failed = results.filter((r) => r.status === 'failed');
	// Single-provider runs with E2E_REQUIRE_CREDENTIALS fail when the key is absent.
	const requireCreds = process.env.E2E_REQUIRE_CREDENTIALS === '1';
	const skipped = results.filter((r) => r.status === 'skipped');
	const passed = results.filter((r) => r.status === 'passed');

	console.log('\n── summary ──');
	for (const r of results) {
		const suffix = r.error ? ` (${r.error})` : r.reason ? ` (${r.reason})` : '';
		console.log(`  ${r.provider}: ${r.status}${suffix}`);
	}
	console.log(`  passed=${passed.length} failed=${failed.length} skipped=${skipped.length}`);

	if (failed.length > 0) process.exit(1);
	if (requireCreds && skipped.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
