#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WebSocket from 'ws';

const ROOT = resolve('.');
const IMAGES_DIR = join(ROOT, 'docs', 'images');
const VIEWPORT = { width: 1200, height: 780 };
const ONLY_SCENARIO = process.env.VIDEO_SCENARIO ?? '';

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => resolvePort(address.port));
		});
	});
}

async function seedWorkspace() {
	const workspace = await mkdtemp(join(tmpdir(), 'docwriter-videos-'));
	await writeFile(
		join(workspace, 'essay.md'),
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
	await writeFile(
		join(workspace, 'intro.md'),
		[
			'# Writing with AI',
			'',
			'Blue light scatters more strongly in the atmosphere.',
			'',
			'## Notes',
			''
		].join('\n'),
		'utf8'
	);
	await writeFile(
		join(workspace, 'preview.md'),
		['# Preview demo', '', 'This source file produces an HTML preview.', ''].join('\n'),
		'utf8'
	);
	await writeFile(
		join(workspace, 'preview.html'),
		[
			'<!doctype html>',
			'<html><body style="font: 18px system-ui; padding: 48px">',
			'<h1>Generated preview</h1>',
			'<p>The first generated version is ready.</p>',
			'<div style="height: 480px"></div>',
			'<p id="end">End of preview</p>',
			'</body></html>'
		].join('\n'),
		'utf8'
	);
	return workspace;
}

async function startApp(workspace, httpPort, wsPort) {
	const child = spawn(
		process.execPath,
		[
			join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
			'dev',
			'--host',
			'127.0.0.1',
			'--port',
			String(httpPort),
			'--strictPort'
		],
		{
			cwd: ROOT,
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
	for (let attempt = 0; attempt < 160; attempt += 1) {
		await sleep(250);
		try {
			const response = await fetch(`http://127.0.0.1:${httpPort}/`, { method: 'HEAD' });
			if (response.ok || response.status === 302 || response.status === 404) return child;
		} catch {
			// The server is still starting.
		}
	}
	child.kill();
	throw new Error('DocWriter did not start in 40 seconds');
}

async function openWorkspaceFile(page, httpPort, filename) {
	await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
	await sleep(2200);
	await page.locator('.tree-name', { hasText: new RegExp(`^${filename.replace('.', '\\.')}$`) }).first().click();
	await sleep(1200);
}

async function openEssay(page, httpPort) {
	await openWorkspaceFile(page, httpPort, 'essay.md');
}

async function seedReviewRounds(httpPort, wsPort) {
	const session = await fetch(`http://127.0.0.1:${httpPort}/api/session`).then((response) =>
		response.json()
	);
	const document = new Y.Doc();
	const provider = new HocuspocusProvider({
		url: `ws://127.0.0.1:${wsPort}`,
		name: 'essay.md',
		document,
		token: session.serverInstanceId,
		WebSocketPolyfill: WebSocket
	});
	await new Promise((resolveSync, reject) => {
		const timer = setTimeout(() => reject(new Error('WebSocket sync timed out')), 15_000);
		const done = () => {
			clearTimeout(timer);
			resolveSync();
		};
		if (provider.synced) done();
		else provider.on('synced', done);
	});
	const rounds = document.getArray('rounds');
	document.transact(() => {
		while (rounds.length > 0) rounds.delete(0);
		rounds.push([
			{
				id: 'video-round-1',
				operation: {
					type: 'edit',
					oldString: 'This is the first paragraph. It is fine but could be tighter.',
					newString: 'The first paragraph is useful, but it could be tighter.'
				},
				trigger: 'video seed',
				timestamp: Date.now() - 1000,
				kind: 'tiny',
				stepCount: 1
			},
			{
				id: 'video-round-2',
				operation: {
					type: 'edit',
					oldString:
						'This is the second paragraph. It rambles a bit and tries to cover too many ideas at once without committing to any of them.',
					newString: 'The second paragraph covers too many ideas without choosing one.'
				},
				trigger: 'video seed',
				timestamp: Date.now(),
				kind: 'big',
				stepCount: 1
			}
		]);
	});
	await sleep(700);
	await provider.destroy();
	document.destroy();
}

async function seedIntroRound(httpPort, wsPort) {
	const session = await fetch(`http://127.0.0.1:${httpPort}/api/session`).then((response) =>
		response.json()
	);
	const currentDocument = await fetch(
		`http://127.0.0.1:${httpPort}/api/document?tab=${encodeURIComponent('intro.md')}`
	).then((response) => response.json());
	const claimLine = String(currentDocument.content)
		.split('\n')
		.find((line) => line.startsWith('Blue light'));
	if (!claimLine) throw new Error('Could not find the intro claim after typing the directive');
	const document = new Y.Doc();
	const provider = new HocuspocusProvider({
		url: `ws://127.0.0.1:${wsPort}`,
		name: currentDocument.tabId,
		document,
		token: session.serverInstanceId,
		WebSocketPolyfill: WebSocket
	});
	await new Promise((resolveSync, reject) => {
		const timer = setTimeout(() => reject(new Error('WebSocket sync timed out')), 15_000);
		const done = () => {
			clearTimeout(timer);
			resolveSync();
		};
		if (provider.synced) done();
		else provider.on('synced', done);
	});
	const rounds = document.getArray('rounds');
	document.transact(() => {
		while (rounds.length > 0) rounds.delete(0);
		rounds.push([
			{
				id: 'intro-video-round',
				operation: {
					type: 'edit',
					oldString: claimLine,
					newString:
						'Blue light scatters more strongly in the atmosphere (Rayleigh, 1871).'
				},
				trigger: 'intro video seed',
				timestamp: Date.now(),
				kind: 'big',
				stepCount: 1
			}
		]);
	});
	await sleep(700);
	await provider.destroy();
	document.destroy();
}

async function recordedWebm(context, directory) {
	await context.close();
	const files = await readdir(directory);
	const name = files.find((file) => file.endsWith('.webm'));
	if (!name) throw new Error(`No video was written to ${directory}`);
	return join(directory, name);
}

function convertVideo(webm, basename, startSeconds = 0) {
	const webmOutput = join(IMAGES_DIR, `${basename}.webm`);
	const mp4Output = join(IMAGES_DIR, `${basename}.mp4`);
	const seek = startSeconds > 0 ? ['-ss', startSeconds.toFixed(2)] : [];
	const writeWebm =
		startSeconds > 0
			? Promise.resolve(
					spawnSync(
						'ffmpeg',
						[
							'-y',
							...seek,
							'-i',
							webm,
							'-vf',
							'scale=960:-2:flags=lanczos',
							'-an',
							'-c:v',
							'libvpx-vp9',
							'-crf',
							'34',
							'-b:v',
							'0',
							webmOutput
						],
						{ encoding: 'utf8' }
					)
				).then((result) => {
					if (result.status !== 0) throw new Error(result.stderr);
				})
			: copyFile(webm, webmOutput);
	return writeWebm.then(() => {
		const result = spawnSync(
			'ffmpeg',
			[
				'-y',
				...seek,
				'-i',
				webm,
				'-vf',
				'scale=960:-2:flags=lanczos',
				'-an',
				'-movflags',
				'+faststart',
				'-pix_fmt',
				'yuv420p',
				'-crf',
				'28',
				mp4Output
			],
			{ encoding: 'utf8' }
		);
		if (result.status !== 0) throw new Error(result.stderr);
		console.log(`wrote ${basename}.webm and ${basename}.mp4`);
	});
}

function convertGif(webm, basename, startSeconds = 0) {
	const output = join(IMAGES_DIR, `${basename}.gif`);
	const seek = startSeconds > 0 ? ['-ss', startSeconds.toFixed(2)] : [];
	const result = spawnSync(
		'ffmpeg',
		[
			'-y',
			...seek,
			'-i',
			webm,
			'-vf',
			'fps=9,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer',
			'-loop',
			'0',
			output
		],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) throw new Error(result.stderr);
	console.log(`wrote ${basename}.gif`);
}

async function installDemoCursor(page) {
	await page.evaluate(() => {
		const cursor = document.createElement('div');
		cursor.id = 'docs-demo-cursor';
		cursor.setAttribute('aria-hidden', 'true');
		cursor.innerHTML = `
			<svg viewBox="0 0 28 36" width="28" height="36" xmlns="http://www.w3.org/2000/svg">
				<path d="M3 2.5V27l6.8-6.2 5.1 11.1 5-2.3-5.1-10.8H24L3 2.5Z"
					fill="#171717" stroke="white" stroke-width="2.2" stroke-linejoin="round"/>
			</svg>
		`;
		Object.assign(cursor.style, {
			position: 'fixed',
			left: '0',
			top: '0',
			width: '28px',
			height: '36px',
			zIndex: '2147483647',
			pointerEvents: 'none',
			filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 45%))',
			opacity: '0',
			transform: 'translate(40px, 80px)',
			transition:
				'transform 500ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease-out'
		});
		document.body.append(cursor);
	});
}

async function moveDemoCursor(page, locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error('Could not place the demo cursor on a hidden element');
	await page.evaluate(
		({ x, y }) => {
			const cursor = document.querySelector('#docs-demo-cursor');
			if (!(cursor instanceof HTMLElement)) return;
			cursor.style.opacity = '1';
			cursor.style.transform = `translate(${x}px, ${y}px)`;
		},
		{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
	);
	await sleep(650);
}

async function captureIntro(browser, httpPort, wsPort) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-intro-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'false');
	});
	const startedAt = Date.now();
	const page = await context.newPage();
	await openWorkspaceFile(page, httpPort, 'intro.md');
	const clipStart = Math.max(0, (Date.now() - startedAt) / 1000 - 0.3);
	await installDemoCursor(page);
	const claim = page.locator('.tiptap-content p').filter({ hasText: /Blue light/ }).first();
	await moveDemoCursor(page, claim);
	await claim.click();
	await page.keyboard.press('End');
	await page.keyboard.type(' [[ cite this ]]', { delay: 55 });
	await sleep(600);
	await seedIntroRound(httpPort, wsPort);
	const accept = page.locator('.gutter-card .mini-btn.accept').first();
	await accept.waitFor({ state: 'visible', timeout: 10_000 });
	await sleep(900);
	const notes = page.locator('.tiptap-content p').last();
	await moveDemoCursor(page, notes);
	await notes.click();
	await page.keyboard.type('The writer keeps working while the suggestion waits.', { delay: 28 });
	await sleep(900);
	await moveDemoCursor(page, accept);
	await accept.click();
	await sleep(1500);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'intro-flow', clipStart);
	convertGif(webm, 'intro-flow', clipStart);
	await rm(directory, { recursive: true, force: true });
}

