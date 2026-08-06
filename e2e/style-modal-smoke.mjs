#!/usr/bin/env node
/**
 * Lightweight API/UI smoke for author-style pipeline (no full agent provider).
 * Expects `npm run dev` on :5173 (or DOCWRITER_URL).
 */
import { chromium } from 'playwright';

const BASE = process.env.DOCWRITER_URL || 'http://127.0.0.1:5173';

async function main() {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	try {
		await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		const pill = page.locator('button.style-pill');
		await pill.waitFor({ state: 'attached', timeout: 45_000 });
		await page.waitForTimeout(2000);
		await pill.click({ force: true });
		await page.waitForFunction(
			() => document.body.innerText.includes('Build a portable author-style skill'),
			null,
			{ timeout: 15_000 }
		);
		if (!(await page.getByText('1. Sources').count())) {
			throw new Error('Sources step missing');
		}
		console.log('style-modal-smoke: ok');
	} finally {
		await browser.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
