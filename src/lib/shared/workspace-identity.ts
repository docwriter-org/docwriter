/**
 * Workspace root vs. DocWriter state directory.
 *
 * `docwriter ~/writing/book` (or `--root`) opens that folder as the
 * workspace. SQLite, comments, and pending reviews live in
 * `<workspace>/.docwriter`, not in the directory you invoked the command
 * from. Looking at the wrong `.docwriter` looks like an empty database.
 */

export interface WorkspaceIdentity {
	/** Absolute workspace root. */
	root: string;
	/** Absolute `.docwriter` directory for this workspace. */
	stateDir: string;
	/** Last path segment, for compact UI labels. */
	name: string;
}

export interface WorkspaceConflict {
	cwd: string;
	cwdStateDir: string;
}

export interface ResolveWorkspaceRootInput {
	rootArg?: string | null;
	envRoot?: string | null;
	cwd: string;
}

/** Same precedence as `bin/docwriter.js`: positional/`--root`, then
 * `DOCWRITER_ROOT`, then cwd. */
export function resolveWorkspaceRoot(input: ResolveWorkspaceRootInput): string {
	const raw = (input.rootArg && input.rootArg.trim()) || (input.envRoot && input.envRoot.trim()) || input.cwd;
	return resolveAgainst(input.cwd, raw);
}

export function describeWorkspace(root: string): WorkspaceIdentity {
	const normalized = normalizePath(root);
	return {
		root: normalized,
		stateDir: joinPath(normalized, '.docwriter'),
		name: lastSegment(normalized) || normalized
	};
}

/** When the process cwd is a different folder that also has `.docwriter`,
 * inspecting cwd looks like the live state is missing. */
export function findConflictingStateDir(input: {
	root: string;
	cwd: string;
	cwdHasState: boolean;
}): WorkspaceConflict | null {
	const root = normalizePath(input.root);
	const cwd = normalizePath(input.cwd);
	if (root === cwd) return null;
	if (!input.cwdHasState) return null;
	return {
		cwd,
		cwdStateDir: joinPath(cwd, '.docwriter')
	};
}

export function formatConflictWarning(
	identity: WorkspaceIdentity,
	conflict: WorkspaceConflict
): string {
	return [
		`cwd has a separate .docwriter at ${conflict.cwdStateDir}.`,
		`This process uses ${identity.stateDir} (the folder you opened).`,
		'Inspecting the wrong folder looks like an empty database.'
	].join(' ');
}

export function formatStartupWarningLines(
	identity: WorkspaceIdentity,
	conflict: WorkspaceConflict
): string[] {
	return [
		`cwd has a separate .docwriter at ${conflict.cwdStateDir}`,
		`This process uses ${identity.stateDir} (the folder you opened).`,
		'Inspecting the wrong folder looks like an empty database.'
	];
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/** `path.resolve` for the cases we care about: an absolute target wins;
 * a relative target is joined onto the base. */
function resolveAgainst(base: string, target: string): string {
	if (isAbsolutePath(target)) return normalizePath(target);
	return joinPath(base, target);
}

function joinPath(base: string, ...parts: string[]): string {
	const raw = [base, ...parts].join('/');
	return normalizePath(raw);
}

function lastSegment(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? '';
}

/** POSIX-style normalize that also collapses `a/../b` and treats a
 * relative second argument as relative to the first (when the second is
 * not absolute). */
function normalizePath(path: string): string {
	const windowsAbs = /^[A-Za-z]:[\\/]/.test(path);
	const posixAbs = path.startsWith('/');
	const sep = windowsAbs || path.includes('\\') ? '\\' : '/';
	const split = path.replace(/\\/g, '/').split('/');
	const out: string[] = [];
	for (const part of split) {
		if (part === '' || part === '.') {
			if (part === '' && out.length === 0) out.push('');
			continue;
		}
		if (part === '..') {
			if (out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') {
				out.pop();
				continue;
			}
			if (posixAbs || windowsAbs) continue;
		}
		out.push(part);
	}
	let joined = out.join('/');
	if (windowsAbs) {
		joined = joined.replace(/\//g, '\\');
		if (!/^[A-Za-z]:\\/.test(joined) && /^[A-Za-z]:$/.test(out[0] ?? '')) {
			joined = `${out[0]}\\`;
		}
	} else if (posixAbs && !joined.startsWith('/')) {
		joined = '/' + joined;
	}
	if (joined.length > 1 && joined.endsWith(sep)) joined = joined.slice(0, -1);
	return joined || (posixAbs ? '/' : '.');
}
