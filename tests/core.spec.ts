import { test, expect } from './fixtures';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	freshPage,
	createTab,
	switchTab,
	setEditor,
	getEditorText,
	afterAutosave
} from './helpers';

// Per-test-file suffix keeps tab names readable; isolation is now per-worker
// (each Playwright worker has its own DOCWRITER_ROOT), so collisions across
// specs are impossible.
const SUFFIX = Math.random().toString(36).slice(2, 8);

test.describe('boot', () => {
	test('loads with at least one tab and a title', async ({ page }) => {
		await freshPage(page);
		await expect(page).toHaveTitle('DocWriter');
		await expect(page.locator('.tab.active')).toHaveCount(0);
		await expect(page.locator('.empty-editor-title')).toContainText('No file open');
	});
});

test.describe('tabs: create, switch, isolate', () => {
	test('each tab has isolated content and its own IndexedDB', async ({
		page,
		isolatedServer
	}) => {
		await freshPage(page);
		// Tab IDs are now workspace-relative paths; the extension drives
		// markdown-vs-plain, so we explicitly use `.md` here.
		const a = `t-a-${SUFFIX}.md`;
		const b = `t-b-${SUFFIX}.md`;

		await createTab(page, a);
		await setEditor(page, `# ${a}\n\nContent-A`);
		await afterAutosave(page);

		await createTab(page, b);
		await setEditor(page, `# ${b}\n\nContent-B`);
		await afterAutosave(page);

		// Switch back and verify no bleed either way.
		await switchTab(page, a);
		const textA = await getEditorText(page);
		expect(textA).toContain('Content-A');
		expect(textA).not.toContain('Content-B');

		await switchTab(page, b);
		const textB = await getEditorText(page);
		expect(textB).toContain('Content-B');
		expect(textB).not.toContain('Content-A');

		// Each tab gets its own IndexedDB database.
		const dbs = await page.evaluate(async () => {
			const list = await indexedDB.databases();
			return list.map((d) => d.name).filter(Boolean) as string[];
		});
		expect(dbs).toContain(`docwriter-doc:${a}`);
		expect(dbs).toContain(`docwriter-doc:${b}`);

		// On-disk files live at ROOT/<tabId> directly (no more flat notes/
		// dir). tabId IS the relative path, so no extension is appended.
		const fileA = readFileSync(join(isolatedServer.root, a), 'utf-8');
		const fileB = readFileSync(join(isolatedServer.root, b), 'utf-8');
		expect(fileA).toContain('Content-A');
		expect(fileB).toContain('Content-B');
		expect(fileA).not.toContain('Content-B');
	});

	test('delete tab prompts a confirm dialog and only deletes on accept', async ({ page }) => {
		await freshPage(page);
		const name = `t-del-${SUFFIX}.md`;
		await createTab(page, name);
		const tabRow = page.locator(`.tab:has(.tab-name:has-text("${name}"))`);
		const closeBtn = tabRow.locator('.tab-close');

		// First click: dismiss the dialog → tab stays.
		page.once('dialog', (d) => {
			expect(d.message()).toMatch(/can't recover|recover it|permanently/i);
			void d.dismiss();
		});
		await closeBtn.click();
		await expect(tabRow).toHaveCount(1);

		// Second click: accept → tab gone.
		page.once('dialog', (d) => void d.accept());
		await closeBtn.click();
		await expect(page.locator(`.tab-name:has-text("${name}")`)).toHaveCount(0);
	});
});

test.describe('plain-text tabs', () => {
	test('markdown syntax is preserved literally in .txt files', async ({
		page,
		isolatedServer
	}) => {
		await freshPage(page);
		const name = `t-plain-${SUFFIX}.txt`;
		await createTab(page, name);
		// The tab should be in plain mode (no markdown parsing).
		await expect(page.locator('.tab.active')).toHaveClass(/plain/);

		const payload = '## not a heading\n- *not italic*\n> not a quote\n**not bold**';
		await setEditor(page, payload);
		await afterAutosave(page);

		// Editor round-trips byte-for-byte via getText with \n separator.
		expect(await getEditorText(page)).toBe(payload);

		// And the file on disk is exactly the same bytes — no markdown
		// serializer touched it.
		const onDisk = readFileSync(join(isolatedServer.root, name), 'utf-8');
		expect(onDisk).toBe(payload);
	});

	test('nested-path tabs round-trip through the filesystem', async ({
		page,
		isolatedServer
	}) => {
		await freshPage(page);
		// Tab IDs can be any workspace-relative path, including subdirs.
		const name = `drafts-${SUFFIX}/chapter.md`;
		await createTab(page, name);
		await setEditor(page, `# Chapter\n\nNested body.`);
		await afterAutosave(page);
		const onDisk = readFileSync(join(isolatedServer.root, name), 'utf-8');
		expect(onDisk).toContain('Nested body');
	});

	test('wrap long lines keeps plain-text gutter aligned to visual rows', async ({ page }) => {
		await freshPage(page);
		await page.evaluate(async () => {
			await fetch('/api/session', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ editorSoftWrap: true })
			});
		});
		await page.reload();
		await page.waitForSelector('.tab-bar');

		const name = `t-wrap-${SUFFIX}.txt`;
		await createTab(page, name);
		await setEditor(
			page,
			'This is one intentionally long plain-text line that should wrap across multiple visual rows in the editor gutter without creating fake logical line numbers.'
		);
		await afterAutosave(page);

		const gutterRows = await page.locator('.plain-line-number').evaluateAll((nodes) =>
			nodes.map((node) => node.textContent ?? '')
		);
		expect(gutterRows.length).toBeGreaterThan(1);
		expect(gutterRows[0]).toBe('1');
		expect(gutterRows.slice(1).every((value) => value === '')).toBe(true);
	});
});

