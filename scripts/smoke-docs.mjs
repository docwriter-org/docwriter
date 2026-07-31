#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const baseUrl = process.env.DOCS_URL ?? 'http://127.0.0.1:3333';
const config = JSON.parse(await readFile(resolve('docs/docs.json'), 'utf8'));
const pages = config.navigation.groups.flatMap((group) => group.pages);
const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on('console', (message) => {
	if (message.type() === 'error') errors.push(`Console error: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`Page error: ${error.message}`));

for (const slug of pages) {
	const response = await page.goto(`${baseUrl}/${slug}`, {
		waitUntil: 'networkidle',
		timeout: 30_000
	});
	if (!response || response.status() >= 400) {
		errors.push(`${slug} returned ${response?.status() ?? 'no response'}`);
		continue;
	}
	if ((await page.locator('h1').count()) === 0) {
		errors.push(`${slug} rendered without an h1`);
	}
}

await mkdir('/tmp/docwriter-docs-smoke', { recursive: true });
await page.goto(`${baseUrl}/introduction`, { waitUntil: 'networkidle' });
await page.screenshot({
	path: '/tmp/docwriter-docs-smoke/overview.png',
	fullPage: true
});
await page.goto(`${baseUrl}/agent/review-edits`, { waitUntil: 'networkidle' });
await page.screenshot({
	path: '/tmp/docwriter-docs-smoke/review-edits.png',
	fullPage: true
});

await browser.close();

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join('\n'));
	process.exit(1);
}

console.log(`Loaded ${pages.length} pages and saved two smoke screenshots`);
