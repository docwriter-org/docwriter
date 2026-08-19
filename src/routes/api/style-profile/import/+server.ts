import { error, json } from '@sveltejs/kit';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { RequestHandler } from './$types';
import {
	profileFromSkillFolder,
	resolveSkillFolder,
	SkillImportError
} from '$lib/server/style-analysis/import-skill';
import { styleProfileForClient, writeStyleProfile } from '$lib/server/style-analysis/profile-store';
import { installSkillFolder, skillFolderVersion } from '$lib/server/style-analysis/skill-compiler';
import { skillVersionDir } from '$lib/server/style-analysis/skill-versions';
import { WORKSPACE_ROOT } from '$lib/server/document-files';
import { replacePublishedStylePropositions } from '$lib/server/style-analysis/proposition-store';

/**
 * Restore an author-style skill instead of running the pass: either a version
 * from this workspace's history, a folder / zip from Download skill, or a
 * .zip file uploaded via multipart form data.
 */
export const POST: RequestHandler = async ({ request }) => {
	const contentType = request.headers.get('content-type') ?? '';

	let version: number | null = null;
	let path = '';

	if (contentType.includes('multipart/form-data')) {
		const formData = await request.formData();
		const file = formData.get('file');
		if (!file || !(file instanceof File)) {
			throw error(400, 'No file provided');
		}
		if (!file.name.toLowerCase().endsWith('.zip')) {
			throw error(400, 'Only .zip skill files are accepted');
		}
		const uploadDir = mkdtempSync(join(tmpdir(), 'docwriter-upload-'));
		const uploadPath = join(uploadDir, file.name);
		const buffer = Buffer.from(await file.arrayBuffer());
		writeFileSync(uploadPath, buffer);
		path = uploadPath;
	} else {
		const body = await request.json().catch(() => ({}));
		version = typeof body.version === 'number' ? body.version : null;
		path = typeof body.path === 'string' ? body.path.trim() : '';
	}

	if (version === null && !path) {
		throw error(400, 'Give a version number, a path, or upload a .zip file');
	}

	let sourceDir: string;
	let fromHistory = false;
	try {
		if (version !== null) {
			const dir = skillVersionDir(version);
			if (!dir) throw new SkillImportError(`No saved version ${version}`);
			sourceDir = dir;
			fromHistory = true;
		} else {
			// Absolute paths are taken as given, since the bundle a writer wants
			// to restore is usually a download outside the workspace. Relative
			// paths resolve against the workspace, which is what a typed path
			// means here.
			sourceDir = resolveSkillFolder(isAbsolute(path) ? path : resolve(WORKSPACE_ROOT, path));
		}

		// Parse before installing: a bundle that cannot produce a profile is not
		// one we want on disk.
		const profile = profileFromSkillFolder(sourceDir);
		const installed = installSkillFolder(sourceDir, { snapshot: !fromHistory });
		profile.skillId = installed.skillId;
		profile.skillPath = installed.skillPath;
		profile.publishedAt = Date.now();
		profile.publishedAnalyzerVersion = profile.analyzerVersion;
		profile.publishedSourceSnapshotHash = profile.sourceSnapshotHash;
		profile.publishedPropositions = structuredClone(profile.propositions);
		const written = writeStyleProfile(profile);
		replacePublishedStylePropositions(
			written.lastRun?.id ?? 'profile',
			written.publishedPropositions ?? []
		);
		return json({
			profile: styleProfileForClient(written),
			imported: written.propositions.length,
			skillVersion: skillFolderVersion(installed.skillPath)
		});
	} catch (cause) {
		if (cause instanceof SkillImportError) throw error(400, cause.message);
		throw error(400, cause instanceof Error ? cause.message : 'Could not restore that skill');
	}
};
