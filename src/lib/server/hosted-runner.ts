import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolResult } from './providers/types';
import {
	getEffectiveDocwriterDir,
	getEffectiveRoot,
	getEffectiveScratchDir
} from './document-files';
import { isMultiTenant } from './workspace';

const MIB = 1024 * 1024;

const RUNNER = {
	scratchRel: '.docwriter/agent/scratch',
	outputsRel: '.docwriter/agent/outputs',
	defaultTimeoutMs: 30_000,
	maxTimeoutMs: 120_000,
	defaultMaxFileBytes: 2 * MIB,
	defaultMaxBundleBytes: 16 * MIB,
	defaultMaxFiles: 800,
	defaultOutputBytes: 12_000,
	defaultReturnFiles: 100,
	defaultReturnBytes: 8 * MIB
};

type BundleFile = {
	path: string;
	dataBase64: string;
	size: number;
	sha256: string;
};

type RunnerResponseFile = BundleFile;

type RunnerResponse = {
	ok?: boolean;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	durationMs?: number;
	stdout?: string;
	stderr?: string;
	changedPaths?: string[];
	files?: RunnerResponseFile[];
	error?: string;
};

function envInt(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function normalizeRel(path: string): string {
	return path.split(sep).join('/');
}

function isSafeRelPath(path: string): boolean {
	if (!path || path.includes('\0')) return false;
	if (path.startsWith('/') || path.startsWith('\\') || isAbsolute(path)) return false;
	const parts = path.split('/');
	return !parts.some((part) => part === '' || part === '.' || part === '..');
}

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function shouldSkipUserFile(relPath: string): boolean {
	const parts = relPath.split('/');
	const name = parts[parts.length - 1] ?? '';
	if (parts.includes('node_modules') || parts.includes('.git')) return true;
	if (parts.includes('.svelte-kit') || parts.includes('.next') || parts.includes('.vercel')) {
		return true;
	}
	if (parts.includes('dist') || parts.includes('build') || parts.includes('coverage')) return true;
	if (name === '.env' || name.startsWith('.env.')) return true;
	if (name.endsWith('.pem') || name.endsWith('.key')) return true;
	if (name === 'id_rsa' || name === 'id_ed25519') return true;
	return false;
}

function readBundleFile(absPath: string, relPath: string, maxFileBytes: number): BundleFile | null {
	const stat = lstatSync(absPath);
	if (!stat.isFile() || stat.isSymbolicLink()) return null;
	if (stat.size > maxFileBytes) return null;
	const data = readFileSync(absPath);
	return {
		path: relPath,
		dataBase64: data.toString('base64'),
		size: data.length,
		sha256: createHash('sha256').update(data).digest('hex')
	};
}

function collectTree(
	root: string,
	startAbs: string,
	startRel: string,
	limits: { maxFiles: number; maxFileBytes: number; maxBundleBytes: number },
	out: BundleFile[]
): number {
	if (!existsSync(startAbs)) return 0;
	let bytes = 0;
	const entries = readdirSync(startAbs, { withFileTypes: true });
	for (const entry of entries) {
		if (out.length >= limits.maxFiles || bytes >= limits.maxBundleBytes) break;
		const abs = join(startAbs, entry.name);
		const relPath = normalizeRel(startRel ? join(startRel, entry.name) : relative(root, abs));
		if (!isSafeRelPath(relPath) || shouldSkipUserFile(relPath)) continue;
		if (entry.isDirectory()) {
			if (relPath === '.docwriter') continue;
			bytes += collectTree(root, abs, relPath, limits, out);
			continue;
		}
		if (!entry.isFile()) continue;
		const file = readBundleFile(abs, relPath, limits.maxFileBytes);
		if (!file) continue;
		if (bytes + file.size > limits.maxBundleBytes) break;
		out.push(file);
		bytes += file.size;
	}
	return bytes;
}

function collectBundle(): { files: BundleFile[]; skippedByLimit: boolean } {
	const root = getEffectiveRoot();
	const limits = {
		maxFiles: envInt('DOCWRITER_RUNNER_MAX_FILES', RUNNER.defaultMaxFiles),
		maxFileBytes: envInt('DOCWRITER_RUNNER_MAX_FILE_BYTES', RUNNER.defaultMaxFileBytes),
		maxBundleBytes: envInt('DOCWRITER_RUNNER_MAX_BUNDLE_BYTES', RUNNER.defaultMaxBundleBytes)
	};
	const files: BundleFile[] = [];
	let bytes = collectTree(root, root, '', limits, files);

	const scratchDir = getEffectiveScratchDir();
	if (existsSync(scratchDir) && isWithin(scratchDir, root)) {
		bytes += collectTree(root, scratchDir, RUNNER.scratchRel, limits, files);
	}

	return {
		files,
		skippedByLimit: files.length >= limits.maxFiles || bytes >= limits.maxBundleBytes
	};
}

function writeReturnedScratchFile(root: string, file: RunnerResponseFile): boolean {
	if (!file.path.startsWith(RUNNER.scratchRel + '/') || !isSafeRelPath(file.path)) return false;
	const abs = resolve(root, file.path);
	const scratch = resolve(root, RUNNER.scratchRel);
	if (!isWithin(abs, scratch)) return false;
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, Buffer.from(file.dataBase64, 'base64'));
	return true;
}

