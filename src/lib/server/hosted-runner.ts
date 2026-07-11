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

// The runner enforces its own defaults and ceilings on output/returned-file
// sizes; these constants only govern what we bundle, clip, and time out here.
const RUNNER = {
	scratchRel: '.docwriter/agent/scratch',
	outputsRel: '.docwriter/agent/outputs',
	defaultTimeoutMs: 30_000,
	maxTimeoutMs: 120_000,
	maxFileBytes: 2 * MIB,
	maxBundleBytes: 16 * MIB,
	maxFiles: 800,
	outputClipBytes: 12_000
};

type BundleFile = {
	path: string;
	dataBase64: string;
	size: number;
	sha256: string;
};

type RunnerResponse = {
	ok?: boolean;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	durationMs?: number;
	stdout?: string;
	stderr?: string;
	changedPaths?: string[];
	files?: BundleFile[];
	error?: string;
};

function normalizeRel(path: string): string {
	return path.split(sep).join('/');
}

// NOTE: isSafeRelPath and isWithin are duplicated in runner/server.js. The
// runner is a separate deploy unit (Dockerfile.runner copies only that file),
// so we can't share a module — keep both copies in sync.
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
	state: { files: BundleFile[]; bytes: number }
): void {
	if (!existsSync(startAbs)) return;
	const dirs = [startAbs];
	while (dirs.length > 0) {
		const dir = dirs.shift()!;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (state.files.length >= RUNNER.maxFiles || state.bytes >= RUNNER.maxBundleBytes) return;
			const abs = join(dir, entry.name);
			const relPath = normalizeRel(relative(root, abs));
			if (!isSafeRelPath(relPath) || shouldSkipUserFile(relPath)) continue;
			if (entry.isDirectory()) {
				if (relPath === '.docwriter') continue;
				dirs.push(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const file = readBundleFile(abs, relPath, RUNNER.maxFileBytes);
			if (!file) continue;
			if (state.bytes + file.size > RUNNER.maxBundleBytes) continue;
			state.files.push(file);
			state.bytes += file.size;
		}
	}
}

function collectBundle(): { files: BundleFile[]; skippedByLimit: boolean } {
	const root = getEffectiveRoot();
	const state = { files: [] as BundleFile[], bytes: 0 };
	collectTree(root, root, state);

	const scratchDir = getEffectiveScratchDir();
	if (existsSync(scratchDir) && isWithin(scratchDir, root)) {
		collectTree(root, scratchDir, state);
	}

	return {
		files: state.files,
		skippedByLimit: state.files.length >= RUNNER.maxFiles || state.bytes >= RUNNER.maxBundleBytes
	};
}

function writeReturnedScratchFile(root: string, file: BundleFile): boolean {
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

function exitStatus(response: RunnerResponse): string {
	return response.timedOut
		? 'timed out'
		: `exited ${response.exitCode ?? response.signal ?? 'unknown'}`;
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
		const fileName = `run-${timestampForPath(now)}-${id}.md`;
		const relPath = `${RUNNER.outputsRel}/${fileName}`;
		const absPath = join(getEffectiveDocwriterDir(), 'agent', 'outputs', fileName);
		mkdirSync(dirname(absPath), { recursive: true });
		const changed = args.response.changedPaths ?? [];
		const lines = [
			`# Bash run ${now.toISOString()}`,
			'',
			`Status: ${exitStatus(args.response)}`,
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
	return text.length > RUNNER.outputClipBytes
		? `${text.slice(0, RUNNER.outputClipBytes)}\n...[truncated]`
		: text;
}

function formatResult(
	response: RunnerResponse,
	copiedScratchFiles: number,
	bundle: { files: BundleFile[]; skippedByLimit: boolean },
	logPath: string | null
): ToolResult {
	const lines: string[] = [];
	lines.push(`run_bash ${exitStatus(response)} after ${response.durationMs ?? 0}ms.`);
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
				text: 'Hosted Bash runner is not configured. Set DOCWRITER_RUNNER_URL and RUNNER_SHARED_TOKEN.'
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
				...(process.env.RUNNER_SHARED_TOKEN
					? { Authorization: `Bearer ${process.env.RUNNER_SHARED_TOKEN}` }
					: {})
			},
			body: JSON.stringify({
				command,
				timeoutMs,
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
