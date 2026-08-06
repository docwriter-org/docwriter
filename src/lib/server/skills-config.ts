import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'fs';
import { dirname, basename, isAbsolute, join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { parse as parseYaml } from 'yaml';
import { ensureDocWriterDir, getEffectiveDocwriterDir, getEffectiveRoot } from './document-files';
import { writeJsonAtomic } from './file-utils';
import hooksCreatorSkill from './skills/hooks-creator/SKILL.md?raw';
import plainWritingSkill from './skills/plain-writing/SKILL.md?raw';
import plainWritingTemplate from './skills/plain-writing/assets/revision_template.html?raw';

const hooksCreatorExamples = import.meta.glob(
	'./skills/hooks-creator/examples/*.json',
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const BUNDLED_MARKER = '.docwriter-bundled-skill';

function skillsFile(): string {
	return join(getEffectiveDocwriterDir(), 'skills.json');
}

function customSkillsDir(): string {
	return join(getEffectiveDocwriterDir(), 'skills');
}

function nativeSkillDirs(): string[] {
	const root = getEffectiveRoot();
	return [join(root, '.claude', 'skills'), join(root, '.agents', 'skills')];
}

function agentsSkillsDir(): string {
	return join(getEffectiveRoot(), '.agents', 'skills');
}

export interface SkillConfig {
	disabledBundled: string[];
	customSkills: CustomSkillConfig[];
}

export interface CustomSkillConfig {
	id: string;
	source: string;
	path: string;
	enabled?: boolean;
	addedAt: number;
}

export interface SkillSummary {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	origin: 'bundled' | 'custom';
	path: string;
	source?: string;
	missing?: boolean;
}

interface BundledSkill {
	id: string;
	source: string;
	files: Array<{ relativePath: string; content: string }>;
}

const BUNDLED_SKILLS: BundledSkill[] = [
	{
		id: 'hooks-creator',
		source: 'docwriter',
		files: [
			{ relativePath: 'SKILL.md', content: hooksCreatorSkill },
			...Object.entries(hooksCreatorExamples).map(([path, content]) => ({
				relativePath: join('examples', basename(path)),
				content
			}))
		]
	},
	{
		id: 'plain-writing',
		source: 'https://github.com/shreyashankar/plain-writing-skill',
		files: [
			{ relativePath: 'SKILL.md', content: plainWritingSkill },
			{ relativePath: join('assets', 'revision_template.html'), content: plainWritingTemplate }
		]
	}
];

const DEFAULT_CONFIG: SkillConfig = {
	disabledBundled: [],
	customSkills: []
};

function normalizeConfig(raw: unknown): SkillConfig {
	const obj = raw && typeof raw === 'object' ? raw as Partial<SkillConfig> : {};
	return {
		disabledBundled: Array.isArray(obj.disabledBundled)
			? obj.disabledBundled.filter((id): id is string => typeof id === 'string')
			: [],
		customSkills: Array.isArray(obj.customSkills)
			? obj.customSkills
					.filter((s): s is CustomSkillConfig =>
						!!s &&
						typeof s === 'object' &&
						typeof (s as CustomSkillConfig).id === 'string' &&
						typeof (s as CustomSkillConfig).path === 'string'
					)
					.map((s) => ({
						id: s.id,
						source: typeof s.source === 'string' ? s.source : s.path,
						path: s.path,
						enabled: s.enabled !== false,
						addedAt: typeof s.addedAt === 'number' ? s.addedAt : Date.now()
					}))
			: []
	};
}

export function readSkillsConfig(): SkillConfig {
	ensureDocWriterDir();
	const path = skillsFile();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG, customSkills: [] };
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, 'utf-8')));
	} catch {
		return { ...DEFAULT_CONFIG, customSkills: [] };
	}
}

function writeSkillsConfig(config: SkillConfig) {
	ensureDocWriterDir();
	writeJsonAtomic(skillsFile(), normalizeConfig(config));
}

function stripFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { frontmatter: {}, body: raw };
	try {
		return {
			frontmatter: (parseYaml(match[1]) ?? {}) as Record<string, unknown>,
			body: raw.slice(match[0].length)
		};
	} catch {
		return { frontmatter: {}, body: raw.slice(match[0].length) };
	}
}

function firstParagraph(body: string): string {
	return body
		.split(/\n\s*\n/)
		.map((p) => p.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim())
		.find(Boolean) ?? '';
}

function parseSkillMetadata(skillPath: string, fallbackName: string): { name: string; description: string; body: string } {
	const raw = readFileSync(skillPath, 'utf-8');
	const { frontmatter, body } = stripFrontmatter(raw);
	const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
		? frontmatter.name.trim()
		: fallbackName;
	const description = typeof frontmatter.description === 'string' && frontmatter.description.trim()
		? frontmatter.description.trim().replace(/\s+/g, ' ')
		: firstParagraph(body);
	return { name, description, body: body.trim() };
}

