import { describe, expect, it } from 'vitest';
import { analyzeDocuments, normalizeText } from './analyze-style.mjs';
import { isMeasured } from './run-manager';
import type { StyleAnalysisReport } from '$lib/style-profile';

const SAMPLE = `# Why evaluation is hard

Most teams building with language models skip evaluation. They ship a prompt, watch a
few outputs, and call it done. That works until it doesn't, and by then the failure is
already in production.

## What goes wrong

The core problem is that model output is open ended. A traditional test asserts equality.
Here there is no single right answer, so you need a judge, and building that judge is its
own project (Shankar et al., 2024).

- Start with real user data.
- Look at a hundred examples by hand.
- Only then write the rubric.

You cannot skip the manual pass. It is where the failure modes come from.`;

function reportFor(text: string): StyleAnalysisReport {
	const document = normalizeText({ sourceId: 'sample', role: 'authored', format: 'md', text });
	return analyzeDocuments([document]) as StyleAnalysisReport;
}

describe('isMeasured', () => {
	it('keeps non-punctuation metrics, which carry no occurrence records', () => {
		const report = reportFor(SAMPLE);
		const kept = report.measurements.filter(isMeasured);
		const families = new Set(kept.map((measurement) => measurement.family));

		// The bug this guards: `count` is only ever set for punctuation, so
		// testing it for every family left punctuation as the only survivor and
		// briefed two specialists on nothing.
		expect(families.size).toBeGreaterThan(1);
		for (const family of [
			'lexical',
			'grammatical',
			'figures',
			'cohesion-context'
		]) {
			expect(families).toContain(family);
		}
		expect(kept.length).toBeGreaterThan(40);
	});

	it('still drops metrics that measured zero', () => {
		const report = reportFor(SAMPLE);
		for (const measurement of report.measurements.filter(isMeasured)) {
			expect(measurement.value).not.toBe(0);
		}
		// Nothing in the sample is a table, so that metric must not survive.
		const tables = report.conventions.find((m) => m.id === 'formatting.table-density');
		expect(tables?.sourceCount).toBe(0);
	});

	it('counts author-year citations so the discourse specialist has evidence', () => {
		const report = reportFor(SAMPLE);
		const citations = report.measurements.find(
			(measurement) => measurement.id === 'cohesion.d2.citation-per-1000'
		);
		expect(citations && isMeasured(citations)).toBe(true);
	});
});
