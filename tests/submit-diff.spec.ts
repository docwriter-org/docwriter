import { test, expect } from './fixtures';
import {
	freshPage,
	createTab,
	setEditor,
	afterAutosave
} from './helpers';

const SUFFIX = Math.random().toString(36).slice(2, 8);

/**
 * Two regressions in the user_action history entry that submit() pushes:
 *
 *   1. flushAutosave race — typing within ~50ms of clicking Wake used to
 *      read a stale file and show "(unchanged since last render)" even
 *      though the user had real edits in the editor.
 *   2. lastAgentMd persistence — after a page reload, the in-memory
 *      `lastRenderMarkdownByTab` was empty, so every first submit said
 *      "(first render — agent sees full document)" even when the SDK
 *      session was the same one. The map is now persisted per-tab in the
 *      y-indexeddb-backed review map.
 *
 * /api/render is stubbed to return an empty SSE stream so submit() runs
 * its diff-computation path (the part we're testing) without touching the
 * Claude SDK. The user_action entry is pushed *before* the render call,
 * so it's visible regardless of whether the render completes.
 */

async function stubRender(page: import('@playwright/test').Page) {
	await page.route('**/api/render', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/event-stream',
			body: ''
		});
	});
}

async function expandAndReadDiffs(page: import('@playwright/test').Page) {
	await page.locator('.entry.user-action.expandable').first().waitFor();
	return page.evaluate(() => {
		document
			.querySelectorAll<HTMLDetailsElement>('.entry.user-action.expandable')
			.forEach((d) => (d.open = true));
		const tabs = Array.from(document.querySelectorAll('.user-diff-tab')).map(
			(e) => e.textContent ?? ''
		);
		const bodies = Array.from(document.querySelectorAll('.user-diff-body')).map(
			(e) => e.textContent ?? ''
		);
		const map: Record<string, string> = {};
		tabs.forEach((t, i) => (map[t] = bodies[i] ?? ''));
		return map;
	});
}

async function clickWake(page: import('@playwright/test').Page) {
	await page.evaluate(() => {
		const btn =
			document.querySelector<HTMLButtonElement>('button[title*="Wake"]') ??
			Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
				/wake/i.test(b.textContent ?? b.title ?? '')
			);
		btn?.click();
	});
}

test.describe('submit user_action diff', () => {
	test('flushAutosave: typing then immediate submit shows the new content (no stale-disk race)', async ({
		page
	}) => {
		await stubRender(page);
		await freshPage(page);
		const tab = `t-flush-${SUFFIX}.md`;
		await createTab(page, tab);

		// Seed initial content + register the agent's view of it via the
		// dev test seam (mirrors what /api/render's result handler does:
		// applies the agent's markdown AND populates lastRenderMarkdownByTab).
		await setEditor(page, `# ${tab}\n\noriginal body line one.`);
		await afterAutosave(page);
		// Seed `lastAgentMd` for this tab to the current content. We use
		// seedLastAgentMd (not fakeAgentEdit) to avoid the no-op path in
		// applyAgentMarkdown when live === agent, and to skip the pending-
		// review UI we don't need for these tests.
		await page.evaluate(() => {
			const cur = (window as any).__docwriterEditor.storage.markdown.getMarkdown();
			(window as any).__docwriterTest.seedLastAgentMd(cur);
		});

		// Type new content, then submit IMMEDIATELY (no afterAutosave).
		// Without the flushAutosave fix in submit(), this would race the
		// 50ms debounce and the diff would be "(unchanged since last
		// render)" because fetchTabMd would read a stale file.
		await page.evaluate((tab) => {
			(window as any).__docwriterEditor.commands.setContent(
				`# ${tab}\n\noriginal body line one.\n\nFRESHLY ADDED LINE.`,
				{ emitUpdate: true }
			);
		}, tab);
		await clickWake(page);

		const diffs = await expandAndReadDiffs(page);
		expect(diffs[tab]).toContain('FRESHLY ADDED LINE');
		expect(diffs[tab]).not.toContain('unchanged since last render');
	});

	test('lastAgentMd persists across reload (no spurious "first render")', async ({ page }) => {
		await stubRender(page);
		await freshPage(page);
		const tab = `t-persist-${SUFFIX}.md`;
		await createTab(page, tab);

		await setEditor(page, `# ${tab}\n\nbaseline content.`);
		await afterAutosave(page);
		// Register the agent's view of this tab via seedLastAgentMd. The
		// review map write goes through y-indexeddb, so it survives reload.
		await page.evaluate(() => {
			const cur = (window as any).__docwriterEditor.storage.markdown.getMarkdown();
			(window as any).__docwriterTest.seedLastAgentMd(cur);
		});

		// RELOAD. In-memory lastRenderMarkdownByTab is wiped; loadTab must
		// rehydrate it from the review map.
		await page.reload();
		await stubRender(page); // route survives the reload but re-add for safety
		await page.waitForSelector('.tab-bar');
		await page.waitForFunction(() => !!(window as any).__docwriterEditor);

		// Switch to our tab if not active.
		const active = await page.locator('.tab.active .tab-name').innerText();
		if (active !== tab) {
			await page.locator(`.tab .tab-name:has-text("${tab}")`).click();
			await page.locator(`.tab.active .tab-name:has-text("${tab}")`).waitFor();
			await page.waitForFunction(() => !!(window as any).__docwriterEditor);
		}

		// Confirm the in-memory map was restored from y-indexeddb.
		const restored = await page.evaluate(() =>
			(window as any).__docwriterTest.inspectLastRenderMap()
		);
		expect(restored[tab]).toContain('baseline content');

		// Type more and submit — diff should be a real unified diff, NOT
		// "(first render — agent sees full document)".
		await page.evaluate((tab) => {
			(window as any).__docwriterEditor.commands.setContent(
				`# ${tab}\n\nbaseline content.\n\nAFTER RELOAD addition.`,
				{ emitUpdate: true }
			);
		}, tab);
		await clickWake(page);

		const diffs = await expandAndReadDiffs(page);
		expect(diffs[tab]).toContain('AFTER RELOAD addition');
		expect(diffs[tab]).not.toContain('first render');
	});
});
