import { describe, expect, it } from 'vitest';
import { analyzeDocuments, analyzeText, normalizeText } from './analyze-style.mjs';
import { getPosTagRunCount, resetPosTagRunCount } from './style-metrics.mjs';
import { styleProfileForClient, verifiedExamples } from './profile-store';
import type { StyleAnalysisReport } from '$lib/style-profile';

function metric(report: ReturnType<typeof analyzeText>, id: string) {
	return report.measurements.find((measurement: { id: string }) => measurement.id === id);
}

describe('style analyzer punctuation', () => {
	it('counts clause boundaries and excludes URL, time, and decimal punctuation', () => {
		const report = analyzeText({
			sourceId: 'punctuation',
			role: 'authored',
			format: 'text',
			text: 'Plan: write carefully; then revise -- and finish. Really?! Visit https://example.com at 10:30. The value is 3.14.'
		});

		expect(metric(report, 'grammatical.punct.boundary.colon')?.count).toBe(1);
		expect(metric(report, 'grammatical.punct.boundary.semicolon')?.count).toBe(1);
		expect(metric(report, 'grammatical.punct.boundary.double-hyphen')?.count).toBe(1);
		expect(metric(report, 'grammatical.punct.sequence.mixed-question-exclamation')?.count).toBe(1);
		const falseColons = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.boundary.colon');
		expect(falseColons).toHaveLength(1);
	});

	it('records clause context for punctuation and conjunctions', () => {
		const report = analyzeText({
			sourceId: 'clauses',
			role: 'authored',
			format: 'text',
			text: 'The first result was stable, but the second result changed and the team reran it.'
		});
		const comma = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.boundary.comma');
		const conjunction = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.boundary.conjunction.and');
		expect(comma?.context?.leftClauseWords).toBeGreaterThan(0);
		expect(comma?.context?.rightClauseWords).toBeGreaterThan(0);
		expect(conjunction?.context?.likelyFunction).toBe('coordination-or-subordination');
	});

	it('does not treat URL, decimal, abbreviation, or citation punctuation as prose boundaries', () => {
		const report = analyzeText({
			sourceId: 'false-positives',
			role: 'authored',
			format: 'text',
			text: 'Dr. Chen used version 2.1 from https://example.com/a. The prior result (Smith et al., 2024) was stable.'
		});
		const periods = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.terminal.period');
		const commas = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.boundary.comma');
		expect(periods).toHaveLength(2);
		expect(commas).toHaveLength(0);
	});

	it('counts each supported punctuation category with exact source spans', () => {
		const text = 'One, two; three: four — five – six -- seven. Why? Yes! Wait... Really?! (note) [aside] “quote”';
		const report = analyzeText({ sourceId: 'inventory', role: 'authored', format: 'text', text });
		const expectedCounts: Record<string, number> = {
			'grammatical.punct.boundary.comma': 1, 'grammatical.punct.boundary.semicolon': 1, 'grammatical.punct.boundary.colon': 1,
			'grammatical.punct.boundary.em-dash': 1, 'grammatical.punct.boundary.en-dash': 1, 'grammatical.punct.boundary.double-hyphen': 1,
			'grammatical.punct.terminal.period': 1, 'grammatical.punct.terminal.question': 1, 'grammatical.punct.terminal.exclamation': 1,
			'grammatical.punct.terminal.ellipsis': 1, 'grammatical.punct.sequence.repeated-period': 1, 'grammatical.punct.sequence.mixed-question-exclamation': 1,
			'grammatical.punct.enclosure.parenthesis-open': 1, 'grammatical.punct.enclosure.parenthesis-close': 1,
			'grammatical.punct.enclosure.bracket-open': 1, 'grammatical.punct.enclosure.bracket-close': 1,
			'grammatical.punct.enclosure.double-quote': 2
		};
		for (const [id, expected] of Object.entries(expectedCounts)) {
			const occurrences = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === id);
			expect(occurrences.length, id).toBe(expected);
			for (const occurrence of occurrences) expect(text.slice(occurrence.start, occurrence.end)).toBe(occurrence.text);
		}
	});

	it('records punctuation nesting inside enclosures', () => {
		const report = analyzeText({
			sourceId: 'nesting',
			role: 'authored',
			format: 'text',
			text: 'The result (including the second check [run twice; then reviewed]) was stable.'
		});
		const semicolon = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'grammatical.punct.boundary.semicolon');
		expect(semicolon?.context?.nestingDepth).toBe(2);
	});
});