test.describe('persistence', () => {
	test('typing survives a page reload', async ({ page }) => {
		await freshPage(page);
		const name = `t-reload-${SUFFIX}.md`;
		await createTab(page, name);
		const markerA = `reload-a-${SUFFIX}`;
		const markerB = `reload-b-${SUFFIX}`;
		await setEditor(page, `# ${name}\n\n${markerA}\n\n${markerB}`);
		await afterAutosave(page);

		for (let i = 0; i < 2; i += 1) {
			await page.reload();
			await page.waitForSelector('.tab-bar');
			await page.waitForFunction(() => !!(window as any).__docwriterEditor);
			await switchTab(page, name);

			const text = await getEditorText(page);
			expect(text.match(new RegExp(markerA, 'g')) ?? []).toHaveLength(1);
			expect(text.match(new RegExp(markerB, 'g')) ?? []).toHaveLength(1);
		}
	});

	test('new agent session preserves tabs after reload', async ({ page }) => {
		await freshPage(page);
		const name = `t-session-${SUFFIX}.md`;
		await createTab(page, name);
		await setEditor(page, `# ${name}\n\nsession marker ${SUFFIX}`);
		await afterAutosave(page);

		await page.locator('.history-pane .clear-btn').click();
		await page.reload();
		await page.waitForSelector('.tab-bar');
		await page.waitForFunction(() => !!(window as any).__docwriterEditor);

		await expect(page.locator(`.tab .tab-name:has-text("${name}")`)).toBeVisible();
		await switchTab(page, name);
		expect(await getEditorText(page)).toContain(`session marker ${SUFFIX}`);
	});
});

test.describe('server path safety', () => {
	test('file APIs reject writes through symlinked directories outside the workspace', async ({
		isolatedServer
	}) => {
		const outside = mkdtempSync(join(tmpdir(), `docwriter-outside-${SUFFIX}-`));
		try {
			symlinkSync(outside, join(isolatedServer.root, 'escape'), 'dir');

			const createRes = await fetch(`${isolatedServer.baseURL}/api/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: 'escape/new.txt', content: 'blocked' })
			});
			expect(createRes.status).toBe(400);

			const writeRes = await fetch(
				`${isolatedServer.baseURL}/api/file-content?path=${encodeURIComponent('escape/direct.txt')}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: 'blocked' })
				}
			);
			expect(writeRes.status).toBe(400);

			expect(existsSync(join(outside, 'new.txt'))).toBe(false);
			expect(existsSync(join(outside, 'direct.txt'))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
