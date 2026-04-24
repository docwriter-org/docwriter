import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// DocWriter persistence layout (post Phase 5+6):
//
//   <file-the-user-wanted>.md         ← ANY file in the workspace can be
//   drafts/chapter-1.md                 an open tab. Tab ID = the file's
//   src/app/script.py                   path relative to DOCWRITER_ROOT.
//   ...
//   .docwriter/
//     docwriter.db                    ← SQLite: Y.Doc updates, tabs, rules,
//                                       hooks, recent_actions, kv (sessionId
//                                       + last_seen:<tabId>).
//     agent/scratch/                  ← agent scratch workspace — created
//                                       lazily on first scratch write.
//
// The old per-tab shadow directory (.docwriter/agent/<tabId>) is gone:
// agent edits now mutate the live Hocuspocus Y.Doc via the custom MCP
// tools in `mcp-doc-tools.ts`, which syncs directly to the browser.

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();

export const WORKSPACE_ROOT = ROOT;

export const DOCWRITER_DIR = join(ROOT, '.docwriter');
/** Scratch workspace the agent can freely Write/Edit without user review.
 * Meant for its own drafts, outlines, intermediate notes-to-self. Not
 * surfaced as tabs; survives across rounds in the same session; cleared
 * when the user starts a new session. Created lazily — no `.docwriter/agent/`
 * directory is created unless the agent actually writes a scratch file. */
export const AGENT_SCRATCH_DIR = join(DOCWRITER_DIR, 'agent', 'scratch');

/** File extensions we treat as text-editable tabs. */
const TEXT_EXTENSIONS = new Set([
	'md',
	'markdown',
	'mdx',
	'txt',
	'json',
	'jsonl',
	'yaml',
	'yml',
	'toml',
	'ts',
	'tsx',
	'js',
	'jsx',
	'py',
	'rs',
	'go',
	'java',
	'cpp',
	'c',
	'h',
	'hpp',
	'html',
	'htm',
	'css',
	'scss',
	'sass',
	'less',
	'sh',
	'bash',
	'zsh',
	'ps1',
	'sql',
	'xml',
	'svg',
	'csv',
	'tsv',
	'log',
	'env',
	'ini',
	'conf',
	'gitignore',
	'gitattributes',
	'rst'
]);

/** A tab id is a workspace-relative path (e.g. "drafts/chapter-1.md" or
 * "script.py"). Must be safe: no leading slash, no `..` segments, no null
 * bytes, no empty segments. */
export function isValidTabId(id: string): boolean {
	if (!id || id.length > 512) return false;
	if (id.startsWith('/') || id.startsWith('\\')) return false;
	if (id.includes('\0')) return false;
	const segments = id.split('/');
	for (const seg of segments) {
		if (seg === '..' || seg === '.' || seg === '') return false;
	}
	return true;
}

export function isKnownTextExtension(tabId: string): boolean {
	const ext = extensionOf(tabId);
	return ext !== null && TEXT_EXTENSIONS.has(ext);
}

function extensionOf(path: string): string | null {
	const base = path.split('/').pop() || '';
	const idx = base.lastIndexOf('.');
	if (idx <= 0) return null;
	return base.slice(idx + 1).toLowerCase();
}

/** Absolute path to a tab's user-facing file under DOCWRITER_ROOT. */
export function tabFile(tabId: string): string {
	return join(ROOT, tabId);
}

/** Ensure `.docwriter/` exists. Idempotent. Does NOT create
 * `.docwriter/agent/`; that directory is created lazily only if the agent
 * actually writes a scratch file. */
export function ensureDocWriterDir() {
	if (!existsSync(DOCWRITER_DIR)) {
		mkdirSync(DOCWRITER_DIR, { recursive: true });
	}
}

/** Ensure the agent's scratch dir exists. Called lazily the first time the
 * agent writes a scratch file. Idempotent. */
export function ensureAgentScratchDir() {
	ensureDocWriterDir();
	if (!existsSync(AGENT_SCRATCH_DIR)) {
		mkdirSync(AGENT_SCRATCH_DIR, { recursive: true });
	}
}

/** True iff `path` is the scratch dir itself or somewhere inside it. */
export function isAgentScratchPath(path: string): boolean {
	return path === AGENT_SCRATCH_DIR || path.startsWith(AGENT_SCRATCH_DIR + '/');
}
