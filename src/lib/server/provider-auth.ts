/**
 * Per-harness authentication status for the Providers panel.
 *
 * `getKeyStatus()` (api-keys.ts) answers "is there an API key?". This module
 * layers the CLI-login side on top for the two harnesses that have one:
 *
 *   - Claude: `claude auth status` (non-interactive JSON; exit 1 when logged
 *     out) plus the account block in `~/.claude.json`. The probe runs with
 *     ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN stripped so it reports the
 *     saved login, not the key that would outrank it.
 *   - Codex: the auth file the render will actually see (see codex-auth.ts):
 *     a ChatGPT login carries an id_token whose payload names the account.
 *
 * Only identity is read out — never a token or key value. Everything is
 * best-effort with short timeouts: a missing CLI degrades to "not found",
 * never to an error in the panel.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getKeyStatus, workspaceCodexHome, type ProviderKeyStatus } from './api-keys';
import { isUsableCodexAuthFile, userCodexAuthPath } from './codex-auth';

const execFileAsync = promisify(execFile);

export interface ProviderLoginStatus {
	/** Human name of the CLI whose login is reused. */
	cli: string;
	/** The command the author runs in a terminal to sign in. */
	command: string;
	/** Whether that CLI is on PATH (the login command will work as typed). */
	cliFound: boolean;
	loggedIn: boolean;
	version?: string;
	method?: string;
	email?: string;
	organization?: string;
	plan?: string;
	/** Something the author should know (CLI missing, keychain fallback…). */
	note?: string;
}

export interface ProviderAuthStatus extends ProviderKeyStatus {
	/** Present for providers that can reuse a CLI login. */
	login?: ProviderLoginStatus;
}

interface RunResult {
	stdout: string;
	found: boolean;
}

/** Run a CLI probe. Exit code ≠ 0 still yields stdout (auth status exits 1 when logged out). */
async function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			timeout: 8000,
			env: env ?? process.env,
			windowsHide: true,
			maxBuffer: 1 << 20
		});
		return { stdout: String(stdout), found: true };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: string };
		if (e.code === 'ENOENT') return { stdout: '', found: false };
		return { stdout: typeof e.stdout === 'string' ? e.stdout : '', found: true };
	}
}

/** Map `claude auth status`'s `authMethod` to the label the panel shows. */
export function describeClaudeAuthMethod(method: string | undefined): string | undefined {
	if (!method) return undefined;
	const table: Record<string, string> = {
		'claude.ai': 'Claude subscription (claude.ai)',
		claudeai: 'Claude subscription (claude.ai)',
		console: 'Claude Console',
		oauth_token: 'OAuth token (CLAUDE_CODE_OAUTH_TOKEN)',
		api_key: 'API key (ANTHROPIC_API_KEY)',
		api_key_helper: 'apiKeyHelper script',
		bedrock: 'Amazon Bedrock',
		vertex: 'Google Vertex AI',
		foundry: 'Microsoft Foundry'
	};
	return table[method] ?? method;
}

/** Where Claude Code keeps its account stamp (`~/.claude.json`, or under CLAUDE_CONFIG_DIR). */
function claudeConfigJsonPath(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json');
}

interface ClaudeAccount {
	email?: string;
	organization?: string;
}

/** Read the signed-in account's email/org from Claude Code's config stamp. */
export function readClaudeAccount(path = claudeConfigJsonPath()): ClaudeAccount {
	try {
		const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
			oauthAccount?: { emailAddress?: string; organizationName?: string };
		};
		const acct = cfg?.oauthAccount;
		if (!acct) return {};
		return {
			email: typeof acct.emailAddress === 'string' ? acct.emailAddress : undefined,
			organization:
				typeof acct.organizationName === 'string' ? acct.organizationName : undefined
		};
	} catch {
		return {};
	}
}

