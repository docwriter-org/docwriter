#!/usr/bin/env node

import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PDFJS_VERSION = '4.0.379';
const PDFJS_ARCHIVE_SHA256 = '11e5e00cf620e73f4b0b832d662b37d6a0cd25b3d0c817acfffec8516bc922dc';
const PDFJS_ARCHIVE_URL = `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const STATIC_DIR = join(REPO_ROOT, 'static');
const TARGET_DIR = join(STATIC_DIR, 'pdfjs');
const STAGING_DIR = join(STATIC_DIR, `.pdfjs-${process.pid}`);
const MARKER_FILE = join(TARGET_DIR, '.docwriter-pdfjs.json');
const THEME_SOURCE = join(REPO_ROOT, 'assets', 'pdfjs', 'docwriter-theme.css');

const EXACT_FILES = new Set([
	'LICENSE',
	'build/pdf.mjs',
	'build/pdf.sandbox.mjs',
	'build/pdf.worker.mjs',
	'web/locale/locale.json',
	'web/viewer.css',
	'web/viewer.html',
	'web/viewer.mjs'
]);

const DIRECTORY_PREFIXES = [
	'web/cmaps/',
	'web/images/',
	'web/locale/en-US/',
	'web/standard_fonts/'
];

const REQUIRED_OUTPUTS = [
	'build/pdf.mjs',
	'build/pdf.worker.mjs',
	'web/viewer.html',
	'web/viewer.mjs',
	'web/docwriter-theme.css'
];

function shouldExtract(name) {
	return EXACT_FILES.has(name) || DIRECTORY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function outputPath(root, archivePath) {
	const destination = resolve(root, archivePath);
	if (destination !== root && !destination.startsWith(root + sep)) {
		throw new Error(`Unsafe path in PDF.js archive: ${archivePath}`);
	}
	return destination;
}

async function installationIsCurrent() {
	try {
		const marker = JSON.parse(await readFile(MARKER_FILE, 'utf8'));
		return (
			marker.version === PDFJS_VERSION &&
			marker.sha256 === PDFJS_ARCHIVE_SHA256 &&
			REQUIRED_OUTPUTS.every((path) => existsSync(join(TARGET_DIR, path)))
		);
	} catch {
		return false;
	}
}

async function downloadArchive() {
	console.log(`[pdfjs] Downloading PDF.js ${PDFJS_VERSION}...`);
	const response = await fetch(PDFJS_ARCHIVE_URL, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`PDF.js download failed with HTTP ${response.status}`);
	}
	const archive = Buffer.from(await response.arrayBuffer());
	const sha256 = createHash('sha256').update(archive).digest('hex');
	if (sha256 !== PDFJS_ARCHIVE_SHA256) {
		throw new Error(`PDF.js checksum mismatch. Expected ${PDFJS_ARCHIVE_SHA256}, received ${sha256}.`);
	}
	return archive;
}

function addThemeLink(viewerHtml) {
	const viewerCss = '    <link rel="stylesheet" href="viewer.css">';
	if (!viewerHtml.includes(viewerCss)) {
		throw new Error('Could not find the PDF.js viewer stylesheet link.');
	}
	return viewerHtml.replace(
		viewerCss,
		`${viewerCss}\n    <link rel="stylesheet" href="docwriter-theme.css">`
	);
}

async function installPdfJs() {
	if (await installationIsCurrent()) {
		console.log(`[pdfjs] PDF.js ${PDFJS_VERSION} is ready.`);
		return;
	}

	const archive = await downloadArchive();
	const zip = new AdmZip(archive);
	const selectedEntries = zip
		.getEntries()
		.filter((entry) => !entry.isDirectory && shouldExtract(entry.entryName));

	for (const required of EXACT_FILES) {
		if (!selectedEntries.some((entry) => entry.entryName === required)) {
			throw new Error(`PDF.js archive is missing ${required}.`);
		}
	}

	await rm(STAGING_DIR, { recursive: true, force: true });
	try {
		for (const entry of selectedEntries) {
			const destination = outputPath(STAGING_DIR, entry.entryName);
			await mkdir(dirname(destination), { recursive: true });
			let contents = entry.getData();
			if (entry.entryName === 'web/viewer.html') {
				contents = Buffer.from(addThemeLink(contents.toString('utf8')), 'utf8');
			}
			await writeFile(destination, contents);
		}

		await writeFile(
			join(STAGING_DIR, 'web', 'docwriter-theme.css'),
			await readFile(THEME_SOURCE)
		);
		await writeFile(
			join(STAGING_DIR, '.docwriter-pdfjs.json'),
			`${JSON.stringify({ version: PDFJS_VERSION, sha256: PDFJS_ARCHIVE_SHA256 }, null, 2)}\n`
		);

		await rm(TARGET_DIR, { recursive: true, force: true });
		await rename(STAGING_DIR, TARGET_DIR);
	} catch (error) {
		await rm(STAGING_DIR, { recursive: true, force: true });
		throw error;
	}

	console.log(`[pdfjs] Installed PDF.js ${PDFJS_VERSION}.`);
}

await installPdfJs();
