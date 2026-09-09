/**
 * Embedded login terminals for the Providers dialog.
 *
 * `claude auth login` and `codex login` are interactive TUIs that need a
 * real TTY (both print nothing and hang on a pipe), so the dialog runs
 * them in a PTY on the DocWriter server and streams the bytes to an xterm
 * in the browser — the same thing Conductor's "Running claude /login" box
 * does. The command set is a fixed allowlist: the route takes a provider
 * id, never an argv, so the localhost HTTP server never becomes a shell.
 *
 * Sessions live in memory: one per provider (starting a new one kills the
 * old one), a bounded replay buffer so a reconnecting stream sees what was
 * already printed, and a grace period after exit before the record is
 * dropped. node-pty is imported lazily so a failed native build surfaces
 * as an error in the panel rather than at server boot.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';

export type LoginProvider = 'claude' | 'codex';

export interface LoginCommand {
	/** Executable to spawn. */
	file: string;
	args: string[];
	/** What the panel shows in the terminal header. */
	display: string;
	/** Where the executable came from, for the header/tooltip. */
	source: 'path' | 'bundled';
}

const require = createRequire(import.meta.url);

/** Find `name` on PATH (honours PATHEXT on Windows). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const pathVar = env.PATH ?? env.Path ?? '';
	const exts =
		process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext.toLowerCase());
			if (existsSync(candidate)) return candidate;
			if (ext && existsSync(join(dir, name + ext))) return join(dir, name + ext);
		}
	}
	return null;
}

/** The Claude binary the Agent SDK itself runs, so a login taken here is the one renders use. */
function bundledClaudeBinary(): string | null {
	const platform = `${process.platform}-${process.arch}`;
	const candidates = [
		`@anthropic-ai/claude-agent-sdk-${platform}`,
		`@anthropic-ai/claude-agent-sdk-${platform}-musl`
	];
	for (const pkg of candidates) {
		try {
			const dir = dirname(require.resolve(`${pkg}/package.json`));
			const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
			if (existsSync(bin)) return bin;
		} catch {
			// not installed for this platform
		}
	}
	return null;
}

/** Resolve the fixed login command for a provider. Never derived from request input. */
export function resolveLoginCommand(provider: LoginProvider): LoginCommand {
	if (provider === 'claude') {
		const onPath = findOnPath('claude');
		if (onPath) {
			return { file: onPath, args: ['auth', 'login'], display: 'claude auth login', source: 'path' };
		}
		const bundled = bundledClaudeBinary();
		if (bundled) {
			return { file: bundled, args: ['auth', 'login'], display: 'claude auth login', source: 'bundled' };
		}
		throw new Error('Claude Code is not installed: `claude` is not on PATH and no bundled binary was found.');
	}
	if (provider === 'codex') {
		const onPath = findOnPath('codex');
		if (onPath) return { file: onPath, args: ['login'], display: 'codex login', source: 'path' };
		try {
			const launcher = require.resolve('@openai/codex/bin/codex.js');
			return {
				file: process.execPath,
				args: [launcher, 'login'],
				display: 'codex login',
				source: 'bundled'
			};
		} catch {
			throw new Error('The Codex CLI is not installed: `codex` is not on PATH and @openai/codex is missing.');
		}
	}
	throw new Error(`No login flow for provider "${provider satisfies never}".`);
}

/** Environment for the login process: the user's shell env, minus key-style
 * credentials that would make the CLI skip or second-guess the login. */
function loginEnv(provider: LoginProvider): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
	if (provider === 'claude') {
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
	} else {
		delete env.CODEX_API_KEY;
		delete env.OPENAI_API_KEY;
	}
	return env;
}

export type LoginTerminalEvent =
	| { type: 'data'; data: string }
	| { type: 'exit'; code: number };

interface Session {
	id: string;
	provider: LoginProvider;
	command: LoginCommand;
	pty: IPty;
	/** Replay buffer for late subscribers; capped by BUFFER_LIMIT chars. */
	chunks: string[];
	buffered: number;
	listeners: Set<(event: LoginTerminalEvent) => void>;
	exitCode: number | null;
	cleanupTimer: NodeJS.Timeout | null;
}

const BUFFER_LIMIT = 256 * 1024;
const EXIT_GRACE_MS = 5 * 60 * 1000;