function fence(text: string | undefined, info = 'text'): string {
	const content = text ?? '';
	let ticks = '```';
	while (content.includes(ticks)) ticks += '`';
	return `${ticks}${info}\n${content}\n${ticks}`;
}

function timestampForPath(date: Date): string {
	return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeRunLog(args: {
	command: string;
	response: RunnerResponse;
	copiedScratchFiles: number;
	bundle: { files: BundleFile[]; skippedByLimit: boolean };
}): string | null {
	try {
		const now = new Date();
		const id = createHash('sha256')
			.update(`${now.toISOString()}\n${args.command}`)
			.digest('hex')
			.slice(0, 8);
		const relPath = `${RUNNER.outputsRel}/run-${timestampForPath(now)}-${id}.md`;
		const absPath = join(getEffectiveDocwriterDir(), 'agent', 'outputs', relPath.split('/').pop()!);
		mkdirSync(dirname(absPath), { recursive: true });
		const exit = args.response.timedOut
			? 'timed out'
			: `exit ${args.response.exitCode ?? args.response.signal ?? 'unknown'}`;
		const changed = args.response.changedPaths ?? [];
		const lines = [
			`# Bash run ${now.toISOString()}`,
			'',
			`Status: ${exit}`,
			`Duration: ${args.response.durationMs ?? 0}ms`,
			`Bundled files: ${args.bundle.files.length}${args.bundle.skippedByLimit ? ' (limit reached)' : ''}`,
			`Scratch files copied back: ${args.copiedScratchFiles}`,
			'',
			'## Command',
			'',
			fence(args.command, 'bash'),
			'',
			'## stdout',
			'',
			fence(args.response.stdout ?? '', 'text'),
			'',
			'## stderr',
			'',
			fence(args.response.stderr ?? '', 'text'),
			'',
			'## Changed paths',
			'',
			changed.length > 0 ? changed.map((path) => `- \`${path}\``).join('\n') : 'None.'
		];
		writeFileSync(absPath, lines.join('\n'), 'utf8');
		return relPath;
	} catch {
		return null;
	}
}

function clip(text: string | undefined): string {
	if (!text) return '';
	return text.length > RUNNER.defaultOutputBytes
		? `${text.slice(0, RUNNER.defaultOutputBytes)}\n...[truncated]`
		: text;
}

function formatResult(
	response: RunnerResponse,
	copiedScratchFiles: number,
	bundle: { files: BundleFile[]; skippedByLimit: boolean },
	logPath: string | null
): ToolResult {
	const lines: string[] = [];
	const exit = response.timedOut
		? 'timed out'
		: `exited ${response.exitCode ?? response.signal ?? 'unknown'}`;
	lines.push(`run_bash ${exit} after ${response.durationMs ?? 0}ms.`);
	lines.push(`Bundled ${bundle.files.length} file${bundle.files.length === 1 ? '' : 's'} from the user workspace.`);
	if (bundle.skippedByLimit) {
		lines.push('Some files were skipped because the bundle limit was reached.');
	}
	if (copiedScratchFiles > 0) {
		lines.push(`Copied ${copiedScratchFiles} changed scratch file${copiedScratchFiles === 1 ? '' : 's'} back to ${RUNNER.scratchRel}/.`);
	}
	if (logPath) {
		lines.push(`Saved run log to \`${logPath}\`.`);
	}

	const changed = response.changedPaths ?? [];
	const nonScratchChanges = changed.filter((path) => !path.startsWith(RUNNER.scratchRel + '/'));
	if (nonScratchChanges.length > 0) {
		lines.push(
			`Sandbox changed ${nonScratchChanges.length} workspace file${nonScratchChanges.length === 1 ? '' : 's'} outside scratch. Those changes were not written back. Use edit_doc/write_doc to propose document changes.`
		);
		lines.push(
			`Changed outside scratch: ${nonScratchChanges.slice(0, 20).join(', ')}${nonScratchChanges.length > 20 ? ', ...' : ''}`
		);
	}

	const stdout = clip(response.stdout);
	const stderr = clip(response.stderr);
	if (stdout) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
	if (stderr) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
	return {
		content: [{ type: 'text', text: lines.join('\n') }],
		isError: !!response.error || response.exitCode !== 0 || !!response.timedOut
	};
}

export async function runHostedBash(input: {
	command?: unknown;
	timeout_ms?: unknown;
}): Promise<ToolResult> {
	if (!isMultiTenant()) {
		return {
			isError: true,
			content: [{ type: 'text', text: 'run_bash is only available in hosted DocWriter.' }]
		};
	}

	const command = typeof input.command === 'string' ? input.command.trim() : '';
	if (!command) {
		return { isError: true, content: [{ type: 'text', text: 'run_bash requires a command.' }] };
	}

	const runnerUrl = process.env.DOCWRITER_RUNNER_URL?.replace(/\/+$/, '');
	if (!runnerUrl) {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: 'Hosted Bash runner is not configured. Set DOCWRITER_RUNNER_URL and DOCWRITER_RUNNER_TOKEN.'
			}]
		};
	}

	const requestedTimeout =
		typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms)
			? Math.floor(input.timeout_ms)
			: RUNNER.defaultTimeoutMs;
	const timeoutMs = Math.max(1000, Math.min(RUNNER.maxTimeoutMs, requestedTimeout));
	const bundle = collectBundle();
	const controller = new AbortController();
	const abortTimer = setTimeout(() => controller.abort(), timeoutMs + 15_000);

	try {
		const res = await fetch(`${runnerUrl}/run`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(process.env.DOCWRITER_RUNNER_TOKEN
					? { Authorization: `Bearer ${process.env.DOCWRITER_RUNNER_TOKEN}` }
					: {})
			},
			body: JSON.stringify({
				command,
				timeoutMs,
				maxOutputBytes: envInt('DOCWRITER_RUNNER_MAX_OUTPUT_BYTES', RUNNER.defaultOutputBytes),
				maxReturnFiles: envInt('DOCWRITER_RUNNER_MAX_RETURN_FILES', RUNNER.defaultReturnFiles),
				maxReturnBytes: envInt('DOCWRITER_RUNNER_MAX_RETURN_BYTES', RUNNER.defaultReturnBytes),
				files: bundle.files
			}),
			signal: controller.signal
		});
		const response = (await res.json().catch(() => ({}))) as RunnerResponse;
		if (!res.ok || response.error) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: `run_bash runner failed: ${response.error || `HTTP ${res.status}`}`
				}]
			};
		}

		const root = getEffectiveRoot();
		let copiedScratchFiles = 0;
		for (const file of response.files ?? []) {
			if (writeReturnedScratchFile(root, file)) copiedScratchFiles += 1;
		}
		const logPath = writeRunLog({
			command,
			response,
			copiedScratchFiles,
			bundle
		});
		return formatResult(response, copiedScratchFiles, bundle, logPath);
	} catch (err) {
		return {
			isError: true,
			content: [{
				type: 'text',
				text: `run_bash failed: ${(err as Error).message}`
			}]
		};
	} finally {
		clearTimeout(abortTimer);
	}
}
