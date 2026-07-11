import { join, resolve, sep } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getActiveUserId } from './request-context';
import { getUserWorkspace, type UserWorkspace } from './workspace';

// DocWriter persistence layout:
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
//     provider-cache/<provider>/      ← provider-native cache/state that
//                                       must stay outside user-facing files.
//
// Agent edits to tab files go through `mcp-doc-tools.ts`, which mutates
// the live Hocuspocus Y.Doc and syncs to the browser via WebSocket.

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();

export const WORKSPACE_ROOT = ROOT;

export const DOCWRITER_DIR = join(ROOT, '.docwriter');
export const AGENT_SCRATCH_DIR = join(DOCWRITER_DIR, 'agent', 'scratch');

function getEffectiveWorkspace(): UserWorkspace | null {
	const userId = getActiveUserId();
	return userId ? getUserWorkspace(userId) : null;
}

export function getEffectiveRoot(): string {
	return getEffectiveWorkspace()?.root ?? ROOT;
}

export function getEffectiveDocwriterDir(): string {
	return getEffectiveWorkspace()?.docwriterDir ?? DOCWRITER_DIR;
}

export function getEffectiveScratchDir(): string {
	return getEffectiveWorkspace()?.agentScratchDir ?? AGENT_SCRATCH_DIR;
}

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

/** Absolute path to a tab's user-facing file. Context-aware in multi-tenant
 * mode. Rejects ids that fail isValidTabId or resolve outside the workspace
 * root (separator-aware — a bare prefix match would admit sibling
 * workspaces like `<root>2`). */
export function tabFile(tabId: string): string {
	if (!isValidTabId(tabId)) {
		throw new Error(`Invalid tab id: ${tabId}`);
	}
	const root = getEffectiveRoot();
	const resolved = resolve(root, tabId);
	if (resolved !== root && !resolved.startsWith(root + sep)) {
		throw new Error(`Path traversal blocked: ${tabId}`);
	}
	return resolved;
}

/** Ensure `.docwriter/` exists. Context-aware. Idempotent. */
export function ensureDocWriterDir() {
	const dir = getEffectiveDocwriterDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Ensure the agent's scratch dir exists. Context-aware. Idempotent. */
export function ensureAgentScratchDir() {
	ensureDocWriterDir();
	const dir = getEffectiveScratchDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/** True iff `path` is the scratch dir itself or somewhere inside it. */
export function isAgentScratchPath(path: string): boolean {
	const dir = getEffectiveScratchDir();
	return path === dir || path.startsWith(dir + '/');
}
