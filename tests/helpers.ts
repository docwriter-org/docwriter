import type { Page } from '@playwright/test';

/**
 * Shared helpers. Specs run in parallel across workers; each test uses
 * unique tab names so they don't collide in the shared `notes/` folder.
 * IndexedDB is per-browser-context, so each worker has its own editor
 * state automatically.
 */

/** Visit the app and clear any persisted client state. Keep setup short —
 * no full reload — so the suite stays fast. */
export async function freshPage(page: Page) {
	await page.goto('/');
	await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		await Promise.all(
			dbs.map(
				(db) =>
					new Promise<void>((r) => {
						if (!db.name) return r();
						const req = indexedDB.deleteDatabase(db.name);
						req.onsuccess = () => r();
						req.onerror = () => r();
					})
			)
		);
	});
	await page.reload();
	await page.waitForSelector('.tab-bar');
}

export async function createTab(page: Page, name: string) {
	// `+` button now opens a window.prompt() dialog rather than an inline
	// input. Pre-register a one-shot dialog handler that types the name and
	// accepts before clicking `+`, so the dialog never blocks.
	page.once('dialog', (d) => void d.accept(name));
	await page.locator('.tab-add').click();
	// Wait for the new tab to become active and the editor to re-bind.
	await page
		.locator(`.tab.active .tab-name:has-text("${name}")`)
		.waitFor({ state: 'visible' });
	await page.waitForFunction(() => !!(window as any).__docwriterEditor);
}

export async function switchTab(page: Page, name: string) {
	await page.locator(`.tab .tab-name:has-text("${name}")`).click();
	await page
		.locator(`.tab.active .tab-name:has-text("${name}")`)
		.waitFor({ state: 'visible' });
	await page.waitForFunction(() => !!(window as any).__docwriterEditor);
}

/**
 * Set editor content, preserving line structure. `setContent(string)` on a
 * Tiptap editor treats raw strings as HTML by default, which mangles multi-
 * line markdown and collapses newlines in plain tabs. Branch on the active
 * tab's schema: markdown tabs route through tiptap-markdown's parser (via
 * `setContent(markdown)` — the Markdown extension overrides the command);
 * plain tabs build PM JSON directly (one paragraph per line) to mirror
 * `plainTextToPMJson` in production.
 */
export async function setEditor(page: Page, content: string) {
	// Make sure we're writing into the *current* tab's editor, not a stale
	// handle left over from a previous mount.
	await page.waitForFunction(() => {
		const ed = (window as any).__docwriterEditor;
		return ed && !ed.isDestroyed;
	});
	const isPlain = await page.evaluate(() => {
		const active = document.querySelector('.tab.active');
		return !!active?.classList.contains('plain');
	});
	await page.evaluate(
		({ text, plain }) => {
			const editor = (window as any).__docwriterEditor;
			if (plain) {
				const lines = text.split('\n');
				const json = {
					type: 'doc',
					content: lines.map((line) =>
						line.length === 0
							? { type: 'paragraph' }
							: { type: 'paragraph', content: [{ type: 'text', text: line }] }
					)
				};
				editor.commands.setContent(json, { emitUpdate: true });
			} else {
				// tiptap-markdown overrides setContent to parse the string as markdown.
				editor.commands.setContent(text, { emitUpdate: true });
			}
		},
		{ text: content, plain: isPlain }
	);
}

export async function getEditorText(page: Page): Promise<string> {
	return page.evaluate(() =>
		(window as any).__docwriterEditor.getText({ blockSeparator: '\n' })
	);
}

/** Wait for the autosave debounce (~50ms) + the fetch round-trip. 400ms
 * is generous but still fast. */
export async function afterAutosave(page: Page) {
	await page.waitForTimeout(400);
}