async function claudeLoginStatus(fileProbeLoggedIn: boolean): Promise<ProviderLoginStatus> {
	// Strip the key-style credentials so the CLI reports the saved login.
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;

	const [status, version] = await Promise.all([
		run('claude', ['auth', 'status'], env),
		run('claude', ['--version'], env)
	]);

	const base: ProviderLoginStatus = {
		cli: 'Claude Code',
		command: 'claude auth login',
		cliFound: status.found,
		loggedIn: fileProbeLoggedIn
	};

	if (!status.found) {
		return {
			...base,
			note: fileProbeLoggedIn
				? 'A saved Claude Code login was found, but `claude` is not on PATH. Install Claude Code to sign in again from a terminal.'
				: 'Claude Code (`claude`) is not on PATH. Install it, then run the command above.'
		};
	}

	let parsed: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {};
	try {
		parsed = JSON.parse(status.stdout.trim() || '{}');
	} catch {
		// Older CLIs print text; fall back to the file probe.
	}
	const loggedIn = typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : fileProbeLoggedIn;
	const account = loggedIn ? readClaudeAccount() : {};
	const versionText = version.stdout.trim().split(/\s+/)[0] || undefined;
	return {
		...base,
		loggedIn,
		version: versionText,
		method: loggedIn ? describeClaudeAuthMethod(parsed.authMethod) : undefined,
		email: account.email,
		organization: account.organization
	};
}

/** Decode the payload of a JWT without verifying it (local identity display only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.');
	if (parts.length < 2) return null;
	try {
		const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
			'utf8'
		);
		const out = JSON.parse(json);
		return out && typeof out === 'object' ? (out as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

interface CodexLoginDetails {
	loggedIn: boolean;
	method?: string;
	email?: string;
	plan?: string;
}

/** Identity details from a Codex `auth.json` (never the tokens themselves). */
export function readCodexLoginDetails(path: string): CodexLoginDetails {
	if (!isUsableCodexAuthFile(path)) return { loggedIn: false };
	try {
		const auth = JSON.parse(readFileSync(path, 'utf8')) as {
			auth_mode?: string;
			tokens?: { id_token?: string } | null;
		};
		if (auth.auth_mode === 'apikey') {
			return { loggedIn: true, method: 'API key saved by `codex login --with-api-key`' };
		}
		const payload = auth.tokens?.id_token ? decodeJwtPayload(auth.tokens.id_token) : null;
		const claims = (payload?.['https://api.openai.com/auth'] ?? {}) as {
			chatgpt_plan_type?: string;
		};
		return {
			loggedIn: true,
			method: 'ChatGPT account',
			email: typeof payload?.email === 'string' ? payload.email : undefined,
			plan:
				typeof claims.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : undefined
		};
	} catch {
		return { loggedIn: true };
	}
}

/** The auth file a Codex render sees: a real workspace-local file wins, else the user's. */
function resolveCodexAuthFile(codexHome: string): string {
	const local = join(codexHome, 'auth.json');
	try {
		if (!lstatSync(local).isSymbolicLink() && existsSync(local)) return local;
	} catch {
		// no workspace-local file
	}
	return userCodexAuthPath();
}

async function codexLoginStatus(): Promise<ProviderLoginStatus> {
	const details = readCodexLoginDetails(resolveCodexAuthFile(workspaceCodexHome()));
	const version = await run('codex', ['--version']);
	const versionText = version.found
		? version.stdout.trim().replace(/^codex(-cli)?\s+/i, '') || undefined
		: undefined;
	return {
		cli: 'Codex CLI',
		command: 'codex login',
		cliFound: version.found,
		loggedIn: details.loggedIn,
		version: versionText,
		method: details.method,
		email: details.email,
		plan: details.plan,
		note: version.found
			? undefined
			: 'The Codex CLI (`codex`) is not on PATH. Install it with `npm install -g @openai/codex`, or run `npx --yes @openai/codex login`.'
	};
}

/** Key status for every provider, plus CLI-login details where a harness has one. */
export async function getProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
	const keys = getKeyStatus();
	const claudeRow = keys.find((k) => k.id === 'claude');
	const [claude, codex] = await Promise.all([
		claudeLoginStatus(claudeRow?.source === 'login'),
		codexLoginStatus()
	]);
	return keys.map((row) => {
		const login = row.id === 'claude' ? claude : row.id === 'codex' ? codex : undefined;
		if (!login) return row;
		// The CLI's own answer outranks the file probe: it sees credentials the
		// probe cannot (Keychain contents, CLAUDE_CODE_OAUTH_TOKEN in the CLI's
		// environment) and knows when a saved login has expired.
		const usable = row.present || (row.source === 'env' && row.usable) || login.loggedIn;
		const source: ProviderKeyStatus['source'] = row.present
			? 'env'
			: row.source === 'env' && row.usable
				? 'env'
				: login.loggedIn
					? 'login'
					: null;
		return { ...row, usable, source, login };
	});
}