const sessions = new Map<string, Session>();

function trimBuffer(s: Session) {
	while (s.buffered > BUFFER_LIMIT && s.chunks.length > 1) {
		const dropped = s.chunks.shift()!;
		s.buffered -= dropped.length;
	}
}

function emit(s: Session, event: LoginTerminalEvent) {
	for (const fn of s.listeners) {
		try {
			fn(event);
		} catch {
			// a broken subscriber must not stall the others
		}
	}
}

function dropSession(id: string) {
	const s = sessions.get(id);
	if (!s) return;
	if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
	sessions.delete(id);
}

export interface StartedLoginSession {
	id: string;
	provider: LoginProvider;
	display: string;
	source: LoginCommand['source'];
}

/** Start a login terminal for `provider`, replacing any live one for it. */
export async function startLoginSession(
	provider: LoginProvider,
	size: { cols: number; rows: number } = { cols: 100, rows: 28 }
): Promise<StartedLoginSession> {
	for (const s of sessions.values()) {
		if (s.provider === provider) killLoginSession(s.id);
	}
	const command = resolveLoginCommand(provider);
	let pty: typeof import('node-pty');
	try {
		pty = await import('node-pty');
	} catch (err) {
		throw new Error(
			'node-pty failed to load, so the embedded terminal is unavailable. Run the command in your own terminal instead: ' +
				command.display +
				'\n' +
				(err as Error).message
		);
	}
	const cols = Math.max(20, Math.min(400, Math.floor(size.cols) || 100));
	const rows = Math.max(5, Math.min(200, Math.floor(size.rows) || 28));
	const proc = pty.spawn(command.file, command.args, {
		name: 'xterm-256color',
		cols,
		rows,
		cwd: process.env.HOME || process.cwd(),
		env: loginEnv(provider)
	});
	const session: Session = {
		id: randomUUID(),
		provider,
		command,
		pty: proc,
		chunks: [],
		buffered: 0,
		listeners: new Set(),
		exitCode: null,
		cleanupTimer: null
	};
	sessions.set(session.id, session);
	proc.onData((data) => {
		session.chunks.push(data);
		session.buffered += data.length;
		trimBuffer(session);
		emit(session, { type: 'data', data });
	});
	proc.onExit(({ exitCode }) => {
		session.exitCode = exitCode;
		emit(session, { type: 'exit', code: exitCode });
		session.cleanupTimer = setTimeout(() => dropSession(session.id), EXIT_GRACE_MS);
	});
	return { id: session.id, provider, display: command.display, source: command.source };
}

/**
 * Subscribe to a session's output. Replays what was already printed, then
 * streams live; an already-exited session replays and then reports exit.
 * Returns null for an unknown id.
 */
export function subscribeLoginSession(
	id: string,
	fn: (event: LoginTerminalEvent) => void
): (() => void) | null {
	const s = sessions.get(id);
	if (!s) return null;
	if (s.chunks.length) fn({ type: 'data', data: s.chunks.join('') });
	if (s.exitCode !== null) {
		fn({ type: 'exit', code: s.exitCode });
		return () => {};
	}
	s.listeners.add(fn);
	return () => s.listeners.delete(fn);
}

export function writeLoginInput(id: string, data: string): boolean {
	const s = sessions.get(id);
	if (!s || s.exitCode !== null) return false;
	s.pty.write(data);
	return true;
}

export function resizeLoginSession(id: string, cols: number, rows: number): boolean {
	const s = sessions.get(id);
	if (!s || s.exitCode !== null) return false;
	const c = Math.max(20, Math.min(400, Math.floor(cols) || 0));
	const r = Math.max(5, Math.min(200, Math.floor(rows) || 0));
	if (!c || !r) return false;
	try {
		s.pty.resize(c, r);
	} catch {
		return false;
	}
	return true;
}

export function killLoginSession(id: string): boolean {
	const s = sessions.get(id);
	if (!s) return false;
	if (s.exitCode === null) {
		try {
			s.pty.kill();
		} catch {
			// already gone
		}
	}
	dropSession(id);
	return true;
}

export function isLoginProvider(value: unknown): value is LoginProvider {
	return value === 'claude' || value === 'codex';
}
