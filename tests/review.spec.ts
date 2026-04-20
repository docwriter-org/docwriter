import { test, expect } from './fixtures';
import {
	freshPage,
	createTab,
	switchTab,
	setEditor,
	getEditorText,
	afterAutosave
} from './helpers';

const SUFFIX = Math.random().toString(36).slice(2, 8);

/**
 * Review-mode flow: simulate an agent edit via the dev test seam
 * (`window.__docwriterTest.fakeAgentEdit`) so we don't have to round-trip
 * the Claude SDK. The seam mirrors what `/api/render`'s result handler does:
 * capture baseline → apply agent markdown with trackChanges=true → write
 * review baseline. From there the real Accept/Reject UI is exercised.
 */
test.describe('review mode', () => {
	test('accept keeps agent edit, clears pending UI', async ({ page }) => {
		await freshPage(page);
		const name = `t-rev-acc-${SUFFIX}.md`;
		await createTab(page, name);
		await setEditor(page, `# ${name}\n\nOriginal sentence.`);
		await afterAutosave(page);

		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, `# ${name}\n\nAgent-rewritten sentence.`);

		// Pending card with Accept/Reject is visible.
		const pendingCard = page.locator('.pending-card');
		await expect(pendingCard).toBeVisible();
		await expect(pendingCard.locator('.btn-accept')).toBeVisible();
		await expect(pendingCard.locator('.btn-reject')).toBeVisible();

		// Editor already shows the agent's text.
		expect(await getEditorText(page)).toContain('Agent-rewritten sentence');

		await pendingCard.locator('.btn-accept').click();
		await expect(pendingCard).toHaveCount(0);
		expect(await getEditorText(page)).toContain('Agent-rewritten sentence');
		expect(await getEditorText(page)).not.toContain('Original sentence');
	});

	test('accept persists across reload', async ({ page }) => {
		await freshPage(page);
		const name = `t-rev-acc-reload-${SUFFIX}.md`;
		await createTab(page, name);
		await setEditor(page, `# ${name}\n\nOriginal sentence.`);
		await afterAutosave(page);

		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, `# ${name}\n\nAgent-rewritten sentence.`);

		const pendingCard = page.locator('.pending-card');
		await expect(pendingCard).toBeVisible();
		// The test seam applies through the browser Y.Doc; give the provider a
		// moment to mirror that state to the server before Accept asks the
		// server to clear the pending rounds.
		await page.waitForTimeout(150);
		await pendingCard.locator('.btn-accept').click();
		await expect(pendingCard).toHaveCount(0);

		await page.reload();
		await page.waitForSelector('.tab-bar');
		await page.waitForFunction(() => !!(window as any).__docwriterEditor);

		const active = await page.locator('.tab.active .tab-name').innerText();
		if (active !== name) {
			await switchTab(page, name);
		}

		await expect(page.locator('.pending-card')).toHaveCount(0);
		expect(await getEditorText(page)).toContain('Agent-rewritten sentence');
		expect(await getEditorText(page)).not.toContain('Original sentence');
	});

	test('reject reverts to baseline, clears pending UI', async ({ page }) => {
		await freshPage(page);
		const name = `t-rev-rej-${SUFFIX}.md`;
		await createTab(page, name);
		await setEditor(page, `# ${name}\n\nKeep this line.`);
		await afterAutosave(page);

		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, `# ${name}\n\nAgent overwrote this.`);

		const pendingCard = page.locator('.pending-card');
		await expect(pendingCard).toBeVisible();

		await pendingCard.locator('.btn-reject').click();
		await expect(pendingCard).toHaveCount(0);
		expect(await getEditorText(page)).toContain('Keep this line');
		expect(await getEditorText(page)).not.toContain('Agent overwrote');
	});

	test('plain-text agent edits preserve line breaks', async ({ page }) => {
		await freshPage(page);
		const name = `t-rev-plain-${SUFFIX}.txt`;
		await createTab(page, name);
		await setEditor(page, 'line 1\nline 2\n\nline 4');
		await afterAutosave(page);

		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, 'line 1\nline 2 updated\n\nline 4');

		await expect(page.locator('.pending-card')).toBeVisible();
		await expect(page.locator('.pending-card .btn-accept')).toBeVisible();
		expect(await getEditorText(page)).toBe('line 1\nline 2 updated\n\nline 4');
	});

	test('pending dot appears on inactive tab when agent edits it', async ({ page }) => {
		await freshPage(page);
		const a = `t-dot-a-${SUFFIX}.md`;
		const b = `t-dot-b-${SUFFIX}.md`;
		await createTab(page, a);
		await setEditor(page, `# ${a}\n\nTab A original.`);
		await afterAutosave(page);
		await createTab(page, b);
		await setEditor(page, `# ${b}\n\nTab B original.`);
		await afterAutosave(page);

		// Fake an agent edit on the *currently active* tab (B), then switch
		// to A. From A's perspective, B is the inactive tab carrying a
		// pending dot.
		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, `# ${b}\n\nAgent touched B.`);

		await switchTab(page, a);
		const tabB = page.locator(`.tab:has(.tab-name:has-text("${b}"))`);
		await expect(tabB.locator('.pending-dot')).toBeVisible();
		// And A (the active one) does not.
		const tabA = page.locator(`.tab.active:has(.tab-name:has-text("${a}"))`);
		await expect(tabA.locator('.pending-dot')).toHaveCount(0);
	});

	test('reject after switching tabs preserves later user edits', async ({ page }) => {
		await freshPage(page);
		const a = `t-rej-switch-a-${SUFFIX}.md`;
		const b = `t-rej-switch-b-${SUFFIX}.md`;
		await createTab(page, a);
		await setEditor(page, `# ${a}\n\nLine 1 original.\n\nUser tail.`);
		await afterAutosave(page);
		await createTab(page, b);
		await setEditor(page, `# ${b}\n\nOther tab.`);
		await afterAutosave(page);

		await switchTab(page, a);
		await page.evaluate((after) => {
			(window as any).__docwriterTest.fakeAgentEdit(after);
		}, `# ${a}\n\nLine 1 agent.\n\nUser tail.`);

		// Force the active editor to unmount/remount around the pending round.
		await switchTab(page, b);
		await switchTab(page, a);

		// User edits after the agent round should survive Reject.
		await setEditor(page, `# ${a}\n\nLine 1 agent.\n\nUser tail.\n\nMy note.`);
		await afterAutosave(page);

		await page.evaluate(() => {
			(window as any).__docwriterTest.reject();
		});

		const text = await getEditorText(page);
		expect(text).toContain('Line 1 original.');
		expect(text).toContain('User tail.');
		expect(text).toContain('My note.');
		expect(text).not.toContain('Line 1 agent.');
	});
});

