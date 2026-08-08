#!/usr/bin/env node
/**
 * Resume after analysis: capture Style draft + expanded editor edit screenshots
 * against an existing workspace that already has an analyzed style profile.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');
const WORKSPACE = process.env.DOCWRITER_ROOT || '/tmp/docwriter-style-docs-cRVj4P';
const VIEWPORT = { width: 1400, height: 900 };
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 180_000);
const PROVIDER = process.env.DOCWRITER_PROVIDER ?? 'claude';
const MODEL = process.env.DOCWRITER_MODEL ?? 'claude-sonnet-4-6';

function findFreePort() {
	return new Promise((resolveFn, rejectFn) => {
		const srv = createServer();
		srv.once('error', rejectFn);
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			srv.close(() => resolveFn(port));
		});
	});
}

async function startViteDev(workspace, httpPort, wsPort) {
	const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
	const child = spawn(
		process.execPath,
		[viteBin, 'dev', '--host', '127.0.0.1', '--port', String(httpPort), '--strictPort'],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				DOCWRITER_ROOT: workspace,
				DOCWRITER_WS_PORT: String(wsPort),
				PUBLIC_DOCWRITER_WS_PORT: String(wsPort)
			},
			stdio: 'inherit'
		}
	);
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		try {
			const res = await fetch(`http://127.0.0.1:${httpPort}/`, { method: 'HEAD' });
			if (res.ok || res.status === 404 || res.status === 302) return child;
		} catch {
			/* not ready */
		}
	}
	child.kill();
	throw new Error(`vite did not come up on ${httpPort}`);
}

async function shot(page, name) {
	await mkdir(IMAGES_DIR, { recursive: true });
	const path = join(IMAGES_DIR, name);
	await page.screenshot({ path, fullPage: false });
	console.log(`  wrote ${name}`);
}

async function openFile(page, label) {
	const name = page.locator('.tree-name', { hasText: new RegExp(`^${label}$`) }).first();
	await name.waitFor({ state: 'visible', timeout: 30_000 });
	await name.click();
	await sleep(1200);
}

async function waitForEditor(page) {
	await page.waitForSelector('.tree-name, .tiptap-content', { timeout: 60_000 });
	if (await page.locator('.tree-name', { hasText: /^document\.md$/ }).count()) {
		await openFile(page, 'document.md');
	}
	await page.waitForSelector('.tiptap-content', { timeout: 60_000 });
	await page.waitForFunction(
		() => {
			const el = document.querySelector('.tiptap-content');
			return el && el.textContent && el.textContent.trim().length > 0;
		},
		{ timeout: 60_000 }
	);
}

