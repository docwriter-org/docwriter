#!/usr/bin/env node
/**
 * docs/capture-screenshots.mjs
 *
 * Drives DocWriter through a series of UI states and writes PNG
 * screenshots into docs/images/.
 *
 * Two kinds of captures:
 *   - Structural states (file open, menu open, popover open). Always run.
 *   - Agent-driven states (pending review after the agent edits).
 *     Require Claude credentials (claude login or ANTHROPIC_API_KEY).
 *     Skipped gracefully if no auth is available, or via SKIP_AGENT=1.
 *
 * Usage:
 *   npm run docs:screenshots
 *
 * One-time setup:
 *   npx playwright install chromium
 *
 * Env vars:
 *   SKIP_AGENT=1     Don't drive the agent (skip pending-review captures).
 *   KEEP_FIXTURE=1   Leave the temp fixture workspace on disk after the run.
 *   AGENT_TIMEOUT_MS Override the wait for a pending review (default 90000).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');
const KEEP_FIXTURE = !!process.env.KEEP_FIXTURE;
const SKIP_AGENT = !!process.env.SKIP_AGENT;
const SKIP_LATEX = !!process.env.SKIP_LATEX;
const SKIP_GIF = !!process.env.SKIP_GIF;
const SKIP_STRUCTURAL = !!process.env.SKIP_STRUCTURAL;
const SKIP_BLOG = !!process.env.SKIP_BLOG;
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? '', 10) || 90_000;
const VIEWPORT = { width: 1400, height: 900 };
const VLDB_TEMPLATE_URL = 'https://github.com/cwida/pvldbstyle/archive/master.zip';

function findFfmpeg() {
	// Prefer a full ffmpeg on PATH (Playwright's bundled ffmpeg is built
	// without a GIF muxer, so it can decode our WebM but can't write
	// .gif). Caller is expected to print install hints if this returns
	// null.
	const hostCandidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
	for (const cand of hostCandidates) {
		const r = spawnSync(cand, ['-version'], { encoding: 'utf8' });
		if (r.status === 0) return cand;
	}
	return null;
}

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

const ESSAY_CONTENT = `# A short essay

This is the first paragraph. It is fine but could be tighter.

This is the second paragraph. It rambles a bit and tries to cover too
many ideas at once without committing to any of them. [[ tighten this
paragraph and cut the ones-that-could-be-bs hedging ]]

This is the third paragraph, which closes things out.
`;

const INTRO_CONTENT = `# Async writing demo

`;

const BLOG_CONTENT = `# What we learned building agentic interfaces

A year of shipping AI-native developer tools surfaced a handful of
patterns that surprised us. Three of them are worth writing down.

## Latency dominates the perceived experience

User patience for AI tool response times is much lower than we expected
going in.

[[ Find a recent (2023-2025) study or write-up that measures user
tolerance for AI tool latency or response delay. Add a one-sentence
summary inline with a markdown footnote citation. ]]

## Async beats turn-based for creative work

The pattern that surprised us most: users prefer asynchronous AI
workflows when the task is creative rather than transactional. They
wanted the AI to work alongside them, not in a separate chat window.

[[ Verify: there is likely recent HCI research comparing turn-based
versus asynchronous human-AI collaboration interfaces. Search for it
and cite a relevant paper with a footnote if found. ]]

## Voice consistency is the hardest part

The default voice of any frontier model is not your voice, and the
gap matters more in writing than in code.
`;

async function seedFixture() {
	const dir = await mkdtemp(join(tmpdir(), 'docwriter-docs-'));
	await mkdir(join(dir, 'drafts'), { recursive: true });
	await writeFile(join(dir, 'essay.md'), ESSAY_CONTENT, 'utf8');
	await writeFile(join(dir, 'intro.md'), INTRO_CONTENT, 'utf8');
	await writeFile(join(dir, 'blog-post.md'), BLOG_CONTENT, 'utf8');
	await writeFile(
		join(dir, 'outline.md'),
		['# Outline', '', '- introduction', '- argument', '- conclusion', ''].join('\n'),
		'utf8'
	);
	await writeFile(
		join(dir, 'drafts', 'chapter-1.md'),
		['# Chapter 1', '', 'Opening paragraph.', ''].join('\n'),
		'utf8'
	);
	return dir;
}

function hasLatex() {
	const r = spawnSync('which', ['pdflatex'], { encoding: 'utf8' });
	return r.status === 0 && r.stdout.trim().length > 0;
}

async function seedVldbProject(fixtureDir) {
	const paperDir = join(fixtureDir, 'paper');
	await mkdir(paperDir, { recursive: true });
	const zipPath = join(fixtureDir, 'pvldb.zip');
	console.log('  downloading VLDB template...');
	const dl = spawnSync('curl', ['-L', '-s', '-o', zipPath, VLDB_TEMPLATE_URL], {
		encoding: 'utf8'
	});
	if (dl.status !== 0) throw new Error('failed to download VLDB template');
	console.log('  extracting...');
	const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', fixtureDir], {
		encoding: 'utf8'
	});
	if (unzip.status !== 0) throw new Error('failed to extract VLDB template');
	// The zip extracts to pvldbstyle-master/; move its contents into paper/.
	const extracted = join(fixtureDir, 'pvldbstyle-master');
	const mv = spawnSync('sh', ['-c', `mv "${extracted}"/* "${paperDir}/"`], { encoding: 'utf8' });
	if (mv.status !== 0) throw new Error('failed to relocate VLDB template');
	await rm(extracted, { recursive: true, force: true });
	await rm(zipPath, { force: true });
}

function buildLatexPdf(paperDir, entry) {
	console.log(`  building ${entry} with pdflatex...`);
	const env = {
		...process.env,
		PATH: `/usr/local/texlive/2025/bin/universal-darwin:${process.env.PATH ?? ''}`
	};
	const args = ['-interaction=nonstopmode', '-halt-on-error', '-synctex=1', entry];
	for (let i = 0; i < 3; i++) {
		const r = spawnSync('pdflatex', args, { cwd: paperDir, encoding: 'utf8', env });
		if (r.status !== 0) {
			console.log(`  pdflatex pass ${i + 1} failed (will try to continue):`);
			console.log(r.stdout?.slice(-1200) ?? '');
			return false;
		}
	}
	const pdf = entry.replace(/\.tex$/, '.pdf');
	return existsSync(join(paperDir, pdf));
}

async function configurePdflatexHook(httpPort, texEntry, pdfOutput) {
	const hook = {
		id: 'h_screenshot_pdflatex_' + Date.now().toString(36),
		event: 'PostToolUse',
		matcher: 'Edit|Write',
		command: `cd paper && pdflatex -interaction=nonstopmode -synctex=1 ${texEntry}`,
		enabled: true,
		output: `paper/${pdfOutput}`
	};
	const res = await fetch(`http://127.0.0.1:${httpPort}/api/hooks`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ hooks: [hook] })
	});
	if (!res.ok) throw new Error(`failed to configure hook: HTTP ${res.status}`);
}

/** Inject a `[[ ... ]]` directive into the .tex file so the agent, on
 * wake-up, picks it up and produces an interesting edit. The directive
 * is placed after the abstract or, failing that, before \end{document}
 * so it lands in the visible body of the rendered paper. */