test.describe('history restore', () => {
	test('restored messages from /api/history populate the activity pane', async ({ page }) => {
		// Intercept /api/history before any navigation so the very first
		// fetch on page load gets our canned response.
		await page.route('**/api/history', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					sessionId: 'fake-session',
					messages: [
						{
							type: 'user',
							message: { content: 'Submitted\n\n## What the user wants\nAdd a TL;DR' }
						},
						{
							type: 'assistant',
							message: {
								content: [
									{ type: 'text', text: 'Sure, adding a TL;DR section.' }
								]
							}
						}
					]
				})
			});
		});
		await freshPage(page);
		// HistoryPane should show both restored entries.
		const userActions = page.locator('.entry.user-action');
		await expect(userActions).toHaveCount(1, { timeout: 5_000 });
		await expect(userActions).toContainText(/TL;DR|Submitted/);
		await expect(page.locator('.entry.assistant-text')).toContainText(
			/Sure, adding a TL;DR/
		);
	});
});

test.describe('rename tab', () => {
	test('dblclick → type → Enter renames the tab and moves the file', async ({
		page,
		isolatedServer
	}) => {
		await freshPage(page);
		const oldName = `t-rn-old-${SUFFIX}.md`;
		const newName = `t-rn-new-${SUFFIX}.md`;
		await createTab(page, oldName);
		await setEditor(page, `# ${oldName}\n\nRenamed body.`);
		await afterAutosave(page);

		const tabRow = page.locator(`.tab:has(.tab-name:has-text("${oldName}"))`);
		// Target the .tab-name span directly so the dblclick can't accidentally
		// land on the close button (which would arm/confirm delete instead).
		await tabRow.locator('.tab-name').dblclick();
		// Once renaming begins the .tab-name span is replaced by an input, so
		// scope the input lookup to the active tab rather than the (now-stale)
		// tabRow selector that required a .tab-name child.
		const input = page.locator('.tab.active .tab-rename');
		await expect(input).toBeVisible();
		await input.fill(newName);
		await input.press('Enter');

		await expect(page.locator(`.tab-name:has-text("${newName}")`)).toBeVisible();
		await expect(page.locator(`.tab-name:has-text("${oldName}")`)).toHaveCount(0);

		// Content survives the rename.
		expect(await getEditorText(page)).toContain('Renamed body');

		// File on disk moved: old gone, new present with body. tabId IS the
		// path relative to DOCWRITER_ROOT now — no `notes/` subfolder.
		const { existsSync, readFileSync } = await import('fs');
		const { join } = await import('path');
		expect(existsSync(join(isolatedServer.root, oldName))).toBe(false);
		expect(readFileSync(join(isolatedServer.root, newName), 'utf-8')).toContain('Renamed body');
	});
});
