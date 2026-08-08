import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testRoot = '';

afterEach(() => {
	if (testRoot) rmSync(testRoot, { recursive: true, force: true });
	delete process.env.DOCWRITER_ROOT;
});

describe('author style skill compiler', () => {
	it('writes a valid portable skill without raw source text', async () => {
		testRoot = mkdtempSync(join(tmpdir(), 'docwriter-author-skill-'));
		process.env.DOCWRITER_ROOT = testRoot;
		const { compileAuthorStyleSkill } = await import('./skill-compiler');
		const report = {
			schemaVersion: 2,
			analyzerVersion: '2.0.0',
			createdAt: Date.now(),
			sourceSnapshotHash: 'snapshot',
			documents: [{ sourceId: 'source-1', role: 'authored' as const, format: 'text', contentHash: 'hash', wordCount: 20 }],
			measurements: [{
				id: 'grammatical.b2.words-mean', family: 'grammatical' as const, label: 'Sentence words', unit: 'words' as const,
				value: 12, count: 3, sourceCount: 1, roleValues: { authored: 12 }, reliability: 0.9, occurrenceIds: []
			}],
			conventions: [{
				id: 'formatting.heading-density', family: 'conventions' as const, label: 'Formatting: heading density', unit: 'ratio' as const,
				value: 0.2, count: 0, sourceCount: 1, roleValues: { authored: 0.2 }, reliability: 0.95, occurrenceIds: []
			}],
			occurrences: [],
			examples: [{ id: 'example-1', sourceId: 'source-1', start: 0, end: 24, text: 'A short grounded example.', kind: 'grammatical' }]
		};
		const profile = {
			schemaVersion: 2,
			analyzerVersion: '2.0.0',
			status: 'active' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			sourceSnapshotHash: 'snapshot',
			calibrations: [],
			propositions: [{
				id: 'style-1', family: 'grammatical' as const,
				statement: 'The author uses concise sentences.', instruction: 'Use concise sentences.',
				examples: ['A short grounded example.'], confidence: 1,
				status: 'active' as const, createdAt: Date.now(), updatedAt: Date.now()
			}]
		};

		const compiled = compileAuthorStyleSkill(profile, report);
		expect(compiled.skillId).toBe('author-style');
		const required = [
			'SKILL.md', 'agents/openai.yaml', 'references/style-profile.md', 'references/metrics.json',
			'references/propositions.json', 'references/examples.md', 'references/source-manifest.json',
			'scripts/analyze-style.mjs', 'scripts/style-metrics.mjs', 'scripts/style-metric-registry.mjs',
			'scripts/style-data.json'
		];
		for (const path of required) expect(existsSync(join(compiled.skillPath, path))).toBe(true);
		const skillMd = readFileSync(join(compiled.skillPath, 'SKILL.md'), 'utf8');
		const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
		expect(frontmatter.split('\n').map((line) => line.split(':')[0])).toEqual(['name', 'description']);
		expect(skillMd).toContain('# Learned style profile');
		expect(skillMd).toContain('Use concise sentences.');
		expect(skillMd).toContain('## Document conventions');
		expect(skillMd).not.toContain('analyze-style.mjs');
		expect(skillMd).not.toContain('Read `references/style-profile.md`');
		const portableInput = join(testRoot, 'portable-input.txt');
		writeFileSync(portableInput, 'However, we carefully test the useful system. This result is clear.', 'utf8');
		const portableReport = JSON.parse(execFileSync(process.execPath, [
			join(compiled.skillPath, 'scripts', 'analyze-style.mjs'), '--input', portableInput
		], { encoding: 'utf8' }));
		expect(portableReport.measurements.some((item: { id: string }) => item.id === 'lexical.a3.adjective-rate')).toBe(true);
		expect(portableReport.conventions).toBeInstanceOf(Array);
		const contents = readdirSync(join(compiled.skillPath, 'references'))
			.map((name) => readFileSync(join(compiled.skillPath, 'references', name), 'utf8'))
			.join('\n');
		expect(contents).not.toContain('RAW SOURCE SENTINEL');

		writeFileSync(join(compiled.skillPath, 'SKILL.md'), 'USER OWNED SKILL SENTINEL\n', 'utf8');
		writeFileSync(join(testRoot, '.docwriter', 'skills.json'), `${JSON.stringify({
			disabledBundled: [],
			customSkills: [{ id: 'author-style', source: 'user', path: compiled.skillPath, enabled: true, addedAt: 1 }]
		}, null, 2)}\n`, 'utf8');
		const fallback = compileAuthorStyleSkill(profile, report);
		expect(fallback.skillId).toBe('docwriter-author-style');
		expect(fallback.skillPath).not.toBe(compiled.skillPath);
		expect(readFileSync(join(compiled.skillPath, 'SKILL.md'), 'utf8')).toContain('USER OWNED SKILL SENTINEL');

		const validator = process.env.DOCWRITER_SKILL_VALIDATOR;
		if (validator && existsSync(validator)) {
			const useUv = process.env.DOCWRITER_SKILL_VALIDATOR_USE_UV === '1';
			const output = useUv
				? execFileSync('uv', ['run', '--with', 'pyyaml', 'python', validator, fallback.skillPath], { encoding: 'utf8' })
				: execFileSync('python3', [validator, fallback.skillPath], { encoding: 'utf8' });
			expect(output).toContain('valid');
		}
	});
});
