/**
 * Live workspace identity for this process. Uses DOCWRITER_ROOT / cwd the
 * same way document-files.ts does, plus a cwd-conflict check so the UI
 * can explain a "empty SQLite" mix-up.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	describeWorkspace,
	findConflictingStateDir,
	formatConflictWarning,
	type WorkspaceConflict,
	type WorkspaceIdentity
} from '$lib/shared/workspace-identity';
import { WORKSPACE_ROOT } from './document-files';

export interface WorkspaceInfo extends WorkspaceIdentity {
	cwd: string;
	conflict: WorkspaceConflict | null;
	warning: string | null;
}

export function getWorkspaceInfo(): WorkspaceInfo {
	const identity = describeWorkspace(WORKSPACE_ROOT);
	// The HTTP server's process.cwd() is the install / package root. The
	// CLI forwards the directory the user invoked from so this warning
	// matches the folder they are looking at in the terminal.
	const cwd = resolve(process.env.DOCWRITER_INVOKE_CWD || process.cwd());
	const conflict = findConflictingStateDir({
		root: identity.root,
		cwd,
		cwdHasState: existsSync(describeWorkspace(cwd).stateDir)
	});
	return {
		...identity,
		cwd,
		conflict,
		warning: conflict ? formatConflictWarning(identity, conflict) : null
	};
}
