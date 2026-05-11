/**
 * GET /api/hooks/preview-match?file=...
 *
 * Given an active tab path, return the output file path of the first
 * enabled hook whose `output` template (with `{{file}}` substituted)
 * resolves to a sensible path. Used by the editor's preview button to
 * decide what to show when the user clicks it.
 *
 * Returns `{ outputPath: string | null }`. Null means "no matching
 * preview hook configured" — the button stays disabled.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolve as resolvePath } from 'node:path';
import { readHooks, resolveCommand } from '$lib/server/hooks-config';
import { WORKSPACE_ROOT } from '$lib/server/document-files';

export const GET: RequestHandler = async ({ url }) => {
	const file = url.searchParams.get('file') ?? '';
	const hooks = readHooks().hooks.filter((h) => h.enabled !== false && h.output);
	for (const hook of hooks) {
		// Substitute {{file}} into output; if the result is non-empty,
		// resolve against the workspace root and return.
		const resolved = resolveCommand(hook.output ?? '', { file, tool: '' });
		if (!resolved) continue;
		const abs = resolvePath(WORKSPACE_ROOT, resolved);
		return json({ outputPath: abs });
	}
	return json({ outputPath: null });
};