async function main() {
	console.log('workspace:', WORKSPACE);
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	const vite = await startViteDev(WORKSPACE, httpPort, wsPort);
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: VIEWPORT });

	try {
		await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
		await sleep(2000);
		await page.evaluate(
			({ provider, model }) => {
				localStorage.setItem('docwriter.selectedProvider', provider);
				localStorage.setItem('docwriter.selectedModel', model);
				localStorage.setItem(
					'docwriter.selectedModelsByProvider',
					JSON.stringify({ [provider]: model })
				);
			},
			{ provider: PROVIDER, model: MODEL }
		);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await waitForEditor(page);

		console.log('opening style dialog → Style draft...');
		await page.locator('.reference-pill').first().click();
		const dialog = page.getByRole('dialog', { name: /Calibrate your style/i });
		await dialog.waitFor({ state: 'visible', timeout: 15_000 });
		await page.locator('nav.steps button', { hasText: /Style draft|Active skill/ }).click();
		await sleep(1000);

		// Prefer the button inside the dialog — the header pill also says
		// "Finalize style" when a draft is waiting.
		const finalize = dialog.locator('button.btn.primary', { hasText: /Finalize style|Update active skill/ }).first();
		if (await finalize.count()) {
			for (let i = 0; i < 20 && (await finalize.isDisabled().catch(() => true)); i++) {
				await sleep(500);
			}
			if (!(await finalize.isDisabled().catch(() => true))) {
				console.log('finalizing style...');
				await finalize.click({ force: true });
				await sleep(3000);
			} else {
				console.log('finalize disabled; publishing via API...');
				await page.evaluate(async () => {
					await fetch('/api/style-profile/finalize', { method: 'POST' });
				});
				await sleep(2000);
				await page.locator('nav.steps button', { hasText: /Style draft|Active skill/ }).click();
				await sleep(800);
			}
		} else {
			console.log('no finalize button; publishing via API...');
			await page.evaluate(async () => {
				await fetch('/api/style-profile/finalize', { method: 'POST' });
			});
			await sleep(2000);
			await page.locator('nav.steps button', { hasText: /Style draft|Active skill/ }).click();
			await sleep(800);
		}

		await shot(page, 'style-guidance-skill.png');
		await page.keyboard.press('Escape');
		await sleep(800);
		// Ensure the dialog is gone before waking the agent.
		await page.locator('.backdrop').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

		// Ensure the directive is still in the document; if accepted earlier, re-insert.
		const hasDirective = await page.evaluate(() =>
			(document.querySelector('.tiptap-content')?.textContent || '').includes('sounding like me')
		);
		if (!hasDirective) {
			console.log('re-inserting directive...');
			const editor = page.locator('.tiptap-content').first();
			await editor.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.press('Enter');
			await page.keyboard.press('Enter');
			await page.keyboard.type(
				'[[ Write two short paragraphs about waiting beside a late train in the rain, sounding like me. Keep the scene ordinary. Replace this directive. ]]',
				{ delay: 8 }
			);
			await sleep(500);
		}

		console.log('waking agent for style-matched edit...');
		// Unpause if a prior session left the agent stopped.
		await page.evaluate(async () => {
			const res = await fetch('/api/document');
			const data = await res.json().catch(() => ({}));
			const settings = data?.meta?.agentSettings ?? {};
			if (settings.paused) {
				await fetch('/api/document', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						meta: { agentSettings: { ...settings, paused: false } }
					})
				});
			}
		});
		await page.reload({ waitUntil: 'domcontentloaded' });
		await waitForEditor(page);

		// Expand the lower-right dock, then click the wake-up control.
		const dockPill = page.locator('.dock-agent-btn').first();
		if (await dockPill.count()) {
			await dockPill.click().catch(() => undefined);
			await sleep(400);
		}
		const wake = page.locator('.header-agent-btn').first();
		await wake.waitFor({ state: 'visible', timeout: 15_000 });
		await wake.click();
		console.log('  wake clicked; waiting for pending edit...');

		const pending = page.locator('.gutter-card').first();
		await pending.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
		// Wait for the agent to finish so the card has Accept and full copy.
		await page
			.waitForFunction(
				() => !document.querySelector('.header-agent-btn.awake, .dock-agent-btn.awake'),
				{ timeout: AGENT_TIMEOUT_MS }
			)
			.catch(() => undefined);

		// Collapse the dock so it does not cover the gutter, then expand the card.
		const collapse = page.locator('[aria-label="Collapse dock"]').first();
		if (await collapse.count()) await collapse.click().catch(() => undefined);
		await sleep(400);
		const collapsed = page.locator('.gutter-card:not(.expanded)').first();
		if (await collapsed.count()) {
			await collapsed.click().catch(() => undefined);
			await sleep(800);
		}
		const card = page.locator('.gutter-card.expanded, .gutter-card.loose-edit-card, .gutter-card').first();
		await card.scrollIntoViewIfNeeded().catch(() => undefined);
		await sleep(700);
		await shot(page, 'style-guidance-editor-edit.png');
		console.log('done');
	} finally {
		await browser.close().catch(() => undefined);
		vite.kill('SIGTERM');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
