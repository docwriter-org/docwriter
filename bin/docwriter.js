#!/usr/bin/env node
/**
 * docwriter — AI-assisted markdown editor CLI
 *
 * Usage:
 *   docwriter [options] [directory]
 *
 * Options:
 *   -p, --port <number>   Port to listen on (default: 7723, or next free port)
 *       --host [addr]     Bind address (default: 127.0.0.1; bare --host → 0.0.0.0)
 *       --no-open         Don't open a browser window on start
 *   -w, --watch           Reload the UI when workspace files change on disk
 *       --restart         Auto-restart the server if it crashes
 *       --root <dir>      Workspace root (default: cwd or positional arg)
 *       --version         Print version and exit
 *       --api-key <key>   Anthropic API key (overrides ANTHROPIC_API_KEY env var)
 *       --model <name>    Default model: opus | sonnet | haiku (overrides UI setting)
 *       --new-session     Clear the persisted AI session — start a fresh conversation
 *   -h, --help            Show this help
 *
 * Auth:
 *   If you have a Claude.ai subscription, just run `docwriter` — no API key needed.
 *   The tool uses credentials stored by `claude login` automatically.
 *   To use the API instead: set ANTHROPIC_API_KEY or pass --api-key.
 *
 * Examples:
 *   docwriter                     # open cwd in the editor
 *   docwriter ~/projects/mybook   # open a specific directory
 *   docwriter --port 8080 --watch # custom port + live file-watch
 *   docwriter --host              # expose to your local network (0.0.0.0)
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, watch as fsWatch } from 'node:fs';

// ---------------------------------------------------------------------------
// Argument parsing (no external deps, pure stdlib)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let portArg = null;
let hostArg = '127.0.0.1';
let openBrowser = true;
let watchFlag = false;
let restartFlag = false;
let rootArg = null;
let apiKey = null;
let modelArg = null;
let newSession = false;
let showHelp = false;
let showVersion = false;

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '-h' || a === '--help') {
		showHelp = true;
	} else if (a === '--version') {
		showVersion = true;
	} else if (a === '--api-key') {
		apiKey = argv[++i];
	} else if (a.startsWith('--api-key=')) {
		apiKey = a.slice(10);
	} else if (a === '--model') {
		modelArg = argv[++i];
	} else if (a.startsWith('--model=')) {
		modelArg = a.slice(8);
	} else if (a === '--new-session') {
		newSession = true;
	} else if (a === '-p' || a === '--port') {
		portArg = parseInt(argv[++i] ?? '', 10);
	} else if (a.startsWith('--port=')) {
		portArg = parseInt(a.slice(7), 10);
	} else if (a === '-p' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
		portArg = parseInt(argv[++i], 10);
	} else if (a === '--host') {
		// bare --host → expose to network; --host <addr> → specific address
		const next = argv[i + 1];
		if (next && !next.startsWith('-') && !/^\d+$/.test(next)) {
			hostArg = next;
			i++;
		} else {
			hostArg = '0.0.0.0';
		}
	} else if (a.startsWith('--host=')) {
		hostArg = a.slice(7) || '0.0.0.0';
	} else if (a === '--no-open') {
		openBrowser = false;
	} else if (a === '-w' || a === '--watch') {
		watchFlag = true;
	} else if (a === '--restart') {
		restartFlag = true;
	} else if (a === '--root') {
		rootArg = argv[++i];
	} else if (a.startsWith('--root=')) {
		rootArg = a.slice(7);
	} else if (!a.startsWith('-')) {
		// Positional: workspace directory
		rootArg = a;
	}
}

// Read version from package.json (next to bin/).
const __dirnameEarly = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirnameEarly, '..', 'package.json'), 'utf8'));

if (showVersion) {
	console.log(pkg.version);
	process.exit(0);
}

if (showHelp) {
	console.log(`
docwriter ${pkg.version} — AI-assisted markdown editor

Usage: docwriter [options] [directory]

Options:
  -p, --port <number>   Port (default: 7723 or next free)
      --host [addr]     Bind addr (bare --host → 0.0.0.0 for LAN access)
      --no-open         Don't open browser on start
  -w, --watch           Reload UI when workspace files change
      --restart         Auto-restart server on crash
      --root <dir>      Workspace root (default: cwd)
      --version         Print version and exit
      --api-key <key>   Anthropic API key (overrides ANTHROPIC_API_KEY)
      --model <name>    Default model: opus | sonnet | haiku
      --new-session     Start a fresh AI conversation (clear persisted session)
  -h, --help            Show this help

Auth:
  Claude.ai subscription: just run docwriter — no API key needed.
  API key: set ANTHROPIC_API_KEY env var or pass --api-key.

Examples:
  docwriter
  docwriter ~/projects/mybook
  docwriter --port 8080 --watch
  docwriter --host --watch          # LAN + live reload
  docwriter --model opus            # force Opus for this session
  docwriter --new-session           # fresh conversation on start
`.trim());
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = __dirnameEarly;
const pkgRoot = join(__dirname, '..');
const buildDir = join(pkgRoot, 'build');
const serverEntry = join(buildDir, 'index.js');

const docwriterRoot = resolve(rootArg ?? process.env.DOCWRITER_ROOT ?? process.cwd());

// Make sure the workspace directory exists (e.g. when targeting a new dir).
mkdirSync(docwriterRoot, { recursive: true });

// Ensure we have a built server.
if (!existsSync(serverEntry)) {
	console.error('[docwriter] No build found — running npm run build...');
	const { execSync } = await import('node:child_process');
	execSync('npm run build', { cwd: pkgRoot, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Port selection
// ---------------------------------------------------------------------------
async function getFreePort(preferred) {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(preferred ?? 7723, () => {
			const port = s.address().port;
			s.close(() => resolve(port));
		});
		s.on('error', () => {
			// Preferred port busy — pick a random free one.
			const s2 = createServer();
			s2.listen(0, () => {
				const port = s2.address().port;
				s2.close(() => resolve(port));
			});
		});
	});
}

const port = isNaN(portArg) || !portArg ? await getFreePort() : portArg;
const origin = `http://${hostArg === '0.0.0.0' ? 'localhost' : hostArg}:${port}`;

// The Y.Doc sync WebSocket server needs its own port. Prefer 3001 but fall
// back to any free port (e.g. when another docwriter / dev server instance
// already holds it). An explicit DOCWRITER_WS_PORT env var wins.
const wsPort = parseInt(process.env.DOCWRITER_WS_PORT ?? '', 10) || (await getFreePort(3001));

const hasApiKey = !!(apiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const authLabel = hasApiKey ? 'api key' : 'claude.ai subscription';

console.log(`\n  docwriter  ${origin}`);
console.log(`  workspace  ${docwriterRoot}`);
console.log(`  auth       ${authLabel}`);
if (modelArg) console.log(`  model      ${modelArg}`);
if (watchFlag) console.log('  watch      on (file changes → browser reload)');
if (restartFlag) console.log('  restart    on crash');
if (newSession) console.log('  session    new (cleared persisted context)');
console.log('');

// ---------------------------------------------------------------------------
// Server spawn (wrapped in restart loop if --restart)
// ---------------------------------------------------------------------------
function spawnServer() {
	const child = spawn(process.execPath, [serverEntry], {
		cwd: pkgRoot,
		env: {
			...process.env,
			DOCWRITER_ROOT: docwriterRoot,
			PORT: String(port),
			HOST: hostArg,
			ORIGIN: origin,
			// Same value twice: the server binds DOCWRITER_WS_PORT, and the
			// browser reads PUBLIC_DOCWRITER_WS_PORT via $env/dynamic/public
			// to know where to connect.
			DOCWRITER_WS_PORT: String(wsPort),
			PUBLIC_DOCWRITER_WS_PORT: String(wsPort),
			// Auth: --api-key overrides the env var (or inherits it if not passed).
			...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
			// CLI model default; render endpoint reads this as fallback.
			...(modelArg ? { DOCWRITER_DEFAULT_MODEL: modelArg } : {}),
			// Signals hooks.server.ts to clear the persisted session on startup.
			...(newSession ? { DOCWRITER_NEW_SESSION: '1' } : {})
		},
		stdio: 'inherit'
	});

	child.on('error', (err) => {
		console.error('[docwriter] Server error:', err.message);
		if (!restartFlag) process.exit(1);
	});

	child.on('exit', (code, signal) => {
		if (signal === 'SIGINT' || signal === 'SIGTERM') {
			process.exit(0);
		}
		if (restartFlag) {
			console.error(`[docwriter] Server exited (${code ?? signal}) — restarting in 1 s...`);
			setTimeout(spawnServer, 1000);
		} else {
			process.exit(code ?? 1);
		}
	});

	return child;
}

let server = spawnServer();

// Forward signals to child.
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		server.kill(sig);
		process.exit(0);
	});
}

// ---------------------------------------------------------------------------
// Browser open (after the server has had a moment to bind)
// ---------------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 900));

if (openBrowser) {
	const cmd =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	spawn(cmd, [origin], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------------------
// File watcher (--watch)
// ---------------------------------------------------------------------------
if (watchFlag) {
	// Debounce: coalesce rapid saves into a single reload after 150 ms.
	let debounce = null;

	const IGNORE_RE =
		/[/\\]\.docwriter[/\\]agent\.md$|[/\\]\.git[/\\]|node_modules[/\\]|\.svelte-kit[/\\]/;

	const WATCH_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);

	function scheduleReload(filename) {
		if (IGNORE_RE.test(filename ?? '')) return;
		const ext = filename ? '.' + filename.split('.').pop() : '';
		if (filename && !WATCH_EXTS.has(ext)) return;

		clearTimeout(debounce);
		debounce = setTimeout(async () => {
			try {
				await fetch(`http://127.0.0.1:${port}/api/live`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ event: 'reload', file: filename })
				});
			} catch {
				// Server may be restarting — ignore.
			}
		}, 150);
	}

	try {
		fsWatch(docwriterRoot, { recursive: true }, (_event, filename) => {
			scheduleReload(filename);
		});
		console.log(`[docwriter] Watching ${docwriterRoot} for changes...`);
	} catch (err) {
		console.warn('[docwriter] --watch: could not start file watcher:', err.message);
	}
}