async function captureReview(browser, httpPort, wsPort) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-review-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'false');
	});
	const page = await context.newPage();
	await openEssay(page, httpPort);
	await seedReviewRounds(httpPort, wsPort);
	const cards = page.locator('.gutter-card.loose-edit-card');
	await cards.first().waitFor({ state: 'visible', timeout: 10_000 });
	await sleep(1200);
	await cards.first().hover();
	await sleep(1400);
	await cards.first().locator('.mini-btn.accept').click();
	await sleep(1800);
	await cards.first().hover();
	await sleep(1000);
	await cards.first().locator('.mini-btn.reject').click();
	await sleep(1600);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'review-workflow');
	await rm(directory, { recursive: true, force: true });
}

async function captureControls(browser, httpPort) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-controls-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'true');
	});
	const page = await context.newPage();
	await openEssay(page, httpPort);
	const agent = page.locator('.header-agent-btn').first();
	await agent.dblclick();
	await sleep(1500);
	await agent.dblclick();
	await sleep(900);
	await page.locator('.dock-message-btn').first().click();
	await sleep(700);
	await page.locator('.dock-chat-popover textarea').fill('Outline a tighter introduction.');
	await sleep(900);
	await page.locator('.dock-chat-popover input[type="checkbox"]').check();
	await sleep(1400);
	await page.keyboard.press('Escape');
	await sleep(800);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'agent-controls');
	await rm(directory, { recursive: true, force: true });
}

