#!/usr/bin/env node
/**
 * Isolated provider smoke worker — one process, one Vite server, one browser.
 * CI matrix jobs and the local orchestrator both invoke this script.
 *
 *   E2E_PROVIDER=claude node e2e/run-provider.mjs
 */
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
	PROVIDER_ENV_VARS,
	PROVIDER_IDS,
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
	waitForEditorReady,
	waitForKeyStatus,
	wakeAgent,
	waitForPendingReview
} from './harness.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

function log(message) {
	const provider = process.env.E2E_PROVIDER ?? '?';
	console.log(`[${provider}] ${message}`);
}

function requiredProvider() {
	const provider = (process.env.E2E_PROVIDER || '').trim().toLowerCase();
	if (!provider || !PROVIDER_IDS.includes(provider)) {
		console.error(`E2E_PROVIDER must be one of: ${PROVIDER_IDS.join(', ')}`);
		process.exit(1);
	}
	return provider;
}

async function main() {
	const provider = requiredProvider();

	if (!hasProviderCredentials(provider)) {
		const envVar = PROVIDER_ENV_VARS[provider];
		if (process.env.E2E_REQUIRE_CREDENTIALS === '1') {
			log(`missing ${envVar}`);
			process.exit(1);
		}
		log(`SKIP — set ${envVar}`);
		process.exit(0);
	}

	const timeoutMs = agentTimeoutMs();
	const model = modelForProvider(provider);
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	const fixture = await seedFixture();

	log(`model=${model} http=${httpPort} ws=${wsPort}`);
	log(`fixture ${fixture}`);

	let server;
	let browser;
	let page;
	try {
		server = await startViteDev(fixture, httpPort, wsPort);
		const keyStatus = await waitForKeyStatus(httpPort, provider);
		if (!keyStatus?.usable) {
			throw new Error(`Provider ${provider} not usable according to /api/keys`);
		}

		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: VIEWPORT });
		await context.addInitScript(browserInitScript(provider, model));
		page = await context.newPage();

		await page.goto(`http://127.0.0.1:${httpPort}`, { waitUntil: 'domcontentloaded' });
		await sleep(2500);

		log('test 1: directive wake-up → pending edit');
		await openFile(page, 'essay.md');
		await waitForEditorReady(page, 'Provider smoke test');
		await wakeAgent(page);
		await waitForPendingReview(page, timeoutMs);
		log('test 1: PASS — pending review card appeared');

		log('test 2: chat message → assistant reply');
		await restartAgentSession(page);
		await waitForAgentIdle(page);
		await sendChatMessage(
			page,
			'Reply with exactly the single word PONG and nothing else. Do not edit the document.'
		);
		await waitForAssistantText(page, /PONG/i, timeoutMs);
		log('test 2: PASS — assistant text contained PONG');

		await setDockExpanded(page, false);
		log('PASS');
	} catch (err) {
		if (browser && page) {
			try {
				const history = await page.locator('.history-pane').innerText();
				const tail = history.split('\n').filter(Boolean).slice(-6).join(' | ');
				if (tail) log(`history: ${tail.slice(0, 500)}`);
			} catch {
				/* ignore */
			}
		}
		log(`FAIL — ${err.message}`);
		process.exit(1);
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

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
