#!/usr/bin/env node
/**
 * Dependency-free ESM metric helper shipped inside the author-style skill bundle.
 * Accepts normalized plain text or markdown on stdin / --file and prints JSON metrics.
 *
 * Usage:
 *   node analyze-style.mjs --file sample.md
 *   echo "Hello world." | node analyze-style.mjs
 */
import { readFileSync } from 'node:fs';

const AI_OVERUSE = [
	'delve',
	'tapestry',
	'landscape',
	'robust',
	'leverage',
	'pivotal',
	'underscore',
	'showcase',
	'intricate',
	'meticulous',
	'realm',
	'plethora',
	'myriad',
	'utilize',
	'whilst',
	'seamless',
	'innovative',
	'groundbreaking',
	'paradigm',
	'holistic',
	'synergy',
	'unleash'
];

const STOP = new Set(
	'a an the and or but if then for of to in on at by from with as is are was were be been being this that it its i you we they not no so than too very can could should would may might will just also'.split(
		/\s+/
	)
);

function tokenize(text) {
	return (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((t) => t.toLowerCase());
}

function sentenceLengths(text) {
	const sentences = text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
	return sentences.map((s) => s.trim().split(/\s+/).filter(Boolean).length);
}

function percentile(sorted, p) {
	if (!sorted.length) return 0;
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function analyze(text) {
	const tokens = tokenize(text);
	const content = tokens.filter((t) => !STOP.has(t) && t.length > 2);
	const lengths = sentenceLengths(text).sort((a, b) => a - b);
	const freq = new Map();
	for (const t of content) freq.set(t, (freq.get(t) ?? 0) + 1);
	const signatureWords = [...freq.entries()]
		.filter(([t]) => !STOP.has(t))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([term, count]) => ({ term, count }));
	const present = new Set(tokens);
	const aiIsmsAbsent = AI_OVERUSE.filter((w) => !present.has(w));
	const punct = {};
	for (const ch of text) {
		if ('.?!,;:—–()[]{}""\''.includes(ch)) punct[ch] = (punct[ch] ?? 0) + 1;
	}
	const words = Math.max(1, tokens.length);
	const perThousand = Object.fromEntries(
		Object.entries(punct).map(([k, v]) => [k, (v / words) * 1000])
	);
	return {
		schemaVersion: 1,
		sentenceLength: {
			p25: percentile(lengths, 0.25),
			p50: percentile(lengths, 0.5),
			p75: percentile(lengths, 0.75),
			count: lengths.length
		},
		signatureWords,
		aiIsmsAbsent,
		punctuationPerThousand: perThousand,
		wordCount: tokens.length
	};
}

function main() {
	const args = process.argv.slice(2);
	let text = '';
	const fileIdx = args.indexOf('--file');
	if (fileIdx >= 0 && args[fileIdx + 1]) {
		text = readFileSync(args[fileIdx + 1], 'utf-8');
	} else if (!process.stdin.isTTY) {
		text = readFileSync(0, 'utf-8');
	} else {
		console.error('Pass --file path or pipe text on stdin');
		process.exit(1);
	}
	process.stdout.write(JSON.stringify(analyze(text), null, 2) + '\n');
}

main();