async function injectTexDirective(paperDir, entry) {
	const path = join(paperDir, entry);
	const content = await readFile(path, 'utf8');
	// LaTeX-safe directive: prefixed with `%` so pdflatex treats the line
	// as a comment (in case it builds before the agent gets a chance to
	// remove the directive). Constrains the TikZ to libraries the
	// preamble actually loads, to avoid build failures from the agent
	// reaching for `calc` or other niche libraries.
	const directive = [
		'',
		'% [[ Add a small TikZ figure here illustrating writer-agent-document collaboration: three labeled nodes (Writer, Agent, Document) with bidirectional arrows. Add \\usepackage{tikz} and \\usetikzlibrary{positioning, arrows.meta} to the preamble (no other libraries). Use simple positioning like [right=of writer]; do NOT use the calc library or coordinate calculations. Wrap in a figure environment with caption "Collaboration in DocWriter". Keep TikZ under 12 lines. Replace this entire commented line with your figure. ]]',
		''
	].join('\n');
	// Try to place it right after the first \section or after \maketitle.
	const sectionMatch = content.match(/\\section\{[^}]*\}/);
	let next;
	if (sectionMatch) {
		const idx = sectionMatch.index + sectionMatch[0].length;
		next = content.slice(0, idx) + '\n' + directive + content.slice(idx);
	} else {
		next = content.replace('\\end{document}', directive + '\n\\end{document}');
	}
	await writeFile(path, next, 'utf8');
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
			/* not ready yet */
		}
	}
	child.kill();
	throw new Error(`vite dev did not come up on port ${httpPort} in 40s`);
}

