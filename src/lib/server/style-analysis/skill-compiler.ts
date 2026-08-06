import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SourceSpan, StyleAnalysisReport, StyleProfile, StyleProposition } from '$lib/style-profile';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { readSkillsConfig, upsertManagedSkill } from '$lib/server/skills-config';
import { writeJsonAtomic, writeTextAtomic } from '$lib/server/file-utils';
import { listStyleReferences } from '$lib/server/references';
import analyzerScript from './analyze-style.mjs?raw';

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
	return profile.propositions.filter((proposition) => ['active', 'confirmed'].includes(proposition.status));
}

function profileMarkdown(profile: StyleProfile): string {
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
			lines.push(`* ${item.instruction} Confidence: ${item.confidence.toFixed(2)}.`);
			// Examples do more work than the instruction — the agent imitates what
			// it can see, so quote several.
			for (const example of item.examples.slice(0, 3)) {
				lines.push(`  Example: ${example.replace(/\s+/g, ' ').trim()}`);
			}
		}
		lines.push('');
	}
	return `${lines.join('\n').trim()}\n`;
}

function examplesMarkdown(profile: StyleProfile): string {
	const lines = ['# Grounded examples', ''];
	for (const proposition of activePropositions(profile)) {
		if (!proposition.examples.length) continue;
		lines.push(`## ${proposition.statement}`, '');
		for (const example of proposition.examples) {
			lines.push(`> ${example.replace(/\n+/g, ' ').trim()}`, '');
		}
	}
	return `${lines.join('\n').trim()}\n`;
}

function skillMarkdown(skillName: string): string {
	return `---
name: ${skillName}
description: Apply the writing style learned from this workspace's references. Use when drafting or revising prose for this workspace unless the user requests a different style. Do not use reference facts or claims as content.
---

# Apply the learned author style

Read \`references/style-profile.md\` before drafting or revising prose.

Apply only the active instructions in that profile, and apply each instruction only in its recorded scope. Preserve the meaning, facts, citations, and requested format of the document. Do not copy claims, names, data, or subject matter from the source references.

Read \`references/examples.md\` when an instruction needs clarification. Use the examples to understand form and rhythm, not as source material. Read \`references/metrics.json\` or \`references/propositions.json\` only when the concise profile is insufficient.

If the user requests a different style, follow the user's request. If two active instructions conflict in the current context, prefer the instruction with higher confidence and explain the conflict briefly.

Run \`scripts/analyze-style.mjs\` only when asked to inspect new plain text or Markdown outside DocWriter. The script prints deterministic measurements and does not update this profile.
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

function sourceManifest(report: StyleAnalysisReport) {
	const references = listStyleReferences();
	return {
		schemaVersion: 1,
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
		'scripts/analyze-style.mjs'
	]) {
		if (!existsSync(join(skillDir, required))) throw new Error(`Generated author skill is missing ${required}`);
	}
}

export function compileAuthorStyleSkill(profile: StyleProfile, report: StyleAnalysisReport): { skillId: string; skillPath: string } {
	const target = resolveAuthorStyleTarget();
	const skillDir = target.path;
	const parent = dirname(skillDir);
	mkdirSync(parent, { recursive: true });
	const staging = join(parent, `.${basename(skillDir)}-${process.pid}-${Date.now()}`);
	rmSync(staging, { recursive: true, force: true });
	for (const directory of ['agents', 'references', 'scripts']) mkdirSync(join(staging, directory), { recursive: true });
	try {
		writeTextAtomic(join(staging, 'SKILL.md'), skillMarkdown(target.id));
		writeTextAtomic(join(staging, 'agents', 'openai.yaml'), openAiYaml(target.id));
		writeTextAtomic(join(staging, 'references', 'style-profile.md'), profileMarkdown(profile));
		writeJsonAtomic(join(staging, 'references', 'metrics.json'), {
			schemaVersion: report.schemaVersion,
			analyzerVersion: report.analyzerVersion,
			measurements: report.measurements
		});
		writeJsonAtomic(join(staging, 'references', 'propositions.json'), {
			schemaVersion: profile.schemaVersion,
			propositions: profile.propositions
		});
		writeTextAtomic(join(staging, 'references', 'examples.md'), examplesMarkdown(profile));
		writeJsonAtomic(join(staging, 'references', 'source-manifest.json'), sourceManifest(report));
		writeFileSync(join(staging, 'scripts', 'analyze-style.mjs'), analyzerScript, 'utf8');
		assertValidSkill(staging);
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
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	const registered = upsertManagedSkill(target.id, `docwriter:${target.id}`, skillDir, MANAGED_BY);
	return { skillId: registered.id, skillPath: skillDir };
}

export function authorSkillFileName(skillDir = AUTHOR_STYLE_SKILL_DIR): string {
	return `${basename(skillDir)}.zip`;
}
