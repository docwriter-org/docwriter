/**
 * Shared shell-hook runner. Used by:
 *   - the render server's `buildHooks` callbacks (auto-fired by the SDK on
 *     PreToolUse / PostToolUse / Stop / etc.)
 *   - the manual /api/hooks/run endpoint (user clicked "Run" on a hook in
 *     the hooks panel — fires the same command outside any agent turn).
 *
 * Both paths emit the same `hook_run` event shape so the HistoryPane can
 * render them uniformly regardless of trigger.
 */
import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { resolveCommand, type Hook } from './hooks-config';

/** Best-effort POST to the /api/live SSE bus on the local Vite/Hocuspocus
 * server so any open preview windows reload. Fire-and-forget; we don't
 * await or surface failures (preview is a nice-to-have, not load-bearing
 * on hook correctness). */
async function broadcastPreviewReady(outputPath: string): Promise<void> {
	const port = process.env.PORT || process.env.VITE_PORT || '5173';
	try {
		await fetch(`http://127.0.0.1:${port}/api/live`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ event: 'preview_ready', path: outputPath })
		});
	} catch {
		/* preview window may not be open; ignore */
	}
}

export type HookRunEmitter = (entry: {
	hookId: string;
	event: string;
	command: string;
	status: 'running' | 'done' | 'failed';
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}) => void;

/** Spawn a shell command, capture output (clipped to 2KB each), and emit
 * start/end events via `emit`. Resolves when the process exits. The
 * `toolName` and `filePath` substitute into `{{tool}}` / `{{file}}`
 * template placeholders in the hook command. For manual runs the toolName
 * is typically empty; pass the active tab's path as `filePath` if set. */
export function runHookCommand(
	hook: Hook,
	toolName: string,
	filePath: string | undefined,
	emit: HookRunEmitter
): Promise<void> {
	return new Promise((resolve) => {
		const command = resolveCommand(hook.command, { tool: toolName, file: filePath });
		const startedAt = Date.now();
		emit({ hookId: hook.id, event: hook.event, command, status: 'running' });

		const child = spawn(command, {
			shell: true,
			cwd: process.env.DOCWRITER_ROOT || process.cwd(),
			env: process.env
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (c) => {
			stdout += c.toString();
			if (stdout.length > 2000) stdout = stdout.slice(-2000);
		});
		child.stderr?.on('data', (c) => {
			stderr += c.toString();
			if (stderr.length > 2000) stderr = stderr.slice(-2000);
		});
		child.on('error', (err) => {
			emit({
				hookId: hook.id,
				event: hook.event,
				command,
				status: 'failed',
				stderr: err.message,
				durationMs: Date.now() - startedAt
			});
			resolve();
		});
		child.on('exit', (code) => {
			emit({
				hookId: hook.id,
				event: hook.event,
				command,
				status: code === 0 ? 'done' : 'failed',
				exitCode: code ?? -1,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt
			});
			// If the hook produced an output file (e.g. pdflatex → .pdf),
			// nudge any open preview windows to reload with scroll
			// preserved. Only fire on success — failed runs leave the old
			// output in place.
			if (code === 0 && hook.output) {
				const resolvedOutput = resolveCommand(hook.output, {
					tool: toolName,
					file: filePath
				});
				if (resolvedOutput) {
					const abs = resolvePath(
						process.env.DOCWRITER_ROOT || process.cwd(),
						resolvedOutput
					);
					void broadcastPreviewReady(abs);
				}
			}
			resolve();
		});
	});
}
