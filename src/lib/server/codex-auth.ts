/**
 * Codex CLI login plumbing.
 *
 * The Codex provider launches the CLI with `CODEX_HOME` pointed at
 * `.docwriter/codex` so its sessions, logs and config stay per-workspace and
 * out of the user's `~/.codex`. The CLI resolves `auth.json` relative to
 * `CODEX_HOME` too, so that override also hid the user's `codex login`: the
 * API keys panel said "Using login" (it probed `~/.codex/auth.json`) while
 * every render started from an empty home and failed as "Not logged in".
 *
 * `linkCodexAuth` bridges the two: it symlinks `<CODEX_HOME>/auth.json` to
 * `~/.codex/auth.json` when no API key is set. A symlink (not a copy) matters:
 * the CLI rewrites `auth.json` in place on token refresh, and refresh tokens
 * rotate, so a diverged copy would invalidate one side. Verified against
 * codex-cli 0.139: `codex login --with-api-key` through the link updates the
 * target and leaves the link alone. `codex logout` removes the link itself,
 * not the target, so the next render re-links.
 *
 * Every function takes explicit paths so tests can point them at temp dirs.
 */
import { copyFileSync, existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the Codex CLI keeps its own login: `~/.codex/auth.json`. */
export function userCodexAuthPath(): string {
	return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}

interface CodexAuthFile {
	auth_mode?: string;
	OPENAI_API_KEY?: string | null;
	tokens?: { access_token?: string } | null;
}

/**
 * True when the auth file at `path` carries a credential the CLI can use:
 * a ChatGPT login with an access token, or an API key stored by
 * `codex login --with-api-key`.
 */
export function isUsableCodexAuthFile(path: string): boolean {
	try {
		const auth = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile;
		if (auth?.auth_mode === 'chatgpt') return !!auth.tokens?.access_token;
		if (auth?.auth_mode === 'apikey') return !!auth.OPENAI_API_KEY;
		return !!auth?.tokens?.access_token || !!auth?.OPENAI_API_KEY;
	} catch {
		return false;
	}
}

export type CodexAuthLink =
	| { kind: 'own' }
	| { kind: 'linked'; target: string }
	| { kind: 'copied'; target: string }
	| { kind: 'none' };

/**
 * Make the user's Codex login visible inside `codexHome`.
 *
 * - A real (non-symlink) `auth.json` already in `codexHome` is left alone:
 *   someone logged in with `CODEX_HOME=<codexHome> codex login` on purpose.
 * - Otherwise, if the user's auth file exists, (re)create the symlink —
 *   replacing a dangling one from an earlier logout.
 * - Where symlinks are not permitted (Windows without developer mode) fall
 *   back to a copy; a copy can go stale after a token refresh, so it is
 *   refreshed on every call.
 */
export function linkCodexAuth(codexHome: string, userAuth = userCodexAuthPath()): CodexAuthLink {
	const local = join(codexHome, 'auth.json');
	let localStat: ReturnType<typeof lstatSync> | null = null;
	try {
		localStat = lstatSync(local);
	} catch {
		localStat = null;
	}
	if (localStat && !localStat.isSymbolicLink()) return { kind: 'own' };
	if (!existsSync(userAuth)) return { kind: 'none' };
	if (localStat?.isSymbolicLink()) {
		// Already linked to the right place and not dangling → nothing to do.
		if (existsSync(local)) return { kind: 'linked', target: userAuth };
		unlinkSync(local);
	}
	try {
		symlinkSync(userAuth, local);
		return { kind: 'linked', target: userAuth };
	} catch {
		try {
			copyFileSync(userAuth, local);
			return { kind: 'copied', target: userAuth };
		} catch {
			return { kind: 'none' };
		}
	}
}

/**
 * True if a Codex CLI login is on disk that a render will actually see:
 * the workspace `CODEX_HOME`'s own auth file if it has one, else the
 * user's `~/.codex/auth.json` (which `linkCodexAuth` exposes at render time).
 */
export function hasCodexLogin(codexHome: string, userAuth = userCodexAuthPath()): boolean {
	const local = join(codexHome, 'auth.json');
	try {
		if (!lstatSync(local).isSymbolicLink() && isUsableCodexAuthFile(local)) return true;
	} catch {
		// no workspace-local auth file
	}
	return isUsableCodexAuthFile(userAuth);
}
