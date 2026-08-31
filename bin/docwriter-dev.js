#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { conflictingCwdState, describeWorkspace, printWorkspaceBanner } from './workspace-identity.js';

const argv = process.argv.slice(2);
let portArg = null;
let hostArg = '127.0.0.1';
let openBrowser = true;
let rootArg = null;
let apiKey = null;
let modelArg = null;
let newSession = false;
let resetUi = false;
let showHelp = false;

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '-h' || a === '--help') {
		showHelp = true;
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
	} else if (a === '--reset-ui') {
		resetUi = true;
	} else if (a === '-p' || a === '--port') {
		portArg = argv[++i];
	} else if (a.startsWith('--port=')) {
		portArg = a.slice(7);
	} else if (a === '--host') {
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
	} else if (!a.startsWith('-')) {
		rootArg = a;
	}
}

if (showHelp) {
	console.log(`
docwriter dev — run the app in Vite watch mode against another workspace

Usage: npm run dev:workspace -- [options] [directory]

Options:
  -p, --port <number>   Dev server port (default: 5173)
      --host [addr]     Bind addr (bare --host → 0.0.0.0)
      --no-open         Don't open a browser window
      --api-key <key>   Anthropic API key (overrides ANTHROPIC_API_KEY)
      --model <name>    Default model: opus | sonnet | haiku
      --new-session     Start with a fresh AI conversation
      --reset-ui        Clear pending reviews and comment threads, then start
  -h, --help            Show this help

Example:
  npm run dev:workspace -- --new-session /Users/shreyashankar/Documents/projects/ai-evals-for-engineers
`.trim());
	process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const viteBin = join(pkgRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const docwriterRoot = resolve(rootArg ?? process.env.DOCWRITER_ROOT ?? process.cwd());
mkdirSync(docwriterRoot, { recursive: true });

const viteArgs = ['dev', '--host', hostArg, '--port', portArg || '5173'];
if (openBrowser) viteArgs.push('--open');

const workspace = describeWorkspace(docwriterRoot);
const cwdConflict = conflictingCwdState(docwriterRoot);

console.log(`\n  docwriter dev  http://${hostArg === '0.0.0.0' ? 'localhost' : hostArg}:${portArg || '5173'}`);
printWorkspaceBanner(workspace, cwdConflict);
if (modelArg) console.log(`  model          ${modelArg}`);
if (newSession) console.log('  session        new (cleared persisted context)');
if (resetUi) console.log('  reset          pending reviews and comment threads');
console.log('');

const child = spawn(process.execPath, [viteBin, ...viteArgs], {
	cwd: pkgRoot,
	env: {
		...process.env,
		DOCWRITER_ROOT: docwriterRoot,
		DOCWRITER_INVOKE_CWD: process.cwd(),
		...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
		...(modelArg ? { DOCWRITER_DEFAULT_MODEL: modelArg } : {}),
		...(newSession ? { DOCWRITER_NEW_SESSION: '1' } : {}),
		...(resetUi ? { DOCWRITER_RESET_UI: '1' } : {})
	},
	stdio: 'inherit'
});

child.on('exit', (code, signal) => {
	if (signal === 'SIGINT' || signal === 'SIGTERM') process.exit(0);
	process.exit(code ?? 1);
});
