import { describe, expect, it } from 'vitest';
import { analyzeDocuments, analyzeText, normalizeText } from './analyze-style.mjs';
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

		expect(metric(report, 'punctuation.boundary.colon')?.count).toBe(1);
		expect(metric(report, 'punctuation.boundary.semicolon')?.count).toBe(1);
		expect(metric(report, 'punctuation.boundary.double-hyphen')?.count).toBe(1);
		expect(metric(report, 'punctuation.sequence.mixed-question-exclamation')?.count).toBe(1);
		const falseColons = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.boundary.colon');
		expect(falseColons).toHaveLength(1);
	});

	it('records clause context for punctuation and conjunctions', () => {
		const report = analyzeText({
			sourceId: 'clauses',
			role: 'authored',
			format: 'text',
			text: 'The first result was stable, but the second result changed and the team reran it.'
		});
		const comma = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.boundary.comma');
		const conjunction = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.boundary.conjunction.and');
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
		const periods = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.terminal.period');
		const commas = report.occurrences.filter((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.boundary.comma');
		expect(periods).toHaveLength(2);
		expect(commas).toHaveLength(0);
	});

	it('counts each supported punctuation category with exact source spans', () => {
		const text = 'One, two; three: four — five – six -- seven. Why? Yes! Wait... Really?! (note) [aside] “quote”';
		const report = analyzeText({ sourceId: 'inventory', role: 'authored', format: 'text', text });
		const expectedCounts: Record<string, number> = {
			'punctuation.boundary.comma': 1, 'punctuation.boundary.semicolon': 1, 'punctuation.boundary.colon': 1,
			'punctuation.boundary.em-dash': 1, 'punctuation.boundary.en-dash': 1, 'punctuation.boundary.double-hyphen': 1,
			'punctuation.terminal.period': 1, 'punctuation.terminal.question': 1, 'punctuation.terminal.exclamation': 1,
			'punctuation.terminal.ellipsis': 1, 'punctuation.sequence.repeated-period': 1, 'punctuation.sequence.mixed-question-exclamation': 1,
			'punctuation.enclosure.parenthesis-open': 1, 'punctuation.enclosure.parenthesis-close': 1,
			'punctuation.enclosure.bracket-open': 1, 'punctuation.enclosure.bracket-close': 1,
			'punctuation.enclosure.double-quote': 2
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
		const semicolon = report.occurrences.find((occurrence: { metricId: string }) => occurrence.metricId === 'punctuation.boundary.semicolon');
		expect(semicolon?.context?.nestingDepth).toBe(2);
	});
});

describe('style analyzer structure', () => {
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

	it('reports all ten feature families', () => {
		const report = analyzeText({
			sourceId: 'sample',
			role: 'authored',
			format: 'md',
			text: '# Method\n\nHowever, we measured the draft carefully; the result improved (Smith, 2024).\n\n* First item\n* Second item'
		});
		const families = new Set(report.measurements.map((measurement: { family: string }) => measurement.family));
		expect(families).toEqual(new Set([
			'document-organization', 'section-structure', 'paragraph-structure',
			'sentence-rhythm', 'grammar-voice', 'vocabulary-register', 'punctuation',
			'rhetorical-structure', 'evidence-citations', 'formatting'
		]));
		expect(report.measurements.length).toBeGreaterThanOrEqual(90);
		for (const id of [
			'document-organization.opening-share', 'section-structure.opening-block-words',
			'paragraph-structure.sentence-length-slope', 'sentence-rhythm.words-p90',
			'grammar-voice.past-tense-proxy-per-1000', 'vocabulary-register.syllables-per-word',
			'rhetorical-structure.claim-position', 'evidence-citations.citation-position',
			'formatting.heading-title-case-rate'
		]) expect(metric(report, id), id).toBeDefined();
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
			schemaVersion: 1,
			analyzerVersion: '1.0.0',
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
