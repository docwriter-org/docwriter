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

async function openEssay(page, httpPort) {
	await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
	await sleep(2200);
	await page.locator('.tree-name', { hasText: /^essay\.md$/ }).first().click();
	await sleep(1200);
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

async function recordedWebm(context, directory) {
	await context.close();
	const files = await readdir(directory);
	const name = files.find((file) => file.endsWith('.webm'));
	if (!name) throw new Error(`No video was written to ${directory}`);
	return join(directory, name);
}

function convertVideo(webm, basename) {
	const webmOutput = join(IMAGES_DIR, `${basename}.webm`);
	const mp4Output = join(IMAGES_DIR, `${basename}.mp4`);
	return copyFile(webm, webmOutput).then(() => {
		const result = spawnSync(
			'ffmpeg',
			[
				'-y',
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

async function main() {
	await mkdir(IMAGES_DIR, { recursive: true });
	const workspace = await seedWorkspace();
	const httpPort = await freePort();
	const wsPort = await freePort();
	const server = await startApp(workspace, httpPort, wsPort);
	const browser = await chromium.launch({ headless: true });
	try {
		await captureReview(browser, httpPort, wsPort);
		await captureControls(browser, httpPort);
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
