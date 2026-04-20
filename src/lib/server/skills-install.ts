/**
 * Install DocWriter's built-in project skills into the workspace's
 * `.claude/skills/` directory. The Claude Agent SDK auto-discovers skills
 * there when settingSources includes 'project', so we drop the files and the
 * agent learns about them on the next render.
 *
 * Skill files are imported as raw strings via Vite's `?raw` (and `?raw`
 * through `import.meta.glob` for the examples folder) so they live as real
 * markdown/JSON in the repo — editable, grep-able, reviewable — AND get
 * bundled into the server build.
 *
 * We always overwrite built-in skill files: they are ours, shipped with the
 * package. User-owned writing samples live separately under
 * `.docwriter/references/`, not in `.claude/skills/`.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import hooksCreatorSkill from './skills/hooks-creator/SKILL.md?raw';

const hooksCreatorExamples = import.meta.glob(
	'./skills/hooks-creator/examples/*.json',
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const ROOT = process.env.DOCWRITER_ROOT || process.cwd();
const SKILLS_DIR = join(ROOT, '.claude', 'skills');

interface BundledSkill {
	dir: string;
	files: Array<{ relativePath: string; content: string }>;
}

const SKILLS: BundledSkill[] = [
	{
		dir: join(SKILLS_DIR, 'hooks-creator'),
		files: [
			{ relativePath: 'SKILL.md', content: hooksCreatorSkill },
			...Object.entries(hooksCreatorExamples).map(([path, content]) => ({
				relativePath: join('examples', basename(path)),
				content
			}))
		]
	}
];

export function installBundledSkills() {
	for (const skill of SKILLS) {
		for (const f of skill.files) {
			try {
				const p = join(skill.dir, f.relativePath);
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, f.content, 'utf-8');
			} catch (e) {
				console.warn('[skills-install] Failed to install', f.relativePath, e);
			}
		}
	}
}
