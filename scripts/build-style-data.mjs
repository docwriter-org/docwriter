import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const OUTPUT = new URL('../src/lib/server/style-analysis/style-data.json', import.meta.url);
const SOURCES = {
	concreteness: 'https://huggingface.co/datasets/StephanAkkerman/concreteness-ratings/resolve/main/concreteness_ratings.csv',
	commonWords: 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt',
	idioms: 'https://raw.githubusercontent.com/eubinecto/idiomatch/main/idiomatch/resources/idioms.yml',
	sentiment: 'https://unpkg.com/afinn-165@2.0.2/index.js',
	brown: 'https://registry.npmjs.org/corpus-brown/-/corpus-brown-1.9.80.tgz'
};

async function download(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

function checksum(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

function csvRows(buffer) {
	const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
	const headers = lines.shift().split(',');
	return lines.map((line) => {
		const values = line.split(',');
		return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
	});
}

function brownWords(directory) {
	const words = [];
	for (const name of readdirSync(join(directory, 'package')).filter((item) => /^c[a-r]\d\d$/.test(item)).sort()) {
		const text = readFileSync(join(directory, 'package', name), 'utf8');
		for (const tagged of text.split(/\s+/)) {
			const slash = tagged.lastIndexOf('/');
			if (slash <= 0) continue;
			const word = tagged.slice(0, slash).toLocaleLowerCase().replace(/^[^a-z]+|[^a-z']+$/g, '');
			if (/^[a-z]+(?:'[a-z]+)?$/.test(word)) words.push(word);
		}
	}
	return words;
}

function backgroundNgrams(words, limit = 50000) {
	const counts = new Map();
	for (let size = 2; size <= 4; size += 1) {
		for (let index = 0; index + size <= words.length; index += 1) {
			const phrase = words.slice(index, index + size).join(' ');
			counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
		}
	}
	return Object.fromEntries([...counts]
		.filter(([, count]) => count >= 2)
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, limit));
}

async function main() {
	const entries = await Promise.all(Object.entries(SOURCES).map(async ([name, url]) => [name, await download(url)]));
	const files = Object.fromEntries(entries);
	const concreteness = Object.fromEntries(csvRows(files.concreteness)
		.map((row) => [row.Word.toLocaleLowerCase(), Number(row['Conc.M'])])
		.filter(([word, value]) => word && Number.isFinite(value)));
	const commonWords = [...new Set(files.commonWords.toString('utf8').split(/\r?\n/)
		.map((word) => word.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 5000);
	const idioms = [...new Set(parse(files.idioms.toString('utf8')).map((item) => item.lemma?.toLocaleLowerCase()).filter(Boolean))];

	const temporary = mkdtempSync(join(tmpdir(), 'docwriter-style-data-'));
	let sentiment;
	let brown;
	try {
		const sentimentModule = join(temporary, 'afinn.mjs');
		writeFileSync(sentimentModule, files.sentiment);
		sentiment = (await import(`${pathToFileURL(sentimentModule).href}?v=${checksum(files.sentiment)}`)).afinn165;
		const archive = join(temporary, 'brown.tgz');
		writeFileSync(archive, files.brown);
		execFileSync('tar', ['-xzf', archive, '-C', temporary]);
		const words = brownWords(temporary);
		brown = { tokenCount: words.length, ngrams: backgroundNgrams(words) };
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}

	const output = {
		schemaVersion: 1,
		sources: Object.fromEntries(Object.entries(SOURCES).map(([name, url]) => [name, {
			url,
			sha256: checksum(files[name])
		}])),
		concreteness,
		commonWords,
		idioms,
		sentiment,
		backgroundTokenCount: brown.tokenCount,
		backgroundNgrams: brown.ngrams
	};
	writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
	process.stdout.write(`${JSON.stringify({
		concreteness: Object.keys(concreteness).length,
		commonWords: commonWords.length,
		idioms: idioms.length,
		sentiment: Object.keys(sentiment).length,
		backgroundTokens: brown.tokenCount,
		backgroundNgrams: Object.keys(brown.ngrams).length
	}, null, 2)}\n`);
}

await main();
