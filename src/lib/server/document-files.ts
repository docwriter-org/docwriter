import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

// DocWriter persistence layout (v2, post-notes/ refactor):
//
//   <file-the-user-wanted>.md         ← ANY file in the workspace can be
//   drafts/chapter-1.md                 an open tab. Tab ID = the file's
//   src/app/script.py                   path relative to DOCWRITER_ROOT.
//   ...
//   .docwriter/
//     agent/<relative-path>           ← per-tab shadow, mirrors the
//                                       user-facing file's location under
//                                       DOCWRITER_ROOT
//     state.json                      ← sessionId, rules,
//                                       agentSettings, tabs.{order,active}
//
// The old flat `notes/` directory is gone. Any file you open from the
// FileTree becomes an agent-editable tab, and its shadow gets created
// on demand inside .docwriter/agent/ with the same relative path.

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();

export const DOCWRITER_DIR = join(ROOT, '.docwriter');
export const AGENT_DIR = join(DOCWRITER_DIR, 'agent');
/** Scratch workspace the agent can freely Write/Edit without user review.
 * Meant for its own drafts, outlines, intermediate notes-to-self. Not
 * surfaced as tabs; survives across rounds in the same session; cleared
 * when the user starts a new session. */
export const AGENT_SCRATCH_DIR = join(AGENT_DIR, 'scratch');
export const STATE_FILE = join(DOCWRITER_DIR, 'state.json');

/** File extensions we treat as text-editable tabs. `.md`/`.markdown`/`.mdx`
 * render as markdown in the editor; others render as plain text. */
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

/** Classify a tab file. `.md` family → markdown editor; anything else that's
 * a recognized text extension → plain editor. Unknown extensions still get
 * 'plain' so we don't hard-block weird file types. */
export function tabKind(tabId: string): 'markdown' | 'plain' {
	const ext = extensionOf(tabId);
	if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
	return 'plain';
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

/** Absolute path to a tab's transient agent shadow. The shadow mirrors the
 * user-facing file's relative position under AGENT_DIR so the agent's
 * `file_path` argument round-trips through parseTabIdFromAgentPath. */
export function tabAgentFile(tabId: string): string {
	return join(AGENT_DIR, tabId);
}

/** Ensure the directory containing a shadow file exists. */
export function ensureAgentDirFor(tabId: string) {
	mkdirSync(dirname(tabAgentFile(tabId)), { recursive: true });
}

/** Reverse of tabAgentFile: given a filesystem path inside AGENT_DIR,
 * return the tab id (everything after AGENT_DIR/), or null if the path
 * is outside AGENT_DIR or invalid. Used by the PreToolUse write-guard. */
export function parseTabIdFromAgentPath(path: string): string | null {
	if (!path.startsWith(AGENT_DIR + '/')) return null;
	const id = path.slice(AGENT_DIR.length + 1);
	return isValidTabId(id) ? id : null;
}

/** Ensure `.docwriter/` and `.docwriter/agent/` exist. Idempotent. */
export function ensureDocWriterDir() {
	if (!existsSync(DOCWRITER_DIR)) {
		mkdirSync(DOCWRITER_DIR, { recursive: true });
	}
	if (!existsSync(AGENT_DIR)) {
		mkdirSync(AGENT_DIR, { recursive: true });
	}
}

/** Ensure the agent's scratch dir exists. Called at render start so the
 * agent can immediately Write into it. Idempotent. */
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
