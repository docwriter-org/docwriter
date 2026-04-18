import { test, expect } from './fixtures';
import { readFileSync } from 'fs';
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
		await expect(page.locator('.tab.active')).toHaveCount(1);
		// Agent dock mascot is visible and sleeping.
		await expect(page.locator('.mascot-status')).toContainText(/sleeping/);
	});
});

test.describe('tabs: create, switch, isolate', () => {
	test('each tab has isolated content and its own IndexedDB', async ({
		page,
		isolatedServer
	}) => {
		await freshPage(page);
		const a = `t-a-${SUFFIX}`;
		const b = `t-b-${SUFFIX}`;

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

		// On-disk files match — read from this worker's isolated notes/.
		const notes = join(isolatedServer.root, 'notes');
		const fileA = readFileSync(join(notes, `${a}.md`), 'utf-8');
		const fileB = readFileSync(join(notes, `${b}.md`), 'utf-8');
		expect(fileA).toContain('Content-A');
		expect(fileB).toContain('Content-B');
		expect(fileA).not.toContain('Content-B');
	});

	test('delete tab prompts a confirm dialog and only deletes on accept', async ({ page }) => {
		await freshPage(page);
		const name = `t-del-${SUFFIX}`;
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
		const onDisk = readFileSync(join(isolatedServer.root, 'notes', name), 'utf-8');
		expect(onDisk).toBe(payload);
	});
});

test.describe('persistence', () => {
	test('typing survives a page reload', async ({ page }) => {
		await freshPage(page);
		const name = `t-reload-${SUFFIX}`;
		await createTab(page, name);
		const marker = `reload-${SUFFIX}`;
		await setEditor(page, `# ${name}\n\n${marker}`);
		await afterAutosave(page);

		await page.reload();
		await page.waitForSelector('.tab-bar');
		await page.waitForFunction(() => !!(window as any).__docwriterEditor);
		await switchTab(page, name);
		expect(await getEditorText(page)).toContain(marker);
	});
});
