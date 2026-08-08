#!/usr/bin/env node
/**
 * Capture the Writing references / style-guidance walkthrough screenshots.
 *
 * Uses three public-domain Alice Meynell passages as stand-in "your writing"
 * so the docs can show a real analysis → preference → editor loop without
 * inventing prose.
 *
 * Requires ANTHROPIC_API_KEY (or another configured Claude credential).
 *
 * Usage:
 *   node docs/capture-style-guidance.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');
const VIEWPORT = { width: 1400, height: 900 };
const ANALYSIS_TIMEOUT_MS = Number(process.env.STYLE_ANALYSIS_TIMEOUT_MS ?? 25 * 60_000);
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 180_000);
const PROVIDER = process.env.DOCWRITER_PROVIDER ?? 'claude';
const MODEL = process.env.DOCWRITER_MODEL ?? 'claude-sonnet-4-6';

const SOURCES = JSON.parse(
	await readFile(join(REPO_ROOT, 'scripts', 'style-guidance-meynell-sources.json'), 'utf8')
);

const DRAFT = `# Waiting for the late train

The platform was almost empty. A few people kept looking down the track as if that would make the train arrive sooner.

[[ Write two short paragraphs about waiting beside a late train in the rain, sounding like me. Keep the scene ordinary. Replace this directive. ]]
`;

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

async function seedWorkspace() {
	const dir = await mkdtemp(join(tmpdir(), 'docwriter-style-docs-'));
	await writeFile(join(dir, 'document.md'), DRAFT, 'utf8');
	return dir;
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
				DOCWRITER_NEW_SESSION: '1',
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
	console.log('  waiting for editor shell...');
	await page.waitForSelector('.tiptap-content, .tree-name', { timeout: 60_000 });
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
	console.log('  editor ready');
}

async function configureProvider(page) {
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
}

async function openStyleDialog(page) {
	const pill = page.locator('.reference-pill').first();
	await pill.waitFor({ state: 'visible', timeout: 45_000 });
	await pill.click();
	const dialog = page.getByRole('dialog', { name: /Calibrate your style|Writing references/i });
	await dialog.waitFor({ state: 'visible', timeout: 15_000 });
	return dialog;
}

async function addSource(page, description, text) {
	await page.getByLabel('What this passage is').fill(description);
	await page.getByLabel('Passage text').fill(text);
	await page.getByRole('button', { name: 'Add source' }).click();
	await page.getByText(description, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
	await sleep(400);
}

async function main() {
	if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY) {
		console.warn('Warning: no ANTHROPIC_API_KEY visible; Claude analysis may fail.');
	}

	const workspace = await seedWorkspace();
	console.log('workspace:', workspace);
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	const vite = await startViteDev(workspace, httpPort, wsPort);
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: VIEWPORT });

	try {
		console.log('loading app...');
		await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
		await sleep(2500);
		await waitForEditor(page);
		console.log('configuring provider/model...');
		await configureProvider(page);

		console.log('opening style dialog...');
		await openStyleDialog(page);

		// ---- 1. Sources with three Meynell passages ----
		console.log('adding three sources...');
		for (const source of SOURCES) {
			await addSource(page, source.description, source.text);
		}
		await sleep(500);
		await shot(page, 'style-guidance-sources.png');

		// ---- 2. Analyze pane: start run, capture specialists mid-flight ----
		console.log('starting analysis...');
		await page.locator('nav.steps button', { hasText: 'Analyze' }).click();
		await page.getByRole('heading', { name: 'Style analysis' }).waitFor({ state: 'visible' });
		await page.locator('button.btn.primary', { hasText: /Run analysis|Do another pass/ }).click();

		const activity = page.getByRole('list', { name: 'Analysis progress' });
		await activity.waitFor({ state: 'visible', timeout: 30_000 });

		// Wait until specialist rows are present, then for at least one specialist
		// to be running or completed so the screenshot shows the interesting state.
		await page.waitForFunction(() => {
			const items = [...document.querySelectorAll('.activity-row')];
			return items.some((el) => /Lexis specialist|Grammar specialist|Discourse specialist/.test(el.textContent || ''));
		}, { timeout: 120_000 });

		// Prefer a moment when specialists are visible and analysis is clearly underway.
		await page.waitForFunction(() => {
			const text = document.querySelector('.progress-summary')?.textContent || '';
			const progress = Number((text.match(/(\d+)%/) || [])[1] || 0);
			const hasSpecialist = [...document.querySelectorAll('.activity-row')].some((el) =>
				/specialist/i.test(el.textContent || '')
			);
			return hasSpecialist && progress >= 20;
		}, { timeout: ANALYSIS_TIMEOUT_MS }).catch(() => undefined);

		await sleep(1200);
		await shot(page, 'style-guidance-specialists.png');

		// ---- 3. Preference A vs B ----
		console.log('waiting for preference cards...');
		await page.waitForSelector('.calibration-card .candidate-grid', {
			timeout: ANALYSIS_TIMEOUT_MS
		});
		// Let a couple of cards accumulate if they arrive close together.
		await sleep(2500);
		await shot(page, 'style-guidance-preference.png');

		// Answer every ready comparison by preferring A (sides are randomized;
		// for docs we only need to clear the queue without hanging on busy cards).
		let safety = 0;
		while (safety < 60) {
			safety += 1;
			const firstA = page.locator('.calibration-card:not(.muted) button.candidate:not([disabled])').first();
			if (await firstA.count()) {
				await firstA.click({ timeout: 5_000 }).catch(() => undefined);
				await sleep(900);
				continue;
			}
			const status = await page.evaluate(async () => {
				const res = await fetch('/api/style-profile');
				return res.json();
			});
			const stillIncoming = await page.locator('.incoming').count();
			if (
				stillIncoming === 0 &&
				(status.unresolvedCount ?? 0) === 0 &&
				status.status !== 'analyzing'
			) {
				break;
			}
			await sleep(2000);
		}

		// Wait for analysis + calibrations to settle.
		const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const status = await page.evaluate(async () => {
				const res = await fetch('/api/style-profile');
				return res.json();
			});
			if (status.status !== 'analyzing' && (status.unresolvedCount ?? 0) === 0) break;
			await sleep(3000);
		}

		// ---- 4. Style draft / active skill pane ----
		console.log('opening style draft pane...');
		const draftTab = page.getByRole('button', { name: /Style draft|Active skill/ });
		await draftTab.click();
		await sleep(800);

		const dialog = page.getByRole('dialog', { name: /Calibrate your style/i });
		const finalize = dialog.locator('button.btn.primary', { hasText: /Finalize style|Update active skill/ }).first();
		if (await finalize.count() && !(await finalize.isDisabled().catch(() => true))) {
			await finalize.click({ force: true });
			await sleep(3000);
		} else {
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
		await page.locator('.backdrop').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

		// ---- 5. Editor directive + expanded pending edit ----
		console.log('waiting for agent edit from directive...');
		const dockPill = page.locator('.dock-agent-btn').first();
		if (await dockPill.count()) {
			await dockPill.click().catch(() => undefined);
			await sleep(400);
		}
		const wake = page.locator('.header-agent-btn').first();
		await wake.waitFor({ state: 'visible', timeout: 15_000 });
		await wake.click();

		const pending = page.locator('.gutter-card').first();
		await pending.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
		await page
			.waitForFunction(
				() => !document.querySelector('.header-agent-btn.awake, .dock-agent-btn.awake'),
				{ timeout: AGENT_TIMEOUT_MS }
			)
			.catch(() => undefined);
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
