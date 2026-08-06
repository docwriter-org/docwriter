#!/usr/bin/env node
/**
 * Fetch Shreya Shankar gold-corpus sources into fixtures/style/shreya/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'style', 'shreya');

const SOURCES = [
	{
		id: 'blog-ai-writing',
		url: 'https://www.sh-reya.com/blog/ai-writing/',
		kind: 'html'
	},
	{
		id: 'blog-in-defense-ai-evals',
		url: 'https://www.sh-reya.com/blog/in-defense-ai-evals/',
		kind: 'html'
	},
	{
		id: 'blog-ai-engineering-flywheel',
		url: 'https://www.sh-reya.com/blog/ai-engineering-flywheel/',
		kind: 'html'
	},
	{
		id: 'paper-evalgen',
		url: 'https://arxiv.org/pdf/2404.12272',
		kind: 'pdf'
	},
	{
		id: 'paper-docetl',
		url: 'https://ar5iv.labs.arxiv.org/html/2410.12189',
		kind: 'html'
	}
];

function stripHtml(html) {
	let t = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	const article =
		t.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
		t.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
		t;
	return article
		.replace(/<\/(p|div|h[1-6]|li|br|blockquote)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<h([1-6])[^>]*>/gi, (_, n) => `${'#'.repeat(Number(n))} `)
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

mkdirSync(OUT, { recursive: true });

function extractPdfText(buf) {
	const raw = buf.toString('latin1');
	const chunks = [];
	const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
	let m;
	while ((m = streamRe.exec(raw))) {
		const body = m[1];
		const tj = /(?:\((?:\\.|[^\\)])*\))\s*Tj/g;
		let tm;
		while ((tm = tj.exec(body))) {
			const token = tm[0].replace(/\s*Tj$/, '');
			if (token.startsWith('(')) {
				chunks.push(
					token
						.slice(1, -1)
						.replace(/\\n/g, '\n')
						.replace(/\\\(/g, '(')
						.replace(/\\\)/g, ')')
						.replace(/\\\\/g, '\\')
				);
			}
		}
	}
	const joined = chunks.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
	if (joined.length > 500) return joined.slice(0, 120_000);
	// Fallback: printable ASCII dump (truncated)
	return raw
		.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100_000);
}

for (const src of SOURCES) {
	process.stdout.write(`Fetching ${src.id}… `);
	const res = await fetch(src.url, {
		headers: { 'User-Agent': 'DocWriterFixtureBot/1.0' }
	});
	if (!res.ok) {
		console.log(`FAIL ${res.status}`);
		continue;
	}
	let text;
	if (src.kind === 'pdf') {
		const buf = Buffer.from(await res.arrayBuffer());
		text = extractPdfText(buf);
	} else {
		text = stripHtml(await res.text());
	}
	writeFileSync(join(OUT, `${src.id}.md`), text + '\n', 'utf-8');
	console.log(`${text.length} chars`);
}

writeFileSync(
	join(OUT, 'manifest.json'),
	JSON.stringify(
		{
			schemaVersion: 1,
			role: 'authored',
			sources: SOURCES.map((s) => ({ id: s.id, url: s.url, file: `${s.id}.md` }))
		},
		null,
		2
	) + '\n'
);
console.log('Wrote', OUT);