describe('style analyzer structure', () => {
	it('runs the POS tagger once per source and shares it across T2 metrics', () => {
		resetPosTagRunCount();
		const report = analyzeText({
			sourceId: 'pos', role: 'authored', format: 'text',
			text: 'Shreya writes useful technical papers and carefully tests robust systems.'
		});
		expect(getPosTagRunCount()).toBe(1);
		expect(metric(report, 'lexical.a3.adjective-rate')?.value).toBeGreaterThan(0);
		expect(metric(report, 'grammatical.b5.np-weight')?.value).toBeGreaterThan(0);
	});

	it('normalizes spans for headings, paragraphs, sentences, clauses, and tokens', () => {
		const document = normalizeText({
			sourceId: 'sample',
			role: 'inspiration',
			format: 'md',
			text: '# Method\n\nWe measured the draft. We then revised it.\n\n## Result\n\nThe result improved.'
		});
		expect(document.sections).toHaveLength(2);
		expect(document.paragraphs).toHaveLength(2);
		expect(document.sentences).toHaveLength(3);
		expect(document.tokens.length).toBeGreaterThan(10);
		for (const sentence of document.sentences) {
			expect(document.text.slice(sentence.start, sentence.end)).toBe(sentence.text);
		}
	});

	it('reports the four prose families and keeps layout as conventions', () => {
		const report = analyzeText({
			sourceId: 'sample',
			role: 'authored',
			format: 'md',
			text: '# Method\n\nHowever, we measured the draft carefully; the result improved (Smith, 2024).\n\n* First item\n* Second item'
		});
		const families = new Set(report.measurements.map((measurement: { family: string }) => measurement.family));
		expect(families).toEqual(new Set(['lexical', 'grammatical', 'figures', 'cohesion-context']));
		expect(report.measurements.length).toBeGreaterThanOrEqual(140);
		expect(report.conventions.length).toBeGreaterThanOrEqual(20);
		for (const id of [
			'lexical.a1.morphological-complexity', 'lexical.a3.adjective-rate',
			'grammatical.b2.words-p90', 'grammatical.b4.opener-subordinator',
			'grammatical.b6.passive-rate', 'figures.c1.anaphora-rate',
			'figures.c3.analogy-marker-per-1000', 'cohesion.d1.causal-per-1000',
			'cohesion.d2.citation-position'
		]) expect(metric(report, id), id).toBeDefined();
		expect(report.conventions.some((item: { id: string }) => item.id === 'formatting.heading-title-case-rate')).toBe(true);
	});
});

describe('proposition grounding', () => {
	it('accepts an example the author actually wrote', () => {
		const document = normalizeText({ sourceId: 'one', role: 'authored', format: 'text', text: 'We write short sentences. We use examples.' });
		expect(verifiedExamples(['We write short sentences.'], document.text)).toHaveLength(1);
	});

	it('rejects an example that is nowhere in the sources', () => {
		const document = normalizeText({ sourceId: 'one', role: 'authored', format: 'text', text: 'We write short sentences. We use examples.' });
		expect(verifiedExamples(['We deploy microservices at scale.'], document.text)).toHaveLength(0);
	});

	it('ignores differences in smart quotes, dashes, and spacing', () => {
		const document = normalizeText({ sourceId: 'one', role: 'authored', format: 'text', text: 'The result is clear — the “shorter” opening wins.' });
		expect(verifiedExamples(['the result is clear - the "shorter"  opening wins.'], document.text)).toHaveLength(1);
	});

	it('does not expose the hidden calibration direction to clients', () => {
		const profile = styleProfileForClient({
			schemaVersion: 2,
			analyzerVersion: '2.0.0',
			status: 'needs-calibration',
			createdAt: 1,
			updatedAt: 1,
			sourceSnapshotHash: 'snapshot',
			propositions: [],
			calibrations: [{ id: 'trial', propositionId: 'proposition', status: 'generated', candidateA: 'A', candidateB: 'B', targetCandidate: 'a' }]
		});
		expect(profile.calibrations[0].targetCandidate).toBeUndefined();
	});

	it('keeps snapshot hashes stable regardless of source order', () => {
		const authored = normalizeText({ sourceId: 'authored', role: 'authored', format: 'text', text: 'Results changed.' });
		const inspiration = normalizeText({ sourceId: 'inspiration', role: 'inspiration', format: 'text', text: 'The measured results changed substantially after the research team repeated every careful validation step across the complete collection of held out records.' });
		expect(analyzeDocuments([authored, inspiration]).sourceSnapshotHash)
			.toBe(analyzeDocuments([inspiration, authored]).sourceSnapshotHash);
	});
});
