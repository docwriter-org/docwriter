#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'docwriter.js');

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: process.env
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`
		);
	}
	return result.stdout.trim();
}

async function getFreePort() {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			assert(address && typeof address === 'object');
			const port = address.port;
			server.close(() => resolvePort(port));
		});
	});
}

async function waitForServer(origin, logs) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/api/hooks`);
			if (response.ok) return;
		} catch {
			// Server is still starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
	}
	throw new Error(`DocWriter did not start in time.\n${logs.join('')}`);
}

function startEventCollector(origin, diagnostics = () => '') {
	const controller = new AbortController();
	const events = [];
	const collecting = (async () => {
		const response = await fetch(`${origin}/api/live`, { signal: controller.signal });
		assert.equal(response.status, 200);
		assert(response.body);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = buffer.indexOf('\n\n')) >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = block
					.split('\n')
					.find((line) => line.startsWith('event: '))
					?.slice('event: '.length);
				const data = block
					.split('\n')
					.find((line) => line.startsWith('data: '))
					?.slice('data: '.length);
				if (!event) continue;
				events.push({ event, data: data ? JSON.parse(data) : {} });
			}
		}
	})().catch((error) => {
		if (error?.name !== 'AbortError') throw error;
	});

	return {
		events,
		async waitFor(predicate, from = 0) {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				const match = events.slice(from).find(predicate);
				if (match) return match;
				await new Promise((resolveWait) => setTimeout(resolveWait, 50));
			}
			throw new Error(
				`Timed out waiting for live event. Saw:\n${JSON.stringify(events.slice(from), null, 2)}\n\nServer logs:\n${diagnostics()}`
			);
		},
		async close() {
			controller.abort();
			await collecting;
		}
	};
}

async function putHooks(origin, hooks) {
	const response = await fetch(`${origin}/api/hooks`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ hooks })
	});
	assert.equal(response.status, 200);
}