async function captureMute(browser, httpPort, wsPort) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-mute-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'true');
	});
	const page = await context.newPage();
	await openEssay(page, httpPort);
	await seedReviewRounds(httpPort, wsPort);
	await page.locator('.gutter-card').first().waitFor({ state: 'visible', timeout: 10_000 });
	await sleep(1400);
	const mute = page.locator('.header-actions button.header-pill-btn[aria-pressed]').first();
	await mute.click();
	await page.waitForFunction(
		() => document.querySelector('.header-actions button[aria-pressed="true"]') !== null,
		{ timeout: 5000 }
	);
	await sleep(2200);
	await mute.click();
	await sleep(1800);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'mute-proposals');
	await rm(directory, { recursive: true, force: true });
}

async function capturePlan(browser, httpPort) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-plan-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'true');
	});
	const page = await context.newPage();
	const startedAt = Date.now();
	await openEssay(page, httpPort);
	await page.locator('.dock-message-btn').first().click();
	await page.locator('.dock-chat-popover textarea').fill(
		'Plan one concise edit that would make the first paragraph clearer. Do not edit yet.'
	);
	await page.locator('.dock-chat-popover input[type="checkbox"]').check();
	await page.locator('.dock-chat-popover .send-btn').click();
	const modal = page.locator('.agent-modal--plan');
	await modal.waitFor({ state: 'visible', timeout: 120_000 });
	const clipStart = Math.max(0, (Date.now() - startedAt) / 1000 - 4);
	await sleep(1800);
	const run = modal.locator('button', { hasText: /Run it/ });
	await run.hover();
	await sleep(900);
	await run.click();
	await sleep(3500);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'plan-workflow', clipStart);
	await rm(directory, { recursive: true, force: true });
}

