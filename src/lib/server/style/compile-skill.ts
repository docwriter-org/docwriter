/**
 * Compile StyleSkillState into a portable Agent Skill directory and sync it.
 */
import { existsSync, mkdirSync, cpSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { listSkills, upsertManagedSkill } from '../skills-config';
import { writeJsonAtomic, writeTextAtomic } from '../file-utils';
import type { FeatureMeasurement } from './measure';
import {
	AUTHOR_STYLE_FALLBACK_ID,
	AUTHOR_STYLE_SKILL_ID,
	type StyleProposition,
	type StyleSkillState
} from './schemas';
import {
	authorStyleSkillDir,
	listActivePropositions,
	writeStyleSkillState
} from './skill-store';

const FAMILY_HEADINGS: Record<string, string> = {
	document_organization: 'Document organization',
	section_structure: 'Section structure',
	paragraph_structure: 'Paragraphs',
	sentence_rhythm: 'Sentences and rhythm',
	grammar_voice: 'Voice',
	vocabulary_register: 'Word choice and register',
	punctuation: 'Punctuation',
	rhetorical_structure: 'Rhetorical habits',
	evidence_citations: 'Evidence and citations',
	formatting: 'Formatting'
};

function familyOrder(family: string): number {
	return Object.keys(FAMILY_HEADINGS).indexOf(family);
}

export function renderSkillMarkdown(active: StyleProposition[], skillId: string): string {
	const description =
		"Write and edit prose in this author's measured style. Use whenever drafting or revising documents for this workspace unless the user asks for a different voice. Prefer these style rules over inventing facts from writing references.";

	const byFamily = new Map<string, StyleProposition[]>();
	for (const p of active) {
		const list = byFamily.get(p.family) ?? [];
		list.push(p);
		byFamily.set(p.family, list);
	}

	const families = [...byFamily.keys()].sort((a, b) => familyOrder(a) - familyOrder(b));
	const lines: string[] = [
		'---',
		`name: ${skillId}`,
		'description: >',
		`  ${description}`,
		'---',
		'',
		'# Author style',
		'',
		'Apply these active preferences. Preserve meaning. Prefer style over inventing facts from references. Ignore inactive or calibrating guidance in `references/propositions.json`.',
		''
	];

	let n = 1;
	for (const family of families) {
		lines.push(`## ${FAMILY_HEADINGS[family] ?? family}`);
		lines.push('');
		for (const p of byFamily.get(family) ?? []) {
			const title = p.instruction.replace(/\s+/g, ' ').trim();
			const bold = title.length > 90 ? title.slice(0, 87) + '…' : title;
			lines.push(`${n}. **${bold}**`);
			if (p.claim && p.claim !== p.instruction) {
				lines.push(`   ${p.claim}`);
			}
			const ex = p.examples[0];
			if (ex?.text) {
				const snippet = ex.text.replace(/\s+/g, ' ').trim().slice(0, 220);
				lines.push(`   Example: ${snippet}`);
			}
			if (p.scope?.appliesWhen || p.scope?.genres?.length || p.scope?.sections?.length) {
				const bits = [
					p.scope.appliesWhen,
					p.scope.genres?.length ? `genres: ${p.scope.genres.join(', ')}` : '',
					p.scope.sections?.length ? `sections: ${p.scope.sections.join(', ')}` : ''
				].filter(Boolean);
				if (bits.length) lines.push(`   Scope: ${bits.join('; ')}`);
			}
			lines.push('');
			n++;
			if (n > 40) break;
		}
		if (n > 40) break;
	}

	if (n === 1) {
		lines.push('_No active propositions yet. Add writing references and run analysis._');
		lines.push('');
	}

	lines.push('## More detail');
	lines.push('');
	lines.push('When you need metrics or full proposition records, read:');
	lines.push('- [style-profile.md](references/style-profile.md)');
	lines.push('- [propositions.json](references/propositions.json)');
	lines.push('- [examples.md](references/examples.md)');
	lines.push('- [metrics.json](references/metrics.json)');
	lines.push('');
	return lines.join('\n');
}

function renderExamplesMd(active: StyleProposition[]): string {
	const lines = ['# Examples', ''];
	for (const p of active) {
		if (!p.examples.length) continue;
		lines.push(`## ${p.type}`);
		lines.push('');
		lines.push(p.instruction);
		lines.push('');
		for (const ex of p.examples.slice(0, 3)) {
			lines.push(`- ${ex.text.replace(/\s+/g, ' ').trim()}`);
		}
		lines.push('');
	}
	if (lines.length === 2) lines.push('_No grounded examples yet._', '');
	return lines.join('\n');
}

function renderStyleProfileMd(state: StyleSkillState, active: StyleProposition[]): string {
	return [
		'# Style profile',
		'',
		`Skill id: \`${state.skillId}\``,
		`Updated: ${new Date(state.updatedAt).toISOString()}`,
		`Active propositions: ${active.length}`,
		`Calibration pending: ${state.propositions.filter((p) => p.status === 'calibration').length}`,
		'',
		'## Sources',
		'',
		...state.sourceManifest.map(
			(s) => `- **${s.label}** (${s.role}) \`${s.contentHash}\` — ${s.target}`
		),
		'',
		'## Active instructions',
		'',
		...active.map(
			(p, i) =>
				`${i + 1}. (${p.family}/${p.type}, conf=${p.confidence.final.toFixed(2)}) ${p.instruction}`
		),
		''
	].join('\n');
}

function copyAnalyzeScript(skillDir: string) {
	const here = dirname(fileURLToPath(import.meta.url));
	const src = join(here, 'analyze-style.mjs');
	const destDir = join(skillDir, 'scripts');
	mkdirSync(destDir, { recursive: true });
	if (existsSync(src)) {
		cpSync(src, join(destDir, 'analyze-style.mjs'));
	} else {
		writeFileSync(
			join(destDir, 'analyze-style.mjs'),
			`#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n`,
			'utf-8'
		);
	}
}

function pickSkillId(): string {
	const collision = listSkills().skills.find((s) => s.id === AUTHOR_STYLE_SKILL_ID);
	if (
		collision &&
		collision.origin === 'custom' &&
		collision.source &&
		!collision.source.startsWith('docwriter:')
	) {
		return AUTHOR_STYLE_FALLBACK_ID;
	}
	return AUTHOR_STYLE_SKILL_ID;
}

export function compileAuthorStyleSkill(opts: {
	state: StyleSkillState;
	metrics: FeatureMeasurement[];
	preferSkillId?: string;
}): { skillId: string; dir: string; activeCount: number } {
	const skillId = opts.preferSkillId ?? pickSkillId();
	const state: StyleSkillState = { ...opts.state, skillId, updatedAt: Date.now() };
	writeStyleSkillState(state);

	const dir = authorStyleSkillDir(skillId);
	const refDir = join(dir, 'references');
	mkdirSync(refDir, { recursive: true });
	mkdirSync(join(dir, 'agents'), { recursive: true });

	const active = listActivePropositions(state);
	writeTextAtomic(join(dir, 'SKILL.md'), renderSkillMarkdown(active, skillId));
	writeTextAtomic(
		join(dir, 'agents', 'openai.yaml'),
		[
			'interface:',
			'  display_name: "Author style"',
			'  short_description: "Measured author writing preferences"',
			`  default_prompt: "Use $${skillId} to draft in my voice."`,
			''
		].join('\n')
	);
	writeTextAtomic(join(refDir, 'examples.md'), renderExamplesMd(active));
	writeTextAtomic(join(refDir, 'style-profile.md'), renderStyleProfileMd(state, active));
	writeJsonAtomic(join(refDir, 'metrics.json'), {
		schemaVersion: 1,
		updatedAt: Date.now(),
		metrics: opts.metrics
	});
	writeJsonAtomic(join(refDir, 'source-manifest.json'), {
		schemaVersion: 1,
		sources: state.sourceManifest
	});
	copyAnalyzeScript(dir);

	upsertManagedSkill({
		id: skillId,
		path: dir,
		source: 'docwriter:author-style',
		enabled: true
	});

	return { skillId, dir, activeCount: active.length };
}

export function zipAuthorStyleSkill(skillId = AUTHOR_STYLE_SKILL_ID): Buffer {
	const dir = authorStyleSkillDir(skillId);
	if (!existsSync(join(dir, 'SKILL.md'))) {
		throw new Error('Author style skill not compiled yet');
	}
	const zip = new AdmZip();
	zip.addLocalFolder(dir, skillId);
	return zip.toBuffer();
}
