#!/usr/bin/env node
/**
 * Capture PR/docs screenshots for:
 *   - Accept all / Reject all in the comment gutter
 *   - Paused agent pill (expanded + collapsed)
 *   - Freeze-for-agent prototype (selection popup + locked passage)
 *
 * Seeds pending review rounds over the live Hocuspocus doc so we don't
 * need an agent credential.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WebSocket from 'ws';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');
const ARTIFACTS_DIR = '/opt/cursor/artifacts';
const VIEWPORT = { width: 1400, height: 900 };

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

async function seedFixture() {
	const dir = await mkdtemp(join(tmpdir(), 'docwriter-pr-shots-'));
	await writeFile(
		join(dir, 'essay.md'),
		[
			'# A short essay',
			'',
			'This is the first paragraph. It is fine but could be tighter.',
			'',
			'This is the second paragraph. It rambles a bit and tries to cover too many ideas at once without committing to any of them.',
			'',
			'This is the third paragraph, which closes things out.',
			''
		].join('\n'),
		'utf8'
	);
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

async function setDockExpanded(page, expanded) {
	if (expanded) {
		const pill = page.locator('.dock-agent-btn').first();
		if (await pill.count()) {
			await pill.click();
			await sleep(400);
		}
	} else {
		const collapse = page.locator('[aria-label="Collapse dock"]').first();
		if (await collapse.count()) {
			await collapse.click();
			await sleep(400);
		}
	}
}

async function seedPendingRounds(httpPort, wsPort, tabId) {
	const sessionRes = await fetch(`http://127.0.0.1:${httpPort}/api/session`);
	const session = await sessionRes.json();
	const token = session.serverInstanceId;
	if (!token) throw new Error('no serverInstanceId from /api/session');

	const ydoc = new Y.Doc();
	const provider = new HocuspocusProvider({
		url: `ws://127.0.0.1:${wsPort}`,
		name: tabId,
		document: ydoc,
		token,
		WebSocketPolyfill: WebSocket
	});

	await new Promise((resolveFn, rejectFn) => {
		const t = setTimeout(() => rejectFn(new Error('WS sync timeout')), 15_000);
		const done = () => {
			clearTimeout(t);
			resolveFn();
		};
		if (provider.synced) done();
		else provider.on('synced', done);
	});
	await sleep(300);

	const rounds = ydoc.getArray('rounds');
	ydoc.transact(() => {
		while (rounds.length > 0) rounds.delete(0);
		rounds.push([
			{
				id: 'shot-round-1',
				operation: {
					type: 'edit',
					oldString: 'This is the first paragraph. It is fine but could be tighter.',
					newString: 'The first paragraph is fine, but it could be tighter.'
				},
				trigger: 'screenshot seed',
				timestamp: Date.now() - 2000,
				kind: 'tiny',
				stepCount: 1
			},
			{
				id: 'shot-round-2',
				operation: {
					type: 'edit',
					oldString:
						'This is the second paragraph. It rambles a bit and tries to cover too many ideas at once without committing to any of them.',
					newString:
						'The second paragraph rambles — too many ideas, none of them committed.'
				},
				trigger: 'screenshot seed',
				timestamp: Date.now() - 1000,
				kind: 'big',
				stepCount: 1
			}
		]);
	});

	await sleep(800);
	await provider.destroy();
	ydoc.destroy();
}

async function clearPendingRounds(httpPort, wsPort, tabId) {
	const sessionRes = await fetch(`http://127.0.0.1:${httpPort}/api/session`);
	const session = await sessionRes.json();
	const ydoc = new Y.Doc();
	const provider = new HocuspocusProvider({
		url: `ws://127.0.0.1:${wsPort}`,
		name: tabId,
		document: ydoc,
		token: session.serverInstanceId,
		WebSocketPolyfill: WebSocket
	});
	await new Promise((resolveFn, rejectFn) => {
		const t = setTimeout(() => rejectFn(new Error('WS sync timeout')), 15_000);
		const done = () => {
			clearTimeout(t);
			resolveFn();
		};
		if (provider.synced) done();
		else provider.on('synced', done);
	});
	const rounds = ydoc.getArray('rounds');
	ydoc.transact(() => {
		while (rounds.length > 0) rounds.delete(0);
	});
	await sleep(400);
	await provider.destroy();
	ydoc.destroy();
}

async function writeShot(page, basename) {
	await mkdir(IMAGES_DIR, { recursive: true });
	await mkdir(ARTIFACTS_DIR, { recursive: true });
	const docsPath = join(IMAGES_DIR, basename);
	const artPath = join(ARTIFACTS_DIR, basename);
	await page.screenshot({ path: docsPath, fullPage: false });
	await copyFile(docsPath, artPath);
	console.log(`  wrote ${basename}`);
}

async function main() {
	const workspace = await seedFixture();
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	console.log(`workspace ${workspace}`);
	console.log(`http :${httpPort}  ws :${wsPort}`);
	const child = await startViteDev(workspace, httpPort, wsPort);

	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({ viewport: VIEWPORT });
		const page = await context.newPage();
		await page.addInitScript(() => {
			localStorage.setItem('docwriter.dockExpanded', 'false');
		});
		await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
		await sleep(2500);

		const essay = page.locator('.tree-name', { hasText: /^essay\.md$/ }).first();
		await essay.click();
		await sleep(1500);

		await seedPendingRounds(httpPort, wsPort, 'essay.md');
		await sleep(1000);

		// Accept/Reject all live in the gutter — keep dock collapsed.
		await setDockExpanded(page, false);
		await page.locator('.gutter-batch-bar').first().waitFor({
			state: 'visible',
			timeout: 10_000
		});
		await writeShot(page, 'agent-accept-reject-all.png');

		// Pause via double-click on the collapsed pill, then expand to show dock.
		const pill = page.locator('.dock-agent-btn').first();
		await pill.dblclick();
		await sleep(400);
		await page.locator('.dock-agent-btn.paused').first().waitFor({
			state: 'visible',
			timeout: 5_000
		});
		await writeShot(page, 'agent-paused-pill.png');

		// Expand paused dock (single-click is no-op while paused — force expand).
		await page.evaluate(() => {
			localStorage.setItem('docwriter.dockExpanded', 'true');
		});
		// Toggle store via a resume+expand path: temporarily unpause isn't needed —
		// set dockExpanded from the page by clicking isn't available while paused.
		// Use evaluate to set the svelte store if exposed… fall back to keyboard?
		// Force by dispatching through localStorage + reload is heavy.
		// Instead: double-click to resume, click to expand, double-click to pause again.
		await pill.dblclick(); // resume
		await sleep(300);
		await setDockExpanded(page, true);
		await sleep(300);
		const agentBtn = page.locator('.header-agent-btn').first();
		await agentBtn.dblclick(); // pause again
		await sleep(500);
		// Move mouse away so tooltip doesn't cover the pill.
		await page.mouse.move(20, 20);
		await sleep(200);
		await page.locator('.header-agent-btn.paused').first().waitFor({
			state: 'visible',
			timeout: 5_000
		});
		await writeShot(page, 'agent-paused.png');

		// Freeze prototype: clear rounds, resume agent, select third paragraph, freeze.
		await agentBtn.dblclick(); // resume
		await sleep(200);
		await setDockExpanded(page, false);
		await clearPendingRounds(httpPort, wsPort, 'essay.md');
		await sleep(600);

		const editor = page.locator('.tiptap-content').first();
		await editor.click();
		await sleep(200);
		// Triple-click third paragraph via text search.
		const third = page.getByText('This is the third paragraph, which closes things out.').first();
		await third.click({ clickCount: 3 });
		await sleep(500);
		const freezeBtn = page.locator('.feedback-freeze-btn').first();
		await freezeBtn.waitFor({ state: 'visible', timeout: 5_000 });
		await writeShot(page, 'freeze-selection-popup.png');
		await freezeBtn.click();
		await sleep(800);
		await page.locator('.freeze-lock').first().waitFor({ state: 'visible', timeout: 5_000 });
		await page.locator('.freeze-mark').first().waitFor({ state: 'attached', timeout: 5_000 });
		await writeShot(page, 'freeze-passage.png');

		console.log('done');
	} finally {
		await browser.close();
		child.kill('SIGTERM');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
