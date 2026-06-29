/**
 * Shared helpers for DocWriter Playwright e2e tests.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export const VIEWPORT = { width: 1400, height: 900 };

export const PROVIDER_IDS = ['claude', 'openai', 'codex', 'cursor', 'pi'];

/** Fast/cheap models per provider — override with E2E_MODEL. */
export const DEFAULT_MODELS = {
	claude: 'claude-haiku-4-5',
	openai: 'gpt-5.4-mini',
	codex: 'gpt-5.4-mini',
	cursor: 'composer-2.5',
	pi: 'anthropic/claude-haiku-3-5'
};

/** Primary env var each provider needs in headless CI (no desktop login). */
export const PROVIDER_ENV_VARS = {
	claude: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	codex: 'CODEX_API_KEY',
	cursor: 'CURSOR_API_KEY',
	pi: 'ANTHROPIC_API_KEY'
};

const ESSAY_CONTENT = `# Provider smoke test

This paragraph is fine as written.

This paragraph rambles and could be tighter. [[ Tighten this sentence to under
twelve words. Do not change any other paragraph. ]]

Closing paragraph stays unchanged.
`;

export function agentTimeoutMs() {
	return parseInt(process.env.AGENT_TIMEOUT_MS ?? '', 10) || 120_000;
}

export function modelForProvider(provider) {
	return process.env.E2E_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS.claude;
}

export function hasProviderCredentials(provider) {
	if (provider === 'pi') {
		return Boolean(
			process.env.TOGETHER_API_KEY?.trim() ||
				process.env.ANTHROPIC_API_KEY?.trim() ||
				process.env.OPENAI_API_KEY?.trim() ||
				process.env.GEMINI_API_KEY?.trim()
		);
	}
	const envVar = PROVIDER_ENV_VARS[provider];
	if (!envVar) return false;
	return Boolean(process.env[envVar]?.trim());
}

export function findFreePort() {
	return new Promise((resolveFn, rejectFn) => {
		const srv = createServer();
		srv.once('error', rejectFn);
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			srv.close(() => resolveFn(port));
		});
	});
}

export async function seedFixture() {
	const dir = await mkdtemp(join(tmpdir(), 'docwriter-e2e-'));
	await mkdir(join(dir, 'drafts'), { recursive: true });
	await writeFile(join(dir, 'essay.md'), ESSAY_CONTENT, 'utf8');
	await writeFile(join(dir, 'document.md'), '# Document\n\n', 'utf8');
	return dir;
}

export async function startViteDev(workspace, httpPort, wsPort) {
	const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
	const child = spawn(
		process.execPath,
		[viteBin, 'dev', '--host', '127.0.0.1', '--port', String(httpPort), '--strictPort'],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				DOCWRITER_ROOT: workspace,
				DOCWRITER_NEW_SESSION: '1',
				DOCWRITER_WS_PORT: String(wsPort),
				PUBLIC_DOCWRITER_WS_PORT: String(wsPort)
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);

	child.stdout?.on('data', (chunk) => {
		if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
	});
	child.stderr?.on('data', (chunk) => {
		if (process.env.E2E_VERBOSE) process.stderr.write(chunk);
	});

	for (let i = 0; i < 160; i++) {
		await sleep(250);
		try {
			const res = await fetch(`http://127.0.0.1:${httpPort}/`, { method: 'HEAD' });
			if (res.ok || res.status === 404 || res.status === 302) return child;
		} catch {
			/* not ready */
		}
	}
	child.kill();
	throw new Error(`vite dev did not come up on port ${httpPort} in 40s`);
}

export async function waitForKeyStatus(httpPort, provider, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${httpPort}/api/keys`);
			if (res.ok) {
				const data = await res.json();
				const row = data.providers?.find((p) => p.id === provider);
				if (row?.usable) return row;
			}
		} catch {
			/* retry */
		}
		await sleep(500);
	}
	return null;
}

export function browserInitScript(provider, model) {
	return () => {
		localStorage.setItem('docwriter.dockExpanded', 'true');
		localStorage.setItem('docwriter.showFilesPane', 'true');
		localStorage.setItem('docwriter.selectedProvider', provider);
		localStorage.setItem('docwriter.selectedModel', model);
		localStorage.setItem(
			'docwriter.selectedModelsByProvider',
			JSON.stringify({ [provider]: model })
		);
	};
}

export async function setDockExpanded(page, expanded) {
	if (expanded) {
		const pill = page.locator('.dock-agent-btn').first();
		if (await pill.count()) {
			await pill.click().catch(() => undefined);
			await sleep(350);
		}
	} else {
		const collapse = page.locator('[aria-label="Collapse dock"]').first();
		if (await collapse.count()) {
			await collapse.click().catch(() => undefined);
			await sleep(350);
		}
	}
}

export async function waitForAgentIdle(page, timeout = 30_000) {
	try {
		await page.waitForFunction(
			() => !document.querySelector('.header-agent-btn.awake, .dock-agent-btn.awake'),
			{ timeout }
		);
	} catch {
		/* best effort */
	}
}

export async function openFile(page, label) {
	const name = page.locator('.tree-name', { hasText: new RegExp(`^${label}$`) }).first();
	await name.click();
	await sleep(500);
}

export async function wakeAgent(page) {
	await setDockExpanded(page, true);
	await waitForAgentIdle(page);
	const agentPill = page.locator('.header-agent-btn').first();
	if (!(await agentPill.count())) {
		throw new Error('Agent wake-up button not found');
	}
	await agentPill.click();
}

export async function sendChatMessage(page, message) {
	await setDockExpanded(page, true);
	const sendBtn = page.locator('.dock-message-btn').first();
	await sendBtn.click();
	await sleep(300);
	const textarea = page.locator('.dock-chat-popover textarea').first();
	await textarea.fill(message);
	await sleep(150);
	await page.keyboard.press('Control+Enter');
}

export async function restartAgentSession(page) {
	await setDockExpanded(page, true);
	const restart = page.locator('.header-pill-btn', { hasText: 'Restart' }).first();
	if (await restart.count()) {
		await restart.click();
		await sleep(500);
	}
}

export async function waitForPendingReview(page, timeoutMs) {
	const pending = page.locator('.gutter-card').first();
	await pending.waitFor({ state: 'visible', timeout: timeoutMs });
	return pending;
}

export async function waitForAssistantText(page, pattern, timeoutMs) {
	const locator = page.locator('.history-pane .entry.assistant-text').filter({ hasText: pattern });
	await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
	return locator.first();
}
