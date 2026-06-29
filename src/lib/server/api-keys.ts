/**
 * API key management.
 *
 * Keys can come from three places, highest precedence first:
 *   1. The real process environment (incl. the repo `.env`, which Vite loads
 *      in dev). An explicit env var always wins.
 *   2. `~/.docwriter/keys.env` — a global, cross-workspace KEY=VALUE file that
 *      we load at server startup. This is what the in-app "API keys" panel
 *      writes to, so keys persist across every workspace and survive the
 *      built (non-Vite) server too.
 *   3. A provider-specific login token on disk (e.g. the Codex CLI's ChatGPT
 *      login for OpenAI, or `claude login` for Claude) — handled per-provider.
 *
 * `loadGlobalKeys()` runs once at startup and copies (2) into process.env
 * WITHOUT overriding anything already set, preserving the precedence above.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const GLOBAL_KEYS_PATH = join(homedir(), '.docwriter', 'keys.env');

/** A provider's API-key requirement, for the UI status + set flow. */
export interface ProviderKeySpec {
	id: string;
	label: string;
	/** The env var that holds this provider's API key. */
	envVar: string;
	/** Whether the provider is unusable without an explicit key. */
	required: boolean;
	/** Human note about alternative auth (shown when no key is set). */
	altAuthNote?: string;
}

export const PROVIDER_KEYS: ProviderKeySpec[] = [
	{
		id: 'claude',
		label: 'Claude',
		envVar: 'ANTHROPIC_API_KEY',
		required: false,
		altAuthNote: 'Falls back to your `claude login` (Claude.ai subscription) if no key is set.'
	},
	{
		id: 'openai',
		label: 'OpenAI',
		envVar: 'OPENAI_API_KEY',
		required: true,
		altAuthNote: 'Uses the OpenAI API directly. For your ChatGPT/Codex login instead, use the Codex provider.'
	},
	{
		id: 'codex',
		label: 'Codex',
		envVar: 'CODEX_API_KEY',
		required: false,
		altAuthNote:
			'Falls back to OPENAI_API_KEY or your Codex CLI login (`~/.codex/auth.json`) if no key is set.'
	},
	{ id: 'cursor', label: 'Cursor', envVar: 'CURSOR_API_KEY', required: true },
	{
		id: 'pi',
		label: 'Pi (Together)',
		envVar: 'TOGETHER_API_KEY',
		required: false,
		altAuthNote:
			'Pi routes models to many inference providers; it reuses ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY if set. Set TOGETHER_API_KEY for Together-served models (e.g. Kimi K2.6).'
	}
];

/** Parse a dotenv-style `KEY=VALUE` file. Ignores blanks and `#` comments. */
function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		// Strip surrounding quotes if present.
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key) out[key] = val;
	}
	return out;
}

let loaded = false;

/**
 * Copy `~/.docwriter/keys.env` into process.env, without clobbering vars that
 * are already set (so real env / repo .env keep precedence). Idempotent.
 */
export function loadGlobalKeys(): void {
	if (loaded) return;
	loaded = true;
	if (!existsSync(GLOBAL_KEYS_PATH)) return;
	try {
		const parsed = parseEnvFile(readFileSync(GLOBAL_KEYS_PATH, 'utf8'));
		for (const [key, val] of Object.entries(parsed)) {
			if (process.env[key] === undefined || process.env[key] === '') {
				process.env[key] = val;
			}
		}
	} catch (err) {
		console.warn('[docwriter] could not read', GLOBAL_KEYS_PATH, '-', (err as Error).message);
	}
}

/** True if the Codex CLI has a usable ChatGPT login on disk. */
function hasCodexLogin(): boolean {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
		return auth?.auth_mode === 'chatgpt' && !!auth?.tokens?.access_token;
	} catch {
		return false;
	}
}

/** True if `claude login` credentials are present. */
function hasClaudeLogin(): boolean {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
	// Linux / older installs store a credentials file.
	if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return true;
	// macOS stores them in the Keychain. Existence-only probe (no `-g`, so the
	// secret is never read out); exit 0 means an entry exists.
	if (process.platform === 'darwin') {
		try {
			execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
				stdio: 'ignore'
			});
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

export interface ProviderKeyStatus extends ProviderKeySpec {
	/** Whether the provider's API-key env var is currently populated. */
	present: boolean;
	/** Whether the provider is usable (explicit key OR alternative login). */
	usable: boolean;
	/** Where the satisfying credential came from, for display. */
	source: 'env' | 'login' | null;
}

export function getKeyStatus(): ProviderKeyStatus[] {
	return PROVIDER_KEYS.map((spec) => {
		const present = !!process.env[spec.envVar] || (spec.id === 'codex' && !!process.env.OPENAI_API_KEY);
		let usable = present;
		let source: ProviderKeyStatus['source'] = present ? 'env' : null;
		if (!usable) {
			if (spec.id === 'codex' && (process.env.OPENAI_API_KEY || hasCodexLogin())) {
				usable = true;
				source = process.env.OPENAI_API_KEY ? 'env' : 'login';
			} else if (spec.id === 'claude' && hasClaudeLogin()) {
				usable = true;
				source = 'login';
			}
		}
		return { ...spec, present, usable, source };
	});
}

/**
 * Upsert a key into `~/.docwriter/keys.env` and apply it to the live
 * process.env immediately so the next render picks it up without a restart.
 * Pass an empty value to remove the key.
 */
export function setGlobalKey(name: string, value: string): void {
	if (!/^[A-Z0-9_]+$/.test(name)) {
		throw new Error(`Invalid env var name: ${name}`);
	}
	mkdirSync(dirname(GLOBAL_KEYS_PATH), { recursive: true });

	const existing = existsSync(GLOBAL_KEYS_PATH)
		? parseEnvFile(readFileSync(GLOBAL_KEYS_PATH, 'utf8'))
		: {};

	if (value) existing[name] = value;
	else delete existing[name];

	const header = '# DocWriter global API keys — KEY=VALUE per line. Managed by the API keys panel.';
	const body = Object.entries(existing)
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');
	writeFileSync(GLOBAL_KEYS_PATH, `${header}\n${body}\n`, { mode: 0o600 });

	// Apply live. Setting empty string lets a later getKeyStatus() report absent.
	if (value) process.env[name] = value;
	else delete process.env[name];
}
