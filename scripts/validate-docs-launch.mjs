#!/usr/bin/env node
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve('.');
const docsRoot = join(root, 'docs');
const config = JSON.parse(await readFile(join(docsRoot, 'docs.json'), 'utf8'));
const catalog = JSON.parse(await readFile(join(docsRoot, 'feature-catalog.json'), 'utf8'));
const errors = [];

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function collectMdx(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectMdx(path)));
		else if (entry.isFile() && extname(entry.name) === '.mdx') files.push(path);
	}
	return files;
}

const navPages = config.navigation.groups.flatMap((group) => group.pages);
for (const page of navPages) {
	if (!(await exists(join(docsRoot, `${page}.mdx`)))) {
		errors.push(`Navigation page does not exist: ${page}`);
	}
}

const featureIds = new Set();
for (const feature of catalog.features) {
	if (!feature.targetPage) errors.push(`Feature has no target page: ${feature.feature}`);
	if (featureIds.has(feature.id)) errors.push(`Duplicate feature id: ${feature.id}`);
	featureIds.add(feature.id);
	if (!(await exists(join(docsRoot, `${feature.targetPage}.mdx`)))) {
		errors.push(`Feature target page does not exist: ${feature.targetPage}`);
	}
}

if (catalog.unassignedCount !== 0) {
	errors.push(`Catalog reports ${catalog.unassignedCount} unassigned features`);
}

const redirectSources = new Set();
for (const redirect of config.redirects ?? []) {
	if (redirectSources.has(redirect.source)) {
		errors.push(`Duplicate redirect source: ${redirect.source}`);
	}
	redirectSources.add(redirect.source);
	const destination = redirect.destination.split('#')[0].replace(/^\//, '');
	if (!(await exists(join(docsRoot, `${destination}.mdx`)))) {
		errors.push(`Redirect destination does not exist: ${redirect.destination}`);
	}
}

const mdxFiles = await collectMdx(docsRoot);
const linkPattern = /\]\((\/[^)\s]+)\)/g;
const hrefPattern = /href=["'](\/[^"']+)["']/g;
const imagePattern = /!\[[^\]]*\]\((\/images\/[^)\s]+)\)/g;

for (const file of mdxFiles) {
	const text = await readFile(file, 'utf8');
	for (const pattern of [linkPattern, hrefPattern]) {
		for (const match of text.matchAll(pattern)) {
			const target = match[1].split('#')[0];
			if (target.startsWith('/images/') || target.startsWith('/logo/')) continue;
			const slug = target.replace(/^\//, '');
			const targetPath = join(docsRoot, `${slug}.mdx`);
			if (!(await exists(targetPath)) && !redirectSources.has(target)) {
				errors.push(`${file.slice(root.length + 1)} links to missing page ${target}`);
			}
		}
	}
	for (const match of text.matchAll(imagePattern)) {
		const image = join(docsRoot, match[1].replace(/^\//, ''));
		if (!(await exists(image))) {
			errors.push(`${file.slice(root.length + 1)} references missing image ${match[1]}`);
		}
	}
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join('\n'));
	process.exit(1);
}

console.log(
	`Validated ${navPages.length} navigation pages, ${catalog.features.length} assigned features, ` +
		`${config.redirects?.length ?? 0} redirects, and ${mdxFiles.length} MDX files`
);