async function shot(page, name) {
	const path = join(IMAGES_DIR, name);
	await page.screenshot({ path, fullPage: false });
	console.log(`  wrote ${name}`);
}

async function openFile(page, label) {
	// Click the tree-name span with the exact label text. The click bubbles
	// to the parent .tree-row's onclick handler which opens the file.
	const name = page.locator('.tree-name', { hasText: new RegExp(`^${label}$`) }).first();
	await name.click();
	await sleep(500);
}

async function expandFolder(page, label) {
	const name = page.locator('.tree-name', { hasText: new RegExp(`^${label}$`) }).first();
	if ((await name.count()) === 0) return false;
	await name.click();
	await sleep(400);
	return true;
}

async function openSettingsMenu(page) {
	const trigger = page.locator('.menu-trigger', { hasText: /^Settings$/ }).first();
	await trigger.click();
	await sleep(200);
}

async function hoverSettingsItem(page, label) {
	await openSettingsMenu(page);
	const item = page.locator('.menu-item', { hasText: label }).first();
	await item.hover();
	await sleep(500);
}

async function closeMenu(page) {
	await page.keyboard.press('Escape');
	await sleep(200);
}

/** Inject a transparent overlay with labeled bounding boxes on top of
 * the live DocWriter UI, so the captured screenshot can call out the
 * major interface regions by name. Pairs with `clearAnnotations`. */
async function annotateInterface(page) {
	await page.evaluate(() => {
		// Keep annotations to a small set of non-overlapping labels.
		// Each `anchor` picks which corner of the element the label
		// attaches to: tl=top-left, tr=top-right, bl=bottom-left, br=bottom-right.
		const targets = [
			{ selector: '.menu-bar',            label: 'Menu bar',             anchor: 'tl' },
			{ selector: '.file-tree',           label: 'File tree',            anchor: 'bl' },
			{ selector: '.outline-pane',        label: 'Outline / TOC',        anchor: 'tl' },
			{ selector: '.tiptap-content',      label: 'Editor',               anchor: 'bl' },
			{ selector: '.history-pane',        label: 'History pane',         anchor: 'tr' },
			{ selector: '.pending-wrap',        label: 'Pending agent edits',  anchor: 'tl' },
			{ selector: '.header-agent-btn',    label: 'Wake-up button',       anchor: 'bl' }
		];
		const overlay = document.createElement('div');
		overlay.setAttribute('data-doc-annotations', '');
		overlay.style.cssText =
			'position:fixed;inset:0;pointer-events:none;z-index:99999;font:600 11px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;';
		document.body.appendChild(overlay);
		const PURPLE = '#7c3aed';
		for (const { selector, label, anchor } of targets) {
			const el = document.querySelector(selector);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 20 || r.height < 12) continue;
			const box = document.createElement('div');
			box.style.cssText =
				`position:absolute;left:${r.left - 1}px;top:${r.top - 1}px;` +
				`width:${r.width + 2}px;height:${r.height + 2}px;` +
				`box-sizing:border-box;border:2px solid ${PURPLE};` +
				'background:rgba(124,58,237,0.05);border-radius:4px;';
			overlay.appendChild(box);
			const lbl = document.createElement('div');
			// Anchor the label to the chosen corner of the box.
			// tl = inside top-left, tr = inside top-right,
			// bl = outside bottom-left (below), br = outside bottom-right (below).
			const horiz = anchor.includes('r')
				? `left:${r.right - 4}px;transform:translateX(-100%);`
				: `left:${r.left + 4}px;`;
			const vert = anchor.includes('b')
				? `top:${r.bottom + 4}px;`
				: `top:${r.top + 4}px;`;
			lbl.style.cssText =
				`position:absolute;${horiz}${vert}` +
				`background:${PURPLE};color:white;padding:2px 7px;border-radius:3px;` +
				'white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.2);';
			lbl.textContent = label;
			overlay.appendChild(lbl);
		}
	});
	await sleep(300);
}

async function clearAnnotations(page) {
	await page.evaluate(() => {
		document.querySelectorAll('[data-doc-annotations]').forEach((n) => n.remove());
	});
}

