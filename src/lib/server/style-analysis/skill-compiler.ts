import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SourceSpan, StyleAnalysisReport, StyleProfile, StyleProposition } from '$lib/style-profile';
import { isActiveProposition } from '$lib/style-profile';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { readSkillsConfig, upsertManagedSkill } from '$lib/server/skills-config';
import { writeJsonAtomic, writeTextAtomic } from '$lib/server/file-utils';
import { isSelected, listStyleReferences, REFERENCES_CACHE_DIR } from '$lib/server/references';
import { skillVersionFor, snapshotSkillVersion } from './skill-versions';
import { normalizeForMatch } from './profile-store';
import analyzerScript from './analyze-style.mjs?raw';
import styleMetricsScript from './style-metrics.mjs?raw';
import styleMetricRegistryScript from './style-metric-registry.mjs?raw';
import styleData from './style-data.json?raw';

export const AUTHOR_STYLE_SKILL_DIR = join(DOCWRITER_DIR, 'skills', 'author-style');
const MANAGED_BY = 'docwriter-style-profile';

export function isAuthorStyleSkillPath(path: string): boolean {
	const parent = resolve(dirname(AUTHOR_STYLE_SKILL_DIR));
	const candidate = resolve(path);
	const child = relative(parent, candidate);
	return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

function resolveAuthorStyleTarget(): { id: string; path: string } {
	const config = readSkillsConfig();
	const managed = config.customSkills.find((skill) => skill.managedBy === MANAGED_BY);
	if (managed && isAuthorStyleSkillPath(managed.path)) return { id: managed.id, path: managed.path };

	const preferredIsClaimed = config.customSkills.some((skill) =>
		skill.id === 'author-style' || skill.path === AUTHOR_STYLE_SKILL_DIR
	);
	if (!preferredIsClaimed && !existsSync(AUTHOR_STYLE_SKILL_DIR)) return { id: 'author-style', path: AUTHOR_STYLE_SKILL_DIR };

	const parent = dirname(AUTHOR_STYLE_SKILL_DIR);
	let candidateId = 'docwriter-author-style';
	let candidate = join(parent, candidateId);
	let suffix = 2;
	while (existsSync(candidate) || config.customSkills.some((skill) => skill.path === candidate || skill.id === candidateId)) {
		candidateId = `docwriter-author-style-${suffix}`;
		candidate = join(parent, candidateId);
		suffix += 1;
	}
	return { id: candidateId, path: candidate };
}

export function resolveAuthorStyleSkillDir(): string {
	return resolveAuthorStyleTarget().path;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function activePropositions(profile: StyleProfile): StyleProposition[] {
	return profile.propositions.filter(isActiveProposition);
}

/** The author's selected sources as one blob, for widening quoted examples. */
function sourceCorpus(): string {
	const texts: string[] = [];
	for (const reference of listStyleReferences().filter(isSelected)) {
		const path = join(REFERENCES_CACHE_DIR, `${reference.id}.txt`);
		if (!existsSync(path)) continue;
		try {
			texts.push(readFileSync(path, 'utf8'));
		} catch {
			// A missing source just means no extra context for its examples.
		}
	}
	return texts.join('\n\n');
}

function splitSentences(text: string): string[] {
	return text
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s+(?=[A-Z"'“‘(])/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

const MAX_EXAMPLE_CHARS = 700;

/**
 * Render one example: the passage, with the sentence the instruction is about
 * in bold.
 *
 * The specialist quotes a passage and names its focus sentence, because it
 * knows which one it meant. This only falls back to widening and guessing for
 * profiles written before that existed, where all we have is a lone sentence.
 */
function renderExample(
	example: string,
	focus: string | undefined,
	sentenceIndex: () => { sentences: string[]; normalized: string[] }
): string {
	const flat = example.replace(/\s+/g, ' ').trim();
	if (focus) {
		const target = focus.replace(/\s+/g, ' ').trim();
		const at = flat.toLowerCase().indexOf(target.toLowerCase());
		if (at >= 0) {
			return `${flat.slice(0, at)}**${flat.slice(at, at + target.length)}**${flat.slice(at + target.length)}`;
		}
	}
	const { sentences, normalized } = sentenceIndex();
	return widenExample(flat, sentences, normalized);
}

/**
 * Older profiles stored a lone sentence per example, so the surrounding
 * sentences are recovered from the sources and the quoted part is bolded.
 */
function widenExample(example: string, sentences: string[], normalized: string[]): string {
	const flat = example.replace(/\s+/g, ' ').trim();
	const needle = normalizeForMatch(flat);
	if (!needle) return flat;

	let start = normalized.findIndex((sentence) => sentence.includes(needle) || needle.includes(sentence));
	if (start < 0) return flat;
	// An example spanning several sentences ends at the last one it covers.
	let end = start;
	while (end + 1 < normalized.length && needle.includes(normalized[end + 1])) end += 1;

	const highlighted = `**${sentences.slice(start, end + 1).join(' ')}**`;
	const before = start > 0 ? sentences[start - 1] : '';
	const after = sentences.slice(end + 1, end + 3);

	const parts = [before, highlighted, ...after].filter(Boolean);
	let out = parts.join(' ');
	// Trim from the tail first: the lead-in is what gives the bold its meaning.
	while (out.length > MAX_EXAMPLE_CHARS && after.length > 0) {
		after.pop();
		out = [before, highlighted, ...after].filter(Boolean).join(' ');
	}
	return out;
}

/**
 * The sentence index behind widenExample, built at most once per compile and
 * only if something actually needs it. Reading every source off disk and
 * splitting the whole corpus costs tens of milliseconds, and it is wasted
 * entirely unless a proposition predates `focus`.
 */
function makeSentenceIndex(): () => { sentences: string[]; normalized: string[] } {
	let cached: { sentences: string[]; normalized: string[] } | null = null;
	return () => {
		if (!cached) {
			const sentences = splitSentences(sourceCorpus());
			cached = { sentences, normalized: sentences.map(normalizeForMatch) };
		}
		return cached;
	};
}

function profileMarkdown(profile: StyleProfile, sentenceIndex = makeSentenceIndex()): string {
	const propositions = activePropositions(profile);
	if (!propositions.length) return '# Learned style profile\n\nNo style propositions are active yet.\n';
	const groups = new Map<string, StyleProposition[]>();
	for (const proposition of propositions) {
		groups.set(proposition.family, [...(groups.get(proposition.family) ?? []), proposition]);
	}
	const lines = ['# Learned style profile', ''];
	for (const [family, items] of groups) {
		lines.push(`## ${family.replace(/-/g, ' ')}`, '');
		for (const item of items) {
			lines.push(`* ${item.instruction}`, '');
			// Examples do more work than the instruction — the agent imitates what
			// it can see, so quote several, and quote the longest ones.
			const ranked = item.examples
				.map((example, index) => ({ example, focus: item.focus?.[index] }))
				.sort((a, b) => b.example.length - a.example.length)
				.slice(0, 3);
			for (const { example, focus } of ranked) {
				lines.push(`  > ${renderExample(example, focus, sentenceIndex)}`, '');
			}
		}
	}
	return `${lines.join('\n').trim()}\n`;
}

function conventionsMarkdown(report: StyleAnalysisReport): string {
	const conventions = report.conventions.filter((item) => item.sourceCount > 0);
	if (!conventions.length) return '';
	const lines = [
		'## Document conventions',
		'',
		'These describe layout and venue habits rather than the author’s prose voice. Match them when the current document uses the same kind of format.',
		''
	];
	for (const item of conventions) {
		const value = Number.isInteger(item.value) ? String(item.value) : item.value.toFixed(2).replace(/\.00$/, '');
		lines.push(`* ${item.label}: ${value}`, '');
	}
	return `${lines.join('\n').trim()}\n`;
}

function examplesMarkdown(profile: StyleProfile, sentenceIndex = makeSentenceIndex()): string {
	const lines = [
		'# Grounded examples',
		'',
		'Passages from the author, with the sentence the instruction is about in bold.',
		''
	];
	for (const proposition of activePropositions(profile)) {
		if (!proposition.examples.length) continue;
		lines.push(`## ${proposition.statement}`, '');
		proposition.examples.forEach((example, index) => {
			lines.push(`> ${renderExample(example, proposition.focus?.[index], sentenceIndex)}`, '');
		});
	}
	return `${lines.join('\n').trim()}\n`;
}

function skillMarkdown(skillName: string, profileBody: string, skillVersion: number): string {
	return `---
name: ${skillName}
description: Apply the writing style learned from this workspace's references. Use when drafting or revising prose for this workspace unless the user requests a different style. Do not use reference facts or claims as content.
---

# Apply the learned author style

These instructions were learned from a handful of pieces this author happened to write. They describe tendencies, not rules. Follow them where they fit what is being written; ignore any that would make the current sentence worse, and do not force one in just because it is on the list. A draft that mechanically satisfies every instruction reads like an imitation, which is the opposite of the point.

Do not overfit to the examples. They come from a small sample on particular topics, in particular formats. Copy how the sentences are built, not their subject matter, their length, their exact openers, or their turns of phrase. If every example happens to be about one topic, that is an accident of the sample and says nothing about how to write about anything else. Never reuse a claim, name, number, or fact from them.

Preserve the meaning, facts, citations, and requested format of the document you are editing.

Read \`references/examples.md\` when an instruction is unclear and you want to see more of the author's own prose. Read \`references/metrics.json\` or \`references/propositions.json\` only when this profile is insufficient.

The user's rules come first. Anything here that conflicts with a rule, or with what the user asked for this turn, loses.

${profileBody}

---

Author style version ${skillVersion}. Built by DocWriter from the writer's own sources; see \`references/source-manifest.json\`.
`;
}

function openAiYaml(skillName: string): string {
	return [
		'interface:',
		`  display_name: ${yamlString('Author style')}`,
		`  short_description: ${yamlString('Apply the learned writing style profile')}`,
		`  default_prompt: ${yamlString(`Use $${skillName} to revise this passage in the learned writing style.`)}`,
		'policy:',
		'  allow_implicit_invocation: true',
		''
	].join('\n');
}

function sourceManifest(report: StyleAnalysisReport, skillVersion: number) {
	const references = listStyleReferences();
	return {
		schemaVersion: 1,
		// Which build of this skill you are holding. Stamped in here rather than
		// tracked only outside, so a downloaded bundle identifies itself.
		skillVersion,
		builtAt: Date.now(),
		sourceSnapshotHash: report.sourceSnapshotHash,
		sources: report.documents.map((document) => {
			const reference = references.find((candidate) => candidate.id === document.sourceId);
			return {
				id: document.sourceId,
				label: reference?.label ?? document.sourceId,
				role: document.role,
				format: document.format,
				contentHash: document.contentHash,
				wordCount: document.wordCount
			};
		})
	};
}

function assertValidSkill(skillDir: string) {
	const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
	const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) throw new Error('Generated author skill is missing YAML frontmatter');
	const keys = match[1].split('\n').map((line) => line.split(':')[0].trim()).filter(Boolean);
	if (keys.length !== 2 || !keys.includes('name') || !keys.includes('description')) {
		throw new Error('Generated author skill frontmatter may contain only name and description');
	}
	for (const required of [
		'agents/openai.yaml',
		'references/style-profile.md',
		'references/metrics.json',
		'references/propositions.json',
		'references/examples.md',
		'references/source-manifest.json',
		'scripts/analyze-style.mjs',
		'scripts/style-metrics.mjs',
		'scripts/style-metric-registry.mjs',
		'scripts/style-data.json'
	]) {
		if (!existsSync(join(skillDir, required))) throw new Error(`Generated author skill is missing ${required}`);
	}
}

/**
 * Swap a staged folder in as the live skill, keeping the old one until the
 * rename succeeds. The rollback is the only thing between a failed write and a
 * destroyed skill, so it lives in one place rather than once per caller.
 */
function swapStagedSkillIntoPlace(staging: string, skillDir: string) {
	const backup = `${skillDir}.previous`;
	rmSync(backup, { recursive: true, force: true });
	if (existsSync(skillDir)) renameSync(skillDir, backup);
	try {
		renameSync(staging, skillDir);
	} catch (error) {
		if (existsSync(backup) && !existsSync(skillDir)) renameSync(backup, skillDir);
		throw error;
	}
	rmSync(backup, { recursive: true, force: true });
}

/** A staging directory beside the live skill, cleaned of any previous attempt. */
function freshStagingDir(skillDir: string, tag: string): string {
	const parent = dirname(skillDir);
	mkdirSync(parent, { recursive: true });
	const staging = join(parent, `.${basename(skillDir)}-${tag}-${process.pid}-${Date.now()}`);
	rmSync(staging, { recursive: true, force: true });
	return staging;
}

export function compileAuthorStyleSkill(
	profile: StyleProfile,
	report: StyleAnalysisReport,
	/** True when this build is a new version of the skill: a pass that just
	 *  finished. False for the recompiles that follow as the writer refines it. */
	options: { startsNewVersion?: boolean } = {}
): { skillId: string; skillPath: string } {
	const target = resolveAuthorStyleTarget();
	const skillDir = target.path;
	const staging = freshStagingDir(skillDir, 'build');
	for (const directory of ['agents', 'references', 'scripts']) mkdirSync(join(staging, directory), { recursive: true });
	// Decided before writing so the number in the files matches the snapshot.
	const skillVersion = skillVersionFor(options.startsNewVersion === true);
	// One index and one rendered body for the whole compile: SKILL.md and
	// references/style-profile.md carry the same text.
	const sentenceIndex = makeSentenceIndex();
	const profileBody = `${profileMarkdown(profile, sentenceIndex).trim()}\n\n${conventionsMarkdown(report)}`.trim();
	try {
		writeTextAtomic(join(staging, 'SKILL.md'), skillMarkdown(target.id, profileBody.trim(), skillVersion));
		writeTextAtomic(join(staging, 'agents', 'openai.yaml'), openAiYaml(target.id));
		// Keep a copy under references/ for agents that dig past SKILL.md.
		writeTextAtomic(join(staging, 'references', 'style-profile.md'), profileBody);
		writeJsonAtomic(join(staging, 'references', 'metrics.json'), {
			schemaVersion: report.schemaVersion,
			analyzerVersion: report.analyzerVersion,
			measurements: report.measurements,
			conventions: report.conventions
		});
		writeJsonAtomic(join(staging, 'references', 'propositions.json'), {
			schemaVersion: profile.schemaVersion,
			propositions: profile.propositions
		});
		writeTextAtomic(join(staging, 'references', 'examples.md'), examplesMarkdown(profile, sentenceIndex));
		writeJsonAtomic(join(staging, 'references', 'source-manifest.json'), sourceManifest(report, skillVersion));
		writeFileSync(join(staging, 'scripts', 'analyze-style.mjs'), analyzerScript, 'utf8');
		writeFileSync(join(staging, 'scripts', 'style-metrics.mjs'), styleMetricsScript, 'utf8');
		writeFileSync(join(staging, 'scripts', 'style-metric-registry.mjs'), styleMetricRegistryScript, 'utf8');
		writeFileSync(join(staging, 'scripts', 'style-data.json'), styleData, 'utf8');
		assertValidSkill(staging);
		swapStagedSkillIntoPlace(staging, skillDir);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	const registered = upsertManagedSkill(target.id, `docwriter:${target.id}`, skillDir, MANAGED_BY);
	// History is a by-product of compiling, so a writer can go back to a version
	// they preferred without having remembered to download it.
	snapshotSkillVersion(skillDir, profile.propositions.length, skillVersion);
	return { skillId: registered.id, skillPath: skillDir };
}

/**
 * Put a whole skill folder in place as the live skill. Used to restore a
 * version or an imported bundle: the entire folder is installed, not just the
 * propositions, so the restored skill is byte-for-byte what it was.
 */
export function installSkillFolder(
	sourceDir: string,
	/** Snapshot the result into history. False when restoring a version that is
	 *  already in history, true when importing a folder from outside. */
	options: { snapshot: boolean } = { snapshot: true }
): { skillId: string; skillPath: string } {
	assertValidSkill(sourceDir);
	const target = resolveAuthorStyleTarget();
	const skillDir = target.path;
	const staging = freshStagingDir(skillDir, 'restore');
	try {
		cpSync(sourceDir, staging, { recursive: true });
		// The snapshot marker is history bookkeeping, not part of a skill.
		rmSync(join(staging, 'version.json'), { force: true });
		assertValidSkill(staging);
		swapStagedSkillIntoPlace(staging, skillDir);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	const registered = upsertManagedSkill(target.id, `docwriter:${target.id}`, skillDir, MANAGED_BY);
	// A folder from outside has never been recorded here, so keep a copy.
	// A folder from history already is one, and re-snapshotting it would file
	// the same skill under a second number that contradicts its own stamp.
	if (options.snapshot) snapshotSkillVersion(skillDir, countPropositions(skillDir), skillVersionFor(true));
	return { skillId: registered.id, skillPath: skillDir };
}

/** The version stamped inside a skill folder, if it carries one. */
export function skillFolderVersion(skillDir: string): number | null {
	try {
		const parsed = JSON.parse(
			readFileSync(join(skillDir, 'references', 'source-manifest.json'), 'utf8')
		);
		return typeof parsed?.skillVersion === 'number' ? parsed.skillVersion : null;
	} catch {
		return null;
	}
}

/** Proposition count straight from the installed files, since a restored skill
 *  may predate whatever the current profile says. */
function countPropositions(skillDir: string): number {
	try {
		const parsed = JSON.parse(readFileSync(join(skillDir, 'references', 'propositions.json'), 'utf8'));
		return Array.isArray(parsed?.propositions) ? parsed.propositions.length : 0;
	} catch {
		return 0;
	}
}

export function authorSkillFileName(skillDir = AUTHOR_STYLE_SKILL_DIR): string {
	return `${basename(skillDir)}.zip`;
}
