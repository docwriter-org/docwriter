import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const MIB = 1024 * 1024;

// The runner is a separate execution boundary. The app may request smaller
// per-run limits, but the runner enforces these ceilings before returning
// output or copied files.
const RUNNER = {
	port: positiveInt(process.env.PORT, 3000),
	token: process.env.RUNNER_SHARED_TOKEN || '',
	scratchRel: '.docwriter/agent/scratch',
	maxRequestBytes: 32 * MIB,
	defaultTimeoutMs: 30_000,
	maxTimeoutMs: 120_000,
	defaultOutputBytes: 12_000,
	maxOutputBytes: 128 * 1024,
	defaultReturnFiles: 100,
	maxReturnFiles: 500,
	defaultReturnBytes: 8 * MIB,
	maxReturnBytes: 32 * MIB
};

if (!RUNNER.token) {
	console.error(
		'[docwriter-runner] RUNNER_SHARED_TOKEN is not set. Refusing to start without a shared token.'
	);
	process.exit(1);
}

// Ignore runtime caches when reporting changed files. They are implementation
// noise from package managers, Python, Rust, and test tools, not user outputs.
const IGNORED_RETURN_PATH_PATTERNS = [
	/^Library\/Caches\//,
	/^\.cache\//,
	/^\.npm\//,
	/^\.yarn\/cache\//,
	/^\.pnpm-store\//,
	/^\.cargo\/registry\//,
	/^\.cargo\/git\//,
	/(^|\/)__pycache__\//,
	/(^|\/)\.pytest_cache\//,
	/(^|\/)\.mypy_cache\//,
	/(^|\/)node_modules\/\.cache\//,
	/\.pyc$/,
	/\.pyo$/
];

function positiveInt(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function json(res, status, body) {
	const payload = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': String(payload.length)
	});
	res.end(payload);
}

function safeEqual(a, b) {
	const aa = Buffer.from(a);
	const bb = Buffer.from(b);
	return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorized(req) {
	const header = req.headers.authorization || '';
	const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
	return !!token && safeEqual(token, RUNNER.token);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', (chunk) => {
			total += chunk.length;
			if (total > RUNNER.maxRequestBytes) {
				reject(new Error('Request too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch {
				reject(new Error('Invalid JSON body'));
			}
		});
		req.on('error', reject);
	});
}

// NOTE: isSafeRelPath and isWithin are duplicated in
// src/lib/server/hosted-runner.ts. The runner is a separate deploy unit
// (Dockerfile.runner copies only this file), so we can't share a module —
// keep both copies in sync.
function isSafeRelPath(path) {
	if (!path || typeof path !== 'string') return false;
	if (path.includes('\0') || path.startsWith('/') || path.startsWith('\\') || isAbsolute(path)) {
		return false;
	}
	return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isWithin(child, parent) {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function writeBundle(workspace, files) {
	for (const file of files || []) {
		if (!isSafeRelPath(file.path)) continue;
		const abs = resolve(workspace, file.path);
		if (!isWithin(abs, workspace)) continue;
		const bytes = Buffer.from(String(file.dataBase64 || ''), 'base64');
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, bytes);
	}
}

function sha256Hex(data) {
	return createHash('sha256').update(data).digest('hex');
}

function walkFiles(root, visit) {
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			visit(abs, relative(root, abs).split(sep).join('/'));
		}
	}
	if (existsSync(root)) walk(root);
}

function snapshotFiles(root) {
	const hashes = new Map();
	walkFiles(root, (abs, rel) => {
		hashes.set(rel, sha256Hex(readFileSync(abs)));
	});
	return hashes;
}

function collectChangedFiles(root, before, limits) {
	const files = [];
	const changedPaths = [];
	let returnedBytes = 0;

	walkFiles(root, (abs, rel) => {
		if (!isSafeRelPath(rel)) return;
		if (IGNORED_RETURN_PATH_PATTERNS.some((pattern) => pattern.test(rel))) return;
		const data = readFileSync(abs);
		const sha256 = sha256Hex(data);
		if (before.get(rel) === sha256) return;
		changedPaths.push(rel);
		if (files.length >= limits.maxReturnFiles) return;
		if (returnedBytes + data.length > limits.maxReturnBytes) return;
		files.push({
			path: rel,
			dataBase64: data.toString('base64'),
			size: data.length,
			sha256
		});
		returnedBytes += data.length;
	});

	return { files, changedPaths };
}

