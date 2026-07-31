#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const docsRoot = resolve('docs');
const imagesRoot = join(docsRoot, 'images');
const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm']);
const maxBytes = 8 * 1024 * 1024;
const errors = [];

async function collectFiles(dir, extensions) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(path, extensions)));
		else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(path);
	}
	return files;
}

function dimensions(buffer, extension) {
	if (extension === '.png' && buffer.length >= 24) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	if (extension === '.gif' && buffer.length >= 10) {
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}
	return null;
}

const mdxFiles = await collectFiles(docsRoot, new Set(['.mdx']));
const referenced = new Set();
for (const file of mdxFiles) {
	const text = await readFile(file, 'utf8');
	for (const match of text.matchAll(/(?:!\[[^\]]*\]\(|src=["'])(\/images\/[^)"']+)/g)) {
		referenced.add(match[1].replace('/images/', ''));
	}
}

const mediaFiles = await collectFiles(imagesRoot, mediaExtensions);
for (const file of mediaFiles) {
	const name = relative(imagesRoot, file);
	const info = await stat(file);
	const extension = extname(file).toLowerCase();
	if (info.size > maxBytes) {
		errors.push(`${name} is ${(info.size / 1024 / 1024).toFixed(1)} MB; limit is 8 MB`);
	}
	if (!referenced.has(name)) {
		errors.push(`${name} is not referenced by any MDX page`);
	}
	const size = dimensions(await readFile(file), extension);
	if (size && (size.width < 120 || size.height < 40 || size.width > 2400 || size.height > 1800)) {
		errors.push(`${name} has unexpected dimensions ${size.width}x${size.height}`);
	}
}

for (const name of referenced) {
	if (!mediaFiles.some((file) => relative(imagesRoot, file) === name)) {
		errors.push(`${name} is referenced but missing`);
	}
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join('\n'));
	process.exit(1);
}

console.log(`Validated ${mediaFiles.length} media files and ${referenced.size} references`);
