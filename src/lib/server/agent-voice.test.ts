/**
 * The transcript is the author and the agent talking. Injected turns speak
 * as "I", the system prompt is the author's briefing, and anything a person
 * reads addresses them as "you" — never "the user".
 *
 * The first sweep of this convention missed whole files (provider-specific
 * tool copies, the bundled skills the agent reads, the style-skill compiler,
 * panel-injected turns), so the wrong voice kept surfacing in the UI. This
 * test scans agent-facing sources so a new third-person string fails CI
 * instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Files whose string content reaches the agent or shows in the transcript. */
const AGENT_FACING = [
	'src/routes/api/render/+server.ts',
	'src/routes/+page.svelte',
	'src/lib/editor/TiptapEditor.svelte',
	'src/lib/components/RulesPanel.svelte',
	'src/lib/components/RulesPillBar.svelte',
	'src/lib/components/SkillsPanel.svelte',
	'src/lib/server/mcp-doc-tools.ts',
	'src/lib/server/providers/tool-handlers.ts',
	'src/lib/server/providers/claude.ts',
	'src/lib/server/providers/codex.ts',
	'src/lib/server/reviewers.ts',
	'src/lib/server/claude-memory.ts',
	'src/lib/server/skills-config.ts',
	'src/lib/server/style-block.ts',
	'src/lib/server/style-analysis/skill-compiler.ts',
	'src/lib/server/style-analysis/calibration.ts',
	'src/lib/shared/feedback-import.ts',
	'src/lib/shared/reviewers.ts'
];

/** Lines that may legitimately contain the phrase. */
function isAllowed(line: string): boolean {
	const t = line.trim();
	// Developer comments are not agent-facing.
	if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
	// Trigger matchers accept BOTH voices on purpose: persisted rounds and
	// restored history still carry the old third-person triggers.
	if (/The user\|I|\(\?:The user\|I\)/.test(line)) return true;
	// Legacy transcript parser for a heading no code writes any more.
	if (line.includes('## What the user wants')) return true;
	// The system prompt states the rule by quoting the forbidden phrase.
	if (line.includes('not "the user"')) return true;
	return false;
}

function offendingLines(text: string): string[] {
	return text
		.split('\n')
		.filter((line) => /\bthe user\b|\bUser's\b|\buser's\b/i.test(line))
		.filter((line) => !isAllowed(line))
		.filter((line) => {
			const t = line.trim();
			return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
		});
}

function bundledSkillFiles(): string[] {
	const base = join(ROOT, 'src/lib/server/skills');
	const out: string[] = [];
	for (const dir of readdirSync(base)) {
		const p = join(base, dir, 'SKILL.md');
		try {
			if (statSync(p).isFile()) out.push(relative(ROOT, p));
		} catch {
			// directory without a SKILL.md — not a skill
		}
	}
	return out;
}

describe('agent-facing text speaks in the author\'s voice', () => {
	for (const file of AGENT_FACING) {
		it(`${file} never says "the user"`, () => {
			const offenders = offendingLines(readFileSync(join(ROOT, file), 'utf-8'));
			expect(offenders, `third-person reference in ${file}:\n${offenders.join('\n')}`).toEqual([]);
		});
	}

	it('bundled skills the agent reads never say "the user"', () => {
		for (const file of bundledSkillFiles()) {
			const text = readFileSync(join(ROOT, file), 'utf-8');
			const offenders = offendingLines(text);
			expect(offenders, `third-person reference in ${file}:\n${offenders.join('\n')}`).toEqual([]);
			// Markdown wraps prose, so a line-by-line scan misses a phrase split
			// across a newline ("prose for the\n  user"). Match the flattened
			// text too — that exact wrap is how one slipped through.
			const flattened = text.replace(/\s+/g, ' ');
			expect(flattened, `third-person reference (line-wrapped) in ${file}`).not.toMatch(
				/\bthe user\b|\buser's\b/i
			);
		}
	});

	it('the system prompt states the voice contract explicitly', () => {
		const prompt = readFileSync(join(ROOT, 'src/routes/api/render/+server.ts'), 'utf-8');
		expect(prompt).toContain('You are my writing collaborator. I am the author.');
		expect(prompt).toMatch(/Never refer to me in the third person/);
	});
});
