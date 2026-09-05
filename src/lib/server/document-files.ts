import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

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
//
// Agent edits to tab files go through `mcp-doc-tools.ts`, which mutates
// the live Hocuspocus Y.Doc and syncs to the browser via WebSocket.

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();

export const WORKSPACE_ROOT = ROOT;

export const DOCWRITER_DIR = join(ROOT, '.docwriter');
/** Scratch workspace the agent can freely Write/Edit without user review.
 * Meant for its own drafts, outlines, intermediate notes-to-self. Not
 * surfaced as tabs; survives across rounds in the same session; cleared
 * when the user starts a new session. Created lazily — no `.docwriter/agent/`
 * directory is created unless the agent actually writes a scratch file. */
export const AGENT_SCRATCH_DIR = join(DOCWRITER_DIR, 'agent', 'scratch');

export function getEffectiveRoot(): string {
	return ROOT;
}

export function getEffectiveDocwriterDir(): string {
	return DOCWRITER_DIR;
}

export function getEffectiveScratchDir(): string {
	return AGENT_SCRATCH_DIR;
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

/** Extensions that are definitely NOT editable text documents. Everything
 * else is treated as text: any file can be an open tab (LaTeX, Typst,
 * bib files, extensionless notes…), so the binary gate is a DENYLIST —
 * misclassifying a text file as binary would break editing it entirely,
 * while the reverse merely risks the old seed-bytes-into-the-CRDT bug for
 * genuinely binary formats. */
const BINARY_EXTENSIONS = new Set([
	'pdf',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'ico',
	'bmp',
	'tif',
	'tiff',
	'heic',
	'mp3',
	'wav',
	'ogg',
	'mp4',
	'mov',
	'avi',
	'mkv',
	'zip',
	'gz',
	'tgz',
	'bz2',
	'xz',
	'tar',
	'7z',
	'rar',
	'docx',
	'xlsx',
	'pptx',
	'odt',
	'ods',
	'odp',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'eot',
	'bin',
	'exe',
	'dll',
	'dylib',
	'so',
	'wasm',
	'sqlite',
	'db',
	'pyc',
	'class',
	'jar',
	'dmg',
	'iso'
]);

/** True for tabs that have no editable text document (PDFs, images, media,
 * archives). These are preview-only: never seeded into the CRDT log, never
 * diffed into the prompt, rejected by the doc tools. */
export function isBinaryTabPath(tabId: string): boolean {
	const ext = extensionOf(tabId);
	return ext !== null && BINARY_EXTENSIONS.has(ext);
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

/** Write `.docwriter/workspace.json` naming the workspace this state dir
 * belongs to. A `.docwriter` found on disk is otherwise anonymous — when a
 * stale one lingers in some other directory (state follows the workspace
 * argument, not the shell's cwd), whoever inspects it can now see which
 * workspace it served and when it was last opened. Warns when the stamped
 * root differs from the current one (the folder was moved or copied).
 * Best-effort; called once per server boot. */
export function stampWorkspaceDir() {
	try {
		ensureDocWriterDir();
		const stampPath = join(DOCWRITER_DIR, 'workspace.json');
		let prior: { workspaceRoot?: string } | null = null;
		try {
			prior = JSON.parse(readFileSync(stampPath, 'utf-8')) as { workspaceRoot?: string };
		} catch {
			// No stamp yet, or unreadable — either way we rewrite it below.
		}
		if (prior?.workspaceRoot && prior.workspaceRoot !== ROOT) {
			console.warn(
				`[docwriter] this .docwriter was last opened as workspace ${prior.workspaceRoot}; now opening as ${ROOT} (folder moved or copied?)`
			);
		}
		writeFileSync(
			stampPath,
			JSON.stringify({ workspaceRoot: ROOT, lastOpenedAt: new Date().toISOString() }, null, 2)
		);
	} catch (err) {
		console.error('[docwriter] workspace stamp failed:', err);
	}
}

/** True iff `path` is the scratch dir itself or somewhere inside it. */
export function isAgentScratchPath(path: string): boolean {
	return path === AGENT_SCRATCH_DIR || path.startsWith(AGENT_SCRATCH_DIR + '/');
}
