import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeDocuments, analyzeText, normalizeText } from './analyze-style.mjs';
import {
	CHECKLIST_METRICS,
	CORPUS_METRIC_IDS,
	PUNCTUATION_METRIC_IDS,
	REQUIRED_CHECKLIST_METRIC_IDS,
	RESOURCE_BACKED_METRIC_IDS,
	T2_METRIC_IDS
} from './style-metric-registry.mjs';

describe('Leech and Short metric registry', () => {
	it('names metrics for all 19 checklist sections', () => {
		expect(Object.keys(CHECKLIST_METRICS)).toHaveLength(19);
		for (const [section, metrics] of Object.entries(CHECKLIST_METRICS)) {
			expect(metrics.length, section).toBeGreaterThan(0);
		}
		expect(new Set(REQUIRED_CHECKLIST_METRIC_IDS).size).toBe(REQUIRED_CHECKLIST_METRIC_IDS.length);
	});

	it('emits every named checklist metric', () => {
		const report = analyzeText({
			sourceId: 'coverage', role: 'authored', format: 'text',
			text: 'However, we carefully test the useful system because this method is important. The team then records the concrete result and explains what changed.'
		});
		const actual = new Set(report.measurements.map((item: { id: string }) => item.id));
		for (const id of REQUIRED_CHECKLIST_METRIC_IDS) expect(actual.has(id), id).toBe(true);
	});

	it('retains all 29 punctuation measurements and their occurrence data', () => {
		const report = analyzeText({
			sourceId: 'punctuation', role: 'authored', format: 'text',
			text: 'One, two; three: four — five – six -- seven. Why? Yes! Wait... No!! What?? Really?! (note) [aside] "quote" \'single\' and but or yet so because although while whereas.'
		});
		const actual = new Set(report.measurements.map((item: { id: string }) => item.id));
		for (const id of PUNCTUATION_METRIC_IDS) expect(actual.has(id), id).toBe(true);
		expect(PUNCTUATION_METRIC_IDS).toHaveLength(29);
		for (const id of PUNCTUATION_METRIC_IDS) {
			expect(report.occurrences.some((item: { metricId: string }) => item.metricId === id), id).toBe(true);
		}
	});

	it('loads complete data resources for every resource backed metric', () => {
		const data = JSON.parse(readFileSync(new URL('./style-data.json', import.meta.url), 'utf8'));
		expect(Object.keys(data.concreteness).length).toBeGreaterThanOrEqual(39000);
		expect(data.commonWords).toHaveLength(5000);
		expect(data.idioms.length).toBeGreaterThanOrEqual(500);
		expect(Object.keys(data.sentiment).length).toBeGreaterThanOrEqual(3000);
		expect(Object.keys(data.backgroundNgrams).length).toBeGreaterThanOrEqual(50000);
		expect(RESOURCE_BACKED_METRIC_IDS).toHaveLength(6);
	});

	it('records which checks use tagging and which use the full corpus', () => {
		expect(T2_METRIC_IDS).toContain('grammatical.b6.passive-rate');
		expect(T2_METRIC_IDS).toContain('figures.c1.structural-parallel-rate');
		expect(CORPUS_METRIC_IDS).toEqual(expect.arrayContaining([
			'lexical.a1.hapax-rate', 'lexical.a1.signature-ngrams',
			'figures.c1.recurring-phrase-rate', 'figures.c1.cross-paragraph-repetition-rate'
		]));
	});

	it('calculates corpus metrics across source boundaries', () => {
		const documents = [
			normalizeText({ sourceId: 'one', role: 'authored', format: 'text', text: 'Apple banana. Shared phrase returns.' }),
			normalizeText({ sourceId: 'two', role: 'authored', format: 'text', text: 'Apple carrot. Shared phrase returns.' })
		];
		const report = analyzeDocuments(documents);
		const metric = (id: string) => report.measurements.find((item: { id: string }) => item.id === id);
		expect(metric('lexical.a1.hapax-rate')?.value).toBe(0.2);
		expect(metric('lexical.a1.signature-ngrams')?.value).toBeGreaterThan(0);
	});

	it('uses the shared phrase analysis for tagged grammar checks', () => {
		const report = analyzeText({
			sourceId: 'syntax', role: 'authored', format: 'text',
			text: 'The careful research team tested the concrete system. The stable result was carefully measured by the team.'
		});
		const metric = (id: string) => report.measurements.find((item: { id: string }) => item.id === id);
		expect(metric('lexical.a3.attributive-rate')?.value).toBeGreaterThan(0);
		expect(metric('lexical.a4.transitive-rate')?.value).toBeGreaterThan(0);
		expect(metric('grammatical.b5.np-weight')?.value).toBeGreaterThan(0);
		expect(metric('grammatical.b6.passive-rate')?.value).toBeGreaterThan(0);
	});
});