async function runHook(origin, id, file = 'main.tex') {
	const response = await fetch(`${origin}/api/hooks/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, file })
	});
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));
	assert.equal(body.entry?.status, 'done', JSON.stringify(body));
	return body.entry;
}

const tempRoot = await mkdtemp(join(tmpdir(), 'docwriter-latex-git-'));
const remote = join(tempRoot, 'remote.git');
const workspace = join(tempRoot, 'paper');
const upstream = join(tempRoot, 'upstream');
let child;
let collector;

try {
	run('git', ['init', '--bare', '--initial-branch=main', remote], tempRoot);
	run('git', ['init', '--initial-branch=main', workspace], tempRoot);
	run('git', ['config', 'user.name', 'DocWriter Integration Test'], workspace);
	run('git', ['config', 'user.email', 'docwriter-test@example.invalid'], workspace);
	run('git', ['remote', 'add', 'origin', remote], workspace);

	await writeFile(
		join(workspace, 'main.tex'),
		[
			'\\documentclass{article}',
			'\\begin{document}',
			'Initial DocWriter integration test.',
			'\\end{document}',
			''
		].join('\n')
	);
	await writeFile(join(workspace, 'references.bib'), '% initial bibliography\n');
	await writeFile(
		join(workspace, '.gitignore'),
		[
			'.docwriter/',
			'*.aux',
			'*.bbl',
			'*.blg',
			'*.log',
			'*.out',
			'*.pdf',
			'*.synctex.gz',
			''
		].join('\n')
	);
	run('git', ['add', '.'], workspace);
	run('git', ['commit', '-m', 'Initial paper'], workspace);
	run('git', ['push', '-u', 'origin', 'main'], workspace);
	run('git', ['clone', remote, upstream], tempRoot);
	run('git', ['config', 'user.name', 'Upstream Test Author'], upstream);
	run('git', ['config', 'user.email', 'upstream@example.invalid'], upstream);

	const port = await getFreePort();
	const origin = `http://127.0.0.1:${port}`;
	const logs = [];
	child = spawn(process.execPath, [CLI_PATH, '--watch', '--no-open', '--port', String(port), workspace], {
		cwd: REPO_ROOT,
		env: { ...process.env, DOCWRITER_DEBUG_WATCH: '1' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
	child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
	await waitForServer(origin, logs);

	collector = startEventCollector(origin, () => logs.join(''));
	await collector.waitFor((event) => event.event === 'connected');

	const watcherProbe = join(workspace, 'watch-probe.tex');
	const beforeProbe = collector.events.length;
	await writeFile(watcherProbe, '% watcher probe\n');
	await collector.waitFor(
		(event) =>
			event.event === 'reload' &&
			Array.isArray(event.data?.files) &&
			event.data.files.includes('watch-probe.tex'),
		beforeProbe
	);
	await rm(watcherProbe);

	const latexHook = {
		id: 'latex',
		event: 'Stop',
		command:
			'pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex && (bibtex main || true) && pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex && pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex',
		output: 'main.pdf',
		enabled: true
	};
	const gitHook = {
		id: 'git',
		event: 'Stop',
		command:
			'git add -A && (git diff --cached --quiet || (git commit -m "docwriter: auto-commit" && git push))',
		enabled: true
	};
	await putHooks(origin, [latexHook, gitHook]);

	const beforeLatex = collector.events.length;
	await runHook(origin, 'latex');
	assert(existsSync(join(workspace, 'main.pdf')), 'pdflatex did not produce main.pdf');
	assert(existsSync(join(workspace, 'main.synctex.gz')), 'pdflatex did not produce SyncTeX data');
	await collector.waitFor(
		(event) =>
			event.event === 'preview_ready' &&
			typeof event.data?.path === 'string' &&
			event.data.path.endsWith('/main.pdf'),
		beforeLatex
	);

	const previewMatch = await fetch(
		`${origin}/api/hooks/preview-match?file=${encodeURIComponent('main.tex')}`
	).then((response) => response.json());
	assert.equal(previewMatch.outputPath, join(workspace, 'main.pdf'));
	const previewResponse = await fetch(
		`${origin}/api/preview?path=${encodeURIComponent('main.pdf')}`
	);
	assert.equal(previewResponse.status, 200);
	assert.match(previewResponse.headers.get('content-type') ?? '', /application\/pdf/);

	const synctexResponse = await fetch(`${origin}/api/synctex`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			mode: 'forward',
			pdf: 'main.pdf',
			file: 'main.tex',
			line: 3,
			column: 1
		})
	}).then((response) => response.json());
	assert.equal(synctexResponse.ok, true, JSON.stringify(synctexResponse));
	assert.equal(synctexResponse.page, 1);

	await writeFile(
		join(upstream, 'main.tex'),
		[
			'\\documentclass{article}',
			'\\begin{document}',
			'Pulled from the simulated Overleaf remote.',
			'\\end{document}',
			''
		].join('\n')
	);
	await writeFile(join(upstream, 'references.bib'), '% pulled bibliography change\n');
	run('git', ['add', 'main.tex', 'references.bib'], upstream);
	run('git', ['commit', '-m', 'Update paper upstream'], upstream);
	run('git', ['push'], upstream);

	const beforePull = collector.events.length;
	run('git', ['pull', '--ff-only'], workspace);
	const reload = await collector.waitFor(
		(event) =>
			event.event === 'reload' &&
			Array.isArray(event.data?.files) &&
			event.data.files.includes('main.tex') &&
			event.data.files.includes('references.bib'),
		beforePull
	);
	assert.deepEqual(
		new Set(reload.data.files),
		new Set(['main.tex', 'references.bib'])
	);
	assert.match(await readFile(join(workspace, 'main.tex'), 'utf8'), /simulated Overleaf remote/);

	const beforeExternalBuild = collector.events.length;
	run(
		'pdflatex',
		['-interaction=nonstopmode', '-halt-on-error', '-synctex=1', 'main.tex'],
		workspace
	);
	await collector.waitFor(
		(event) =>
			event.event === 'preview_ready' &&
			typeof event.data?.path === 'string' &&
			event.data.path.endsWith('/main.pdf'),
		beforeExternalBuild
	);

	await writeFile(
		join(workspace, 'main.tex'),
		(await readFile(join(workspace, 'main.tex'), 'utf8')).replace(
			'Pulled from the simulated Overleaf remote.',
			'Accepted locally and pushed by the Git hook.'
		)
	);
	await runHook(origin, 'git');
	assert.match(
		run('git', ['--git-dir', remote, 'show', 'main:main.tex'], tempRoot),
		/Accepted locally and pushed by the Git hook/
	);
	assert.equal(run('git', ['status', '--porcelain'], workspace), '');

	console.log('PASS: pdflatex produced PDF and SyncTeX output');
	console.log('PASS: DocWriter discovered and served the PDF preview');
	console.log('PASS: SyncTeX source-to-PDF lookup returned page 1');
	console.log('PASS: multi-file Git pull emitted one .tex/.bib reload batch');
	console.log('PASS: external PDF rebuild emitted preview_ready');
	console.log('PASS: Git hook committed and pushed the accepted source change');
} finally {
	if (collector) await collector.close();
	if (child && child.exitCode === null) {
		child.kill('SIGTERM');
		await Promise.race([
			new Promise((resolveExit) => child.once('exit', resolveExit)),
			new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
		]);
		if (child.exitCode === null) child.kill('SIGKILL');
	}
	await rm(tempRoot, { recursive: true, force: true });
}