function parseBundledMetadata(skill: BundledSkill) {
	const file = skill.files.find((f) => f.relativePath === 'SKILL.md');
	if (!file) return { name: skill.id, description: '', body: '' };
	const { frontmatter, body } = stripFrontmatter(file.content);
	return {
		name: typeof frontmatter.name === 'string' ? frontmatter.name : skill.id,
		description:
			typeof frontmatter.description === 'string'
				? frontmatter.description.trim().replace(/\s+/g, ' ')
				: firstParagraph(body),
		body: body.trim()
	};
}

function writeBundledSkill(targetDir: string, skill: BundledSkill) {
	rmSync(targetDir, { recursive: true, force: true });
	for (const file of skill.files) {
		const target = join(targetDir, file.relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileAtomicText(target, file.content);
	}
	writeFileAtomicText(join(targetDir, BUNDLED_MARKER), skill.id);
}

function writeFileAtomicText(path: string, text: string) {
	const tempPath = `${path}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tempPath, text, 'utf-8');
	renameSync(tempPath, path);
}

function copySkillDir(sourceDir: string, targetDir: string) {
	rmSync(targetDir, { recursive: true, force: true });
	cpSync(sourceDir, targetDir, {
		recursive: true,
		filter: (src) => !src.split('/').includes('.git')
	});
}

export function syncSkillInstallations(config = readSkillsConfig()) {
	for (const nativeDir of nativeSkillDirs()) {
		mkdirSync(nativeDir, { recursive: true });

		for (const bundled of BUNDLED_SKILLS) {
			const target = join(nativeDir, bundled.id);
			if (config.disabledBundled.includes(bundled.id)) {
				rmSync(target, { recursive: true, force: true });
			} else {
				writeBundledSkill(target, bundled);
			}
		}

		for (const custom of config.customSkills) {
			const target = join(nativeDir, custom.id);
			if (custom.enabled === false || !existsSync(join(custom.path, 'SKILL.md'))) {
				rmSync(target, { recursive: true, force: true });
			} else {
				copySkillDir(custom.path, target);
			}
		}
	}
}

export function listSkills(): { skills: SkillSummary[]; nativeDirs: string[] } {
	const config = readSkillsConfig();
	const dirs = nativeSkillDirs();
	const disabled = new Set(config.disabledBundled);
	const skills: SkillSummary[] = BUNDLED_SKILLS.map((skill) => {
		const meta = parseBundledMetadata(skill);
		return {
			id: skill.id,
			name: meta.name,
			description: meta.description,
			enabled: !disabled.has(skill.id),
			origin: 'bundled' as const,
			path: join(dirs[0], skill.id),
			source: skill.source
		};
	});

	for (const custom of config.customSkills) {
		const skillPath = join(custom.path, 'SKILL.md');
		if (!existsSync(skillPath)) {
			skills.push({
				id: custom.id,
				name: custom.id,
				description: 'Missing SKILL.md',
				enabled: false,
				origin: 'custom',
				path: custom.path,
				source: custom.source,
				missing: true
			});
			continue;
		}
		const meta = parseSkillMetadata(skillPath, custom.id);
		skills.push({
			id: custom.id,
			name: meta.name,
			description: meta.description,
			enabled: custom.enabled !== false,
			origin: 'custom',
			path: custom.path,
			source: custom.source
		});
	}

	return { skills, nativeDirs: dirs };
}

export function setSkillEnabled(id: string, enabled: boolean): SkillConfig {
	const config = readSkillsConfig();
	if (BUNDLED_SKILLS.some((s) => s.id === id)) {
		const disabled = new Set(config.disabledBundled);
		if (enabled) disabled.delete(id);
		else disabled.add(id);
		config.disabledBundled = [...disabled];
	} else {
		config.customSkills = config.customSkills.map((s) =>
			s.id === id ? { ...s, enabled } : s
		);
	}
	writeSkillsConfig(config);
	syncSkillInstallations(config);
	return config;
}

export function removeCustomSkill(id: string): SkillConfig {
	const config = readSkillsConfig();
	const removed = config.customSkills.find((s) => s.id === id);
	config.customSkills = config.customSkills.filter((s) => s.id !== id);
	writeSkillsConfig(config);
	if (removed?.path.startsWith(customSkillsDir())) {
		rmSync(removed.path, { recursive: true, force: true });
	}
	for (const nativeDir of nativeSkillDirs()) {
		rmSync(join(nativeDir, id), { recursive: true, force: true });
	}
	syncSkillInstallations(config);
	return config;
}

/** Register or refresh a DocWriter-managed skill without cloning/copying sources. */
export function upsertManagedSkill(opts: {
	id: string;
	path: string;
	source: string;
	enabled?: boolean;
}): SkillConfig {
	const config = readSkillsConfig();
	const existing = config.customSkills.find((s) => s.id === opts.id);
	const foreign =
		existing && existing.source && !existing.source.startsWith('docwriter:');
	if (foreign) {
		throw new Error(
			`Skill id "${opts.id}" is already used by a user-installed skill; refusing to overwrite.`
		);
	}
	const entry: CustomSkillConfig = {
		id: opts.id,
		source: opts.source,
		path: opts.path,
		enabled: opts.enabled !== false,
		addedAt: existing?.addedAt ?? Date.now()
	};
	config.customSkills = [
		...config.customSkills.filter((s) => s.id !== opts.id),
		entry
	];
	writeSkillsConfig(config);
	syncSkillInstallations(config);
	return config;
}

function expandHome(path: string): string {
	return path === '~' || path.startsWith('~/')
		? join(homedir(), path.slice(2))
		: path;
}

function isGitHubSource(source: string): boolean {
	return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?\/?$/.test(source.trim());
}

function sanitizeSkillId(value: string): string {
	const id = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
	return id || 'skill';
}

function uniqueSkillId(base: string, config: SkillConfig): string {
	const used = new Set([
		...BUNDLED_SKILLS.map((s) => s.id),
		...config.customSkills.map((s) => s.id)
	]);
	let id = sanitizeSkillId(base);
	let i = 2;
	while (used.has(id)) {
		id = `${sanitizeSkillId(base)}-${i}`;
		i += 1;
	}
	return id;
}

function resolveLocalSource(source: string): string {
	const expanded = expandHome(source.trim());
	return isAbsolute(expanded) ? expanded : resolve(getEffectiveRoot(), expanded);
}

function cloneGitHubSkill(source: string): string {
	const tmp = mkdtempSync(join(tmpdir(), 'docwriter-skill-'));
	const target = join(tmp, 'repo');
	execFileSync('git', ['clone', '--depth=1', source, target], { stdio: 'ignore' });
	return target;
}

function resolveSkillRoot(source: string): string {
	if (isGitHubSource(source)) return cloneGitHubSkill(source.trim());
	const local = resolveLocalSource(source);
	if (!existsSync(local)) throw new Error(`${source} does not exist.`);
	const stat = statSync(local);
	if (stat.isFile() && basename(local) === 'SKILL.md') return dirname(local);
	if (stat.isDirectory()) return local;
	throw new Error(`${source} is not a skill directory or SKILL.md file.`);
}

export function addCustomSkill(source: string): SkillConfig {
	const trimmed = source.trim();
	if (!trimmed) throw new Error('Skill source is required.');
	const config = readSkillsConfig();
	const sourceDir = resolveSkillRoot(trimmed);
	const skillPath = join(sourceDir, 'SKILL.md');
	if (!existsSync(skillPath)) {
		throw new Error('Skill source must contain a SKILL.md file at its root.');
	}
	const meta = parseSkillMetadata(skillPath, basename(sourceDir));
	const id = uniqueSkillId(meta.name || basename(sourceDir), config);
	const targetDir = customSkillsDir();
	const target = join(targetDir, id);
	mkdirSync(targetDir, { recursive: true });
	copySkillDir(sourceDir, target);
	config.customSkills = [
		...config.customSkills,
		{ id, source: trimmed, path: target, enabled: true, addedAt: Date.now() }
	];
	writeSkillsConfig(config);
	syncSkillInstallations(config);
	return config;
}

export function readEnabledSkill(nameOrId: string): { name: string; path: string; content: string } | null {
	const needle = nameOrId.trim().toLowerCase();
	if (!needle) return null;
	for (const skill of listSkills().skills) {
		if (!skill.enabled || skill.missing) continue;
		const names = [skill.id, skill.name].map((s) => s.toLowerCase());
		if (!names.includes(needle)) continue;
		if (skill.origin === 'bundled') {
			const bundled = BUNDLED_SKILLS.find((s) => s.id === skill.id);
			const file = bundled?.files.find((f) => f.relativePath === 'SKILL.md');
			if (!file) return null;
			return {
				name: skill.name,
				path: join(agentsSkillsDir(), skill.id, 'SKILL.md'),
				content: file.content
			};
		}
		const skillPath = join(skill.path, 'SKILL.md');
		if (!existsSync(skillPath)) continue;
		return { name: skill.name, path: skillPath, content: readFileSync(skillPath, 'utf-8') };
	}
	return null;
}

export function buildSkillsPromptBlock(): string | null {
	const enabled = listSkills().skills.filter((s) => s.enabled && !s.missing);
	if (enabled.length === 0) return null;
	return [
		'## Available skills',
		'',
		'Use these reusable skill instructions when they match the task. For OpenAI or Cursor provider runs, call `read_skill` with the skill name before following the full instructions.',
		'If the user message is exactly or primarily `/<skill-name>` (for example `/plain-writing`), call `read_skill` for that skill and apply it to the current document/task.',
		'',
		...enabled.map((skill) => `- ${skill.name}: ${skill.description}`)
	].join('\n');
}