function appendCapped(current, chunk, maxBytes) {
	const next = Buffer.concat([current, Buffer.from(chunk)]);
	return next.length <= maxBytes ? next : next.subarray(next.length - maxBytes);
}

function runCommand(workspace, command, timeoutMs, maxOutputBytes) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn('/bin/bash', ['-lc', command], {
			cwd: workspace,
			env: {
				PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
				HOME: workspace,
				TMPDIR: '/tmp',
				LANG: 'C.UTF-8',
				CI: '1',
				NO_COLOR: '1',
				XDG_CACHE_HOME: '/tmp/.cache',
				PIP_CACHE_DIR: '/tmp/pip-cache',
				NPM_CONFIG_CACHE: '/tmp/npm-cache',
				YARN_CACHE_FOLDER: '/tmp/yarn-cache',
				PNPM_HOME: '/tmp/pnpm-home',
				PYTHONDONTWRITEBYTECODE: '1',
				PYTHONPYCACHEPREFIX: '/tmp/python-pycache',
				GOCACHE: '/tmp/go-cache',
				GOMODCACHE: '/tmp/go-mod-cache',
				CARGO_HOME: '/tmp/cargo-home',
				RUSTUP_HOME: '/tmp/rustup-home'
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		child.stdout?.on('data', (chunk) => {
			stdout = appendCapped(stdout, chunk, maxOutputBytes);
		});
		child.stderr?.on('data', (chunk) => {
			stderr = appendCapped(stderr, chunk, maxOutputBytes);
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				exitCode: -1,
				signal: null,
				timedOut,
				durationMs: Date.now() - started,
				stdout: stdout.toString('utf8'),
				stderr: `${stderr.toString('utf8')}\n${err.message}`.trim()
			});
		});
		child.on('exit', (exitCode, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode,
				signal,
				timedOut,
				durationMs: Date.now() - started,
				stdout: stdout.toString('utf8'),
				stderr: stderr.toString('utf8')
			});
		});
	});
}

async function handleRun(req, res) {
	if (!authorized(req)) {
		json(res, 401, { error: 'Unauthorized' });
		return;
	}

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		json(res, 400, { error: err.message });
		return;
	}

	const command = typeof body.command === 'string' ? body.command.trim() : '';
	if (!command) {
		json(res, 400, { error: 'Missing command' });
		return;
	}

	const timeoutMs = Math.max(
		1000,
		Math.min(RUNNER.maxTimeoutMs, Number(body.timeoutMs) || RUNNER.defaultTimeoutMs)
	);
	const maxOutputBytes = Math.max(
		1000,
		Math.min(RUNNER.maxOutputBytes, Number(body.maxOutputBytes) || RUNNER.defaultOutputBytes)
	);
	const limits = {
		maxReturnFiles: Math.max(
			1,
			Math.min(RUNNER.maxReturnFiles, Number(body.maxReturnFiles) || RUNNER.defaultReturnFiles)
		),
		maxReturnBytes: Math.max(
			1024,
			Math.min(RUNNER.maxReturnBytes, Number(body.maxReturnBytes) || RUNNER.defaultReturnBytes)
		)
	};

	const workspace = mkdtempSync(join(tmpdir(), 'docwriter-runner-'));
	try {
		writeBundle(workspace, Array.isArray(body.files) ? body.files : []);
		mkdirSync(join(workspace, RUNNER.scratchRel), { recursive: true });
		const before = snapshotFiles(workspace);
		const run = await runCommand(workspace, command, timeoutMs, maxOutputBytes);
		const changed = collectChangedFiles(workspace, before, limits);
		json(res, 200, { ok: true, ...run, ...changed });
	} catch (err) {
		json(res, 500, { error: err.message });
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

const server = createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		json(res, 200, { ok: true });
		return;
	}
	if (req.method === 'POST' && req.url === '/run') {
		void handleRun(req, res);
		return;
	}
	json(res, 404, { error: 'Not found' });
});

server.listen(RUNNER.port, '0.0.0.0', () => {
	console.log(`[docwriter-runner] listening on :${RUNNER.port}`);
});
