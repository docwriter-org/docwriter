import { error } from '@sveltejs/kit';
import AdmZip from 'adm-zip';
import { existsSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { authorSkillFileName, isAuthorStyleSkillPath } from '$lib/server/style-analysis/skill-compiler';
import { readStyleProfile } from '$lib/server/style-analysis/profile-store';

export const GET: RequestHandler = async () => {
	const skillDir = readStyleProfile()?.skillPath;
	if (!skillDir || !isAuthorStyleSkillPath(skillDir) || !existsSync(skillDir)) throw error(404, 'Author style skill has not been compiled');
	const zip = new AdmZip();
	zip.addLocalFolder(skillDir, 'author-style');
	return new Response(new Uint8Array(zip.toBuffer()), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${authorSkillFileName(skillDir)}"`,
			'cache-control': 'no-store'
		}
	});
};