async function captureStructural(page) {
	console.log('capturing structural screenshots...');

	await page.goto(`http://127.0.0.1:${page.context().__httpPort}`, {
		waitUntil: 'domcontentloaded'
	});
	await sleep(2500);

	await openFile(page, 'essay.md');
	await shot(page, 'quickstart-essay-open.png');
	await shot(page, 'inline-directives-in-doc.png');

	// Annotated interface overview: with essay.md open (so the Send
	// button and other affordances are visible), overlay labeled
	// bounding boxes on the major regions. The tour page reads them
	// off this image.
	await annotateInterface(page);
	await shot(page, 'tour-interface-overview.png');
	await clearAnnotations(page);

	// Close-up of the AGENT zz wake-up button for the steering page.
	const agentPillEl = page.locator('.header-agent-btn').first();
	const agentPillBox = await agentPillEl.boundingBox();
	if (agentPillBox) {
		const PAD = 16;
		const clip = {
			x: Math.max(0, agentPillBox.x - PAD),
			y: Math.max(0, agentPillBox.y - PAD),
			width: Math.min(VIEWPORT.width, agentPillBox.width + PAD * 2 + 120),
			height: agentPillBox.height + PAD * 2
		};
		await page.evaluate(({ x, y, w, h }) => {
			const d = document.createElement('div');
			d.setAttribute('data-doc-annotations', '');
			d.style.cssText =
				`position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
				'box-sizing:border-box;border:2.5px solid #7c3aed;border-radius:6px;' +
				'background:rgba(124,58,237,0.08);pointer-events:none;z-index:99999;';
			document.body.appendChild(d);
		}, { x: agentPillBox.x - 1, y: agentPillBox.y - 1, w: agentPillBox.width + 2, h: agentPillBox.height + 2 });
		await page.screenshot({ path: join(IMAGES_DIR, 'agent-wakeup-button.png'), clip });
		console.log('  wrote agent-wakeup-button.png');
		await clearAnnotations(page);
	}

	// Editor with find bar open. Click the editor first to focus it.
	await page.locator('.tiptap-content').first().click();
	await sleep(200);
	await page.keyboard.press('Meta+f');
	await sleep(600);
	await shot(page, 'editor-find-bar.png');
	await page.keyboard.press('Escape');
	await sleep(300);

	// Multiple tabs: open outline.md alongside the already-open essay.md.
	await openFile(page, 'outline.md');
	await sleep(400);
	await shot(page, 'editor-tabs.png');
	// Switch back to essay.md for subsequent shots.
	await page.locator('.tab-bar [role="tab"]', { hasText: 'essay.md' }).first().click();
	await sleep(300);

	// Inline-feedback popup: triple-click a paragraph in the prose. The
	// editor's selection listener fires, and the feedback popup pops up
	// anchored to the selection.
	const paragraph = page
		.locator('.tiptap-content p', { hasText: /rambles a bit/ })
		.first();
	await paragraph.click({ clickCount: 3 });
	await sleep(1000);
	await shot(page, 'inline-feedback-popup.png');
	await page.keyboard.press('Escape');
	await sleep(300);

	await hoverSettingsItem(page, 'Hooks');
	await shot(page, 'hooks-panel.png');
	await closeMenu(page);

	await hoverSettingsItem(page, 'Writing rules');
	await shot(page, 'writing-rules-panel.png');
	await closeMenu(page);

	await hoverSettingsItem(page, 'Writing references');
	await shot(page, 'writing-references-panel.png');
	await closeMenu(page);

	const sendBtn = page.locator('.dock-message-btn').first();
	await sendBtn.click();
	await sleep(400);
	const textarea = page.locator('.dock-chat-popover textarea').first();
	await textarea.fill('Make the introduction shorter.');
	await sleep(300);
	await shot(page, 'chat-popover.png');
	await page.keyboard.press('Escape');
	await sleep(300);
}

async function selectModel(page, modelLabel) {
	await openSettingsMenu(page);
	const modelItem = page.locator('.menu-item', { hasText: 'Model' }).first();
	if (!(await modelItem.count())) {
		await closeMenu(page);
		return false;
	}
	await modelItem.hover();
	await sleep(300);
	const choice = page.locator('.submenu-panel .menu-item', { hasText: modelLabel }).first();
	if (!(await choice.count())) {
		await closeMenu(page);
		return false;
	}
	await choice.click();
	await sleep(300);
	return true;
}

async function captureIntroGif(browser, httpPort, ffmpegPath) {
	console.log('capturing intro flow GIF...');
	const videoDir = await mkdtemp(join(tmpdir(), 'docwriter-gif-'));
	const gifContext = await browser.newContext({
		viewport: { width: 1200, height: 780 },
		recordVideo: { dir: videoDir, size: { width: 1200, height: 780 } }
	});
	const page = await gifContext.newPage();
	try {
		await page.goto(`http://127.0.0.1:${httpPort}`, { waitUntil: 'domcontentloaded' });
		await sleep(2200);

		await selectModel(page, 'Haiku');

		await openFile(page, 'intro.md');
		await sleep(700);

		const editor = page.locator('.tiptap-content').first();
		await editor.click();
		await sleep(300);
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');

		// Phase 1: type an opening sentence with a bracketed directive
		// at the end. Then stop. Auto-wake fires three seconds after the
		// last keystroke; the agent reads the doc and starts working.
		await page.keyboard.type('DocWriter feels different from a chat-based AI tool.', {
			delay: 35
		});
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await page.keyboard.type('<< rewrite the previous sentence with a punchier hook >>', {
			delay: 30
		});

		// Wait for the auto-wake to actually fire (the agent pill picks
		// up the .awake class). Fall through if the pill never goes
		// awake within the timeout (agent might already be past the
		// awake state if it finishes very fast).
		try {
			await page.waitForFunction(
				() => !!document.querySelector('.header-agent-btn.awake'),
				{ timeout: 10000 }
			);
		} catch {
			console.log('  agent never went awake in time; continuing anyway');
		}

		// Phase 2: keep writing while the agent is working. Type
		// substantial content — multiple sentences — so the viewer can
		// see real concurrent work, not a dead wait. Each keystroke
		// resets the idle timer, but the agent is already running from
		// Phase 1's trigger so it continues regardless.
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		const concurrentText = [
			'This is the core tension in every AI writing tool I\'ve tried.',
			' The model wants to take over; the writer wants to stay in control.',
			' What if those two goals didn\'t have to conflict?',
			' What if the AI edited alongside you, in the same document,',
			' proposing changes you could accept or reject inline?'
		];
		for (const chunk of concurrentText) {
			await page.keyboard.type(chunk, { delay: 38 });
		}

		const pending = page.locator('.pending-card.round-card').first();
		try {
			await pending.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
		} catch {
			console.log('  pending review never appeared in GIF window');
			return;
		}
		// Brief pause so the viewer can see the review card before accept.
		await sleep(1500);

		// Click Accept on the pending review so the GIF ends with the
		// suggestion landing in the document.
		const acceptBtn = page.locator('.pending-card.round-card .btn-accept').first();
		if (await acceptBtn.count()) {
			await acceptBtn.click();
			await sleep(1800);
		}
	} finally {
		await gifContext.close();
	}

	// Find the recorded webm.
	const lsR = spawnSync('sh', ['-c', `ls "${videoDir}"/*.webm 2>/dev/null | head -1`], {
		encoding: 'utf8'
	});
	const webm = lsR.stdout?.trim();
	if (!webm) {
		console.log('  no video produced, skipping GIF');
		await rm(videoDir, { recursive: true, force: true });
		return;
	}
	const gifOut = join(IMAGES_DIR, 'intro-flow.gif');
	console.log('  converting webm to gif with ffmpeg...');
	// Cap duration at 40s: typing + directive, pause, auto-wake,
	// substantial concurrent typing while the agent works, review
	// card appearing, and Accept. 9fps + 800px + 64 colors.
	const ff = spawnSync(
		ffmpegPath,
		[
			'-y',
			'-t',
			'40',
			'-i',
			webm,
			'-vf',
			'fps=9,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer',
			'-loop',
			'0',
			gifOut
		],
		{ encoding: 'utf8' }
	);
	if (ff.status !== 0) {
		console.log('  ffmpeg failed:');
		console.log(ff.stderr?.slice(-1500));
	} else {
		console.log(`  wrote intro-flow.gif`);
	}
	await rm(videoDir, { recursive: true, force: true });
}

async function captureTranscript(page) {
	console.log('capturing transcript viewer screenshots...');
	const transcriptBtn = page.locator('button:has-text("Transcript")').first();
	if (!(await transcriptBtn.count())) {
		console.log('  Transcript button not found; skipping');
		return;
	}
	await transcriptBtn.click();
	await sleep(1500);
	await shot(page, 'transcript-overview.png');

	// Try to expand the first row that has an "expand" affordance to
	// show what input/output looks like for a single tool call.
	const expandBtn = page.locator('button:has-text("expand")').first();
	if (await expandBtn.count()) {
		await expandBtn.click().catch(() => undefined);
		await sleep(700);
		await shot(page, 'transcript-detail.png');
	}
	await page.keyboard.press('Escape');
	await sleep(500);
}

async function captureCommentThread(page) {
	console.log('capturing comment thread...');
	// Triple-click a paragraph to open the inline-feedback popup, switch
	// to Discuss mode, type a question, submit. The agent posts a comment.
	const paragraph = page
		.locator('.tiptap-content p', { hasText: /third paragraph/ })
		.first();
	if (!(await paragraph.count())) {
		console.log('  paragraph anchor not found; skipping comment shot');
		return;
	}
	await paragraph.click({ clickCount: 3 });
	await sleep(700);
	const discussChip = page.locator('.mode-chip', { hasText: /^Discuss$/ }).first();
	if (await discussChip.count()) await discussChip.click();
	await sleep(200);
	const input = page.locator('.feedback-popup [contenteditable], .feedback-popup textarea').first();
	if (await input.count()) {
		await input.click();
		await page.keyboard.type('Does this paragraph actually close the essay?', {
			delay: 30
		});
	}
	const goBtn = page.locator('.feedback-submit, .feedback-popup button:has-text("Go")').first();
	if (await goBtn.count()) await goBtn.click();
	await sleep(2500);

	// Wait for a comment thread to appear in the gutter / margin.
	const commentMarker = page.locator('.comment-gutter, [class*="comment"]').first();
	try {
		await commentMarker.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
	} catch {
		console.log('  comment thread did not appear in time; skipping');
		return;
	}
	// If there's an indicator, click it to expand the thread inline.
	await commentMarker.click().catch(() => undefined);
	await sleep(1200);
	await shot(page, 'comment-thread.png');
}

async function captureBlogResearch(page) {
	console.log('capturing blog-research scenario...');
	await openFile(page, 'blog-post.md');
	await sleep(800);
	await shot(page, 'blog-post-open.png');

	console.log('  waking agent (web search may take a couple minutes)...');
	const agentPill = page.locator('.header-agent-btn').first();
	await agentPill.click();

	const pending = page.locator('.pending-card.round-card').first();
	try {
		await pending.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
	} catch {
		console.log('  agent did not produce a pending review; skipping');
		return;
	}
	console.log('  waiting for agent to finish (web search + edits)...');
	try {
		await page.waitForFunction(
			() => !document.querySelector('.header-agent-btn.awake'),
			{ timeout: 180_000 }
		);
	} catch {
		console.log('  agent still working at timeout; capturing anyway');
	}
	await sleep(1500);
	await shot(page, 'blog-pending-edit.png');
}

async function captureLatex(page, context, fixtureDir, httpPort) {
	console.log('capturing LaTeX scenario...');
	// Find the entry tex file in the VLDB sample (usually sample-vldb.tex
	// or sample.tex).
	const candidates = ['sample-vldb.tex', 'sample.tex', 'main.tex'];
	const paperDir = join(fixtureDir, 'paper');
	let entry = null;
	for (const c of candidates) {
		if (existsSync(join(paperDir, c))) {
			entry = c;
			break;
		}
	}
	if (!entry) {
		console.log('  no entry .tex found in paper/; skipping');
		return;
	}
	const pdfName = entry.replace(/\.tex$/, '.pdf');
	console.log(`  entry: paper/${entry} -> paper/${pdfName}`);

	if (!buildLatexPdf(paperDir, entry)) {
		console.log('  PDF build failed; skipping LaTeX shots');
		return;
	}
	await configurePdflatexHook(httpPort, entry, pdfName);
	console.log('  injecting TikZ directive into .tex source...');
	await injectTexDirective(paperDir, entry);

	// Tidy the file tree for this scenario: remove the unrelated
	// markdown fixture files so the editor shows a clean LaTeX project.
	console.log('  removing unrelated markdown fixtures...');
	for (const f of ['essay.md', 'intro.md', 'outline.md', 'blog-post.md']) {
		await rm(join(fixtureDir, f), { force: true });
	}
	await rm(join(fixtureDir, 'drafts'), { recursive: true, force: true });
	// Reload the page so the file tree refreshes from disk.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await sleep(2000);

	// Expand the paper/ folder in the file tree, then open the entry file.
	await expandFolder(page, 'paper');
	await openFile(page, entry);
	await sleep(800);
	await shot(page, 'overleaf-tex-open.png');

	// Wake the agent. The .tex file contains the injected directive; the
	// agent's auto-handle behavior will pick it up.
	console.log('  waking agent (this can take a minute for a TikZ figure)...');
	const agentPill = page.locator('.header-agent-btn').first();
	await agentPill.click();

	// Demonstrate concurrent editing: while the agent is working on the
	// directive, the user types a sentence elsewhere in the document.
	// Both edits land in the same buffer; the screenshot taken later
	// shows the agent's pending review next to the user's just-typed
	// prose.
	await sleep(2500);
	console.log('  user typing concurrently while agent works...');
	await page.evaluate(() => {
		const editor = window.__docwriterEditor;
		if (!editor) return;
		// Land the cursor near a known body paragraph (the VLDB template's
		// abstract opens with "Praesent imperdiet"). End of that line is
		// a safe LaTeX-syntax spot to append prose.
		const needle = 'Praesent imperdiet';
		let pos = null;
		editor.state.doc.descendants((node, p) => {
			if (pos !== null || !node.isText || !node.text) return true;
			const idx = node.text.indexOf(needle);
			if (idx >= 0) {
				pos = p + idx + node.text.length;
				return false;
			}
		});
		if (pos !== null) editor.chain().focus().setTextSelection(pos).run();
	});
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type(
		'(Note typed by the user concurrently with the agent.)',
		{ delay: 35 }
	);

	const pendingCard = page.locator('.pending-card.round-card').first();
	try {
		await pendingCard.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
	} catch {
		console.log('  agent did not produce a pending review; skipping rest');
		return;
	}

	// Wait for the agent to actually stop running (pill loses .awake
	// class). It may make several edit_doc calls in sequence and we want
	// the final state, not the first one.
	console.log('  waiting for agent to finish all edits...');
	try {
		await page.waitForFunction(
			() => !document.querySelector('.header-agent-btn.awake'),
			{ timeout: AGENT_TIMEOUT_MS }
		);
	} catch {
		console.log('  agent still working at timeout; capturing anyway');
	}
	await sleep(1500);
	await shot(page, 'overleaf-pending-edit.png');

	// Accept all pending reviews in FIFO order. Only the oldest card has
	// an Accept button visible at any time, so this loop walks through
	// them. Pending content only reaches disk after acceptance (the disk
	// flush writes the base text, not pending-review overlays).
	console.log('  accepting pending reviews so changes land on disk...');
	for (let i = 0; i < 10; i++) {
		const acceptBtn = page.locator('.pending-card.round-card .btn-accept').first();
		if ((await acceptBtn.count()) === 0) break;
		await acceptBtn.click();
		await sleep(1500);
	}

	// Give the debounced flush 1.5s, then rebuild the PDF deterministically.
	console.log('  waiting for disk flush + rebuilding PDF...');
	await sleep(1500);
	buildLatexPdf(paperDir, entry);
	await sleep(1500);

	const previewBtn = page.locator('button.preview-btn').first();
	try {
		await previewBtn.waitFor({ state: 'visible', timeout: 8000 });
	} catch {
		console.log('  Preview button never appeared; skipping popup shot');
		return;
	}

	// Clicking Preview calls window.open with a target name; the popup
	// arrives as a new page in the context.
	const popupPromise = context.waitForEvent('page');
	await previewBtn.click();
	const popup = await popupPromise;
	await popup.setViewportSize({ width: 900, height: 1100 });
	await popup.waitForLoadState('domcontentloaded');
	await sleep(5000);
	// Click the popup's "Reload" button to force a fresh load of the
	// PDF that the manual rebuild above just produced.
	const reloadBtn = popup.locator('button', { hasText: /^Reload$/ }).first();
	if (await reloadBtn.count()) {
		await reloadBtn.click();
		await sleep(3500);
	}
	await popup.screenshot({ path: join(IMAGES_DIR, 'overleaf-pdf-preview.png') });
	console.log('  wrote overleaf-pdf-preview.png');
	await popup.close().catch(() => undefined);
}

async function captureAgentDriven(page) {
	console.log('capturing agent-driven screenshots...');
	console.log('  (waking the agent; this may take 30-90 seconds)');

	// essay.md should still be open from the structural pass. The seed
	// contains a [[ ... ]] directive; we just need to wake the agent so
	// it picks the directive up. The agent pill on the history pane
	// header triggers a wake-up directly.
	const agentPill = page.locator('.header-agent-btn').first();
	if (!(await agentPill.count())) {
		console.log('  agent pill not found, skipping');
		return;
	}
	await agentPill.click();
	await sleep(500);

	// Wait for the pending review card to appear in the outline pane.
	const pendingCard = page.locator('.pending-card.round-card').first();
	try {
		await pendingCard.waitFor({ state: 'visible', timeout: AGENT_TIMEOUT_MS });
	} catch {
		console.log('  no pending review appeared in time; skipping agent shots');
		console.log('  (check that Claude credentials are available)');
		return;
	}
	await sleep(800);
	await shot(page, 'quickstart-pending-edit.png');
	await shot(page, 'reviewing-edits-pending.png');
}

async function main() {
	console.log('finding free ports...');
	const httpPort = await findFreePort();
	const wsPort = await findFreePort();
	console.log(`  http=${httpPort}  ws=${wsPort}`);

	console.log('seeding fixture workspace...');
	const fixture = await seedFixture();
	console.log(`  ${fixture}`);

	const latexAvailable = !SKIP_LATEX && hasLatex();
	if (latexAvailable) {
		try {
			await seedVldbProject(fixture);
		} catch (err) {
			console.log(`  VLDB template seeding failed: ${err.message}`);
		}
	} else if (SKIP_LATEX) {
		console.log('SKIP_LATEX set; not seeding LaTeX project');
	} else {
		console.log('pdflatex not found; LaTeX scenario will be skipped');
	}

	let server;
	let browser;
	try {
		console.log(`starting vite dev on port ${httpPort}...`);
		server = await startViteDev(fixture, httpPort, wsPort);
		console.log('launching chromium...');
		browser = await chromium.launch();
		const context = await browser.newContext({ viewport: VIEWPORT });
		context.__httpPort = httpPort;
		const page = await context.newPage();

		await mkdir(IMAGES_DIR, { recursive: true });
		if (!SKIP_STRUCTURAL) {
			await captureStructural(page);
			if (!SKIP_AGENT) {
				await captureAgentDriven(page);
				// Comment thread (uses inline-feedback Discuss mode).
				await captureCommentThread(page);
				// Transcript viewer (needs prior agent activity to be
				// interesting, so it runs after the agent has done work).
				await captureTranscript(page);
			} else {
				console.log('SKIP_AGENT set; skipping agent-driven shots');
			}
		} else {
			console.log('SKIP_STRUCTURAL set; skipping structural + agent shots');
			await page.goto(`http://127.0.0.1:${httpPort}`, { waitUntil: 'domcontentloaded' });
			await sleep(2500);
		}
		if (!SKIP_BLOG && !SKIP_AGENT) {
			await captureBlogResearch(page);
		} else if (SKIP_BLOG) {
			console.log('SKIP_BLOG set; skipping blog-research scenario');
		}
		// GIF before LaTeX: the LaTeX scenario cleans up the markdown
		// fixtures to keep the file tree tidy, and the GIF needs
		// intro.md to exist.
		if (!SKIP_GIF) {
			const ffmpegPath = findFfmpeg();
			if (ffmpegPath) {
				await captureIntroGif(browser, httpPort, ffmpegPath);
			} else {
				console.log('no ffmpeg on PATH; skipping intro GIF');
				console.log('  install with: brew install ffmpeg');
			}
		}
		if (latexAvailable && existsSync(join(fixture, 'paper'))) {
			await captureLatex(page, context, fixture, httpPort);
		}
		console.log('done.');
	} finally {
		if (browser) await browser.close().catch(() => undefined);
		if (server) {
			server.kill('SIGTERM');
			await sleep(500);
		}
		if (!KEEP_FIXTURE) await rm(fixture, { recursive: true, force: true });
		else console.log(`fixture left at ${fixture}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