async function captureSplitPreview(browser, httpPort, workspace) {
	const directory = await mkdtemp(join(tmpdir(), 'docwriter-preview-video-'));
	const context = await browser.newContext({
		viewport: VIEWPORT,
		recordVideo: { dir: directory, size: VIEWPORT }
	});
	await context.addInitScript(() => {
		localStorage.setItem('docwriter.dockExpanded', 'false');
	});
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
	await sleep(1800);
	await page.evaluate(async () => {
		await fetch('/api/hooks', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				hooks: [
					{
						id: 'video-preview-hook',
						event: 'PostToolUse',
						matcher: 'Edit|Write',
						command: 'true',
						enabled: true,
						output: 'preview.html'
					}
				]
			})
		});
	});
	await page.locator('.tree-name', { hasText: /^preview\.md$/ }).first().click();
	await sleep(1600);
	await page.locator('[aria-label="Open side preview"]').click();
	await page.locator('.split-preview-pane').waitFor({ state: 'visible', timeout: 10_000 });
	await sleep(1700);
	const resizer = page.locator('.source-preview-layout > .resizer').first();
	const box = await resizer.boundingBox();
	if (box) {
		await page.mouse.move(box.x + box.width / 2, box.y + 120);
		await page.mouse.down();
		await page.mouse.move(box.x - 120, box.y + 120, { steps: 12 });
		await page.mouse.up();
	}
	await sleep(1600);
	await writeFile(
		join(workspace, 'preview.html'),
		[
			'<!doctype html>',
			'<html><body style="font: 18px system-ui; padding: 48px">',
			'<h1>Generated preview</h1>',
			'<p style="color:#6d28d9">The preview reloaded after the output changed.</p>',
			'<div style="height: 480px"></div>',
			'<p id="end">End of updated preview</p>',
			'</body></html>'
		].join('\n'),
		'utf8'
	);
	await fetch(`http://127.0.0.1:${httpPort}/api/live`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			event: 'preview_ready',
			path: join(workspace, 'preview.html')
		})
	});
	await sleep(2600);
	const webm = await recordedWebm(context, directory);
	await convertVideo(webm, 'split-preview');
	await rm(directory, { recursive: true, force: true });
}

async function main() {
	await mkdir(IMAGES_DIR, { recursive: true });
	const workspace = await seedWorkspace();
	const httpPort = await freePort();
	const wsPort = await freePort();
	const server = await startApp(workspace, httpPort, wsPort);
	const browser = await chromium.launch({ headless: true });
	try {
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'intro') await captureIntro(browser, httpPort, wsPort);
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'review') await captureReview(browser, httpPort, wsPort);
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'controls') await captureControls(browser, httpPort);
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'mute') await captureMute(browser, httpPort, wsPort);
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'plan') await capturePlan(browser, httpPort);
		if (!ONLY_SCENARIO || ONLY_SCENARIO === 'preview') {
			await captureSplitPreview(browser, httpPort, workspace);
		}
	} finally {
		await browser.close();
		server.kill('SIGTERM');
		await sleep(500);
		await rm(workspace, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
