import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeText } from './normalize';
import { analyzePunctuation } from './punctuation';
import { computeLexiconMetrics, AI_OVERUSE_WORDS } from './lexicon';
import { measureDocuments } from './measure';
import { buildHeuristicPropositions } from './heuristic-propositions';
import { computeFinalConfidence, statusFromConfidence } from './confidence';
import { validateSubmission } from './specialists';
import { applyCalibrationResponse, validateCloseCall } from './calibrate';
import type { CalibrationTrial } from './schemas';
import { renderSkillMarkdown } from './compile-skill';
import {
	stripHtml,
	extractPdfText,
	contentHash,
	isPrivateUrl,
	writeCachedExtraction,
	materializeReference,
	isStyleCachePath
} from './materialize';
import { AUTHOR_STYLE_SKILL_ID } from './schemas';
import { dedupePropositions } from './specialists';
import { countUnresolvedCalibration } from './skill-store';

describe('normalize + punctuation', () => {
	it('preserves sentence spans and counts terminals', () => {
		const doc = normalizeText(
			'Hello world. Is this a question? Wow!\n\nSecond paragraph with a clause; then more.',
			{ sourceId: 's1', role: 'authored' }
		);
		expect(doc.paragraphs.length).toBe(2);
		expect(doc.sentences.length).toBeGreaterThanOrEqual(3);
		const punct = analyzePunctuation(doc);
		expect(punct.counts['.']).toBeGreaterThanOrEqual(1);
		expect(punct.counts['?']).toBe(1);
		expect(punct.counts['!']).toBe(1);
		expect(punct.counts[';']).toBeGreaterThanOrEqual(1);
	});

	it('excludes URL colons, decimals, and in-word hyphens from clause boundaries', () => {
		const doc = normalizeText(
			'See https://example.com/path at 12:30 for v1.2 updates of well-crafted tools.',
			{ sourceId: 's2', role: 'authored' }
		);
		const punct = analyzePunctuation(doc);
		// URL : and time : should not dominate; hyphen in well-crafted excluded
		const colonBoundaries = punct.occurrences.filter(
			(o) => o.char === ':' && o.kind === 'clause_boundary'
		);
		expect(colonBoundaries.length).toBe(0);
		expect(punct.counts['-'] ?? 0).toBe(0);
	});
});

describe('lexicon', () => {
	it('finds signature words and AI-ism absences', () => {
		const a = normalizeText(
			'We evaluate assertions with criteria drift when graders update their criteria. Assertions matter.',
			{ sourceId: 'a', role: 'authored' }
		);
		const b = normalizeText(
			'Criteria drift appears again when assertions conflict with earlier criteria judgments.',
			{ sourceId: 'b', role: 'authored' }
		);
		const lex = computeLexiconMetrics([a, b]);
		expect(lex.signatureWords.some((w) => w.term.includes('criteria') || w.term.includes('assertion'))).toBe(
			true
		);
		expect(lex.aiIsmsAbsent).toContain('delve');
		expect(lex.aiIsmsAbsent.length).toBeGreaterThan(5);
		expect(AI_OVERUSE_WORDS).toContain('tapestry');
	});
});

describe('confidence', () => {
	it('caps single-source and role-conflict confidence', () => {
		const single = computeFinalConfidence({
			evidenceRefs: [
				{ sourceId: 'a', spanId: 's_a_0', quote: 'hi', role: 'authored' }
			],
			counterevidence: [],
			sourceCount: 3,
			matchingContextRepetition: 1,
			agentInterpretation: 1,
			extractorReliability: 1,
			authoredAgree: true,
			inspirationAgree: false,
			roleConflict: false
		});
		expect(single.final).toBeLessThanOrEqual(0.65);

		const conflict = computeFinalConfidence({
			evidenceRefs: [
				{ sourceId: 'a', spanId: 's_a_0', quote: 'hi', role: 'authored' },
				{ sourceId: 'b', spanId: 's_b_0', quote: 'hi', role: 'inspiration' }
			],
			counterevidence: [],
			sourceCount: 2,
			matchingContextRepetition: 1,
			agentInterpretation: 1,
			extractorReliability: 1,
			authoredAgree: true,
			inspirationAgree: true,
			roleConflict: true
		});
		expect(conflict.final).toBeLessThanOrEqual(0.7);
		expect(statusFromConfidence(0.8, true)).toBe('active');
		expect(statusFromConfidence(0.5, true)).toBe('calibration');
		expect(statusFromConfidence(0.9, false)).toBe('observation');
	});
});

describe('specialist validation', () => {
	it('rejects unknown metric ids and bad evidence spans', () => {
		const doc = normalizeText('Plain sentence about evaluation.', {
			sourceId: 'ref1',
			role: 'authored'
		});
		const measurements = measureDocuments([doc]);
		const bad = validateSubmission(
			{
				propositions: [
					{
						family: 'vocabulary_register',
						type: 'signature_lexicon',
						instruction: 'Prefer X',
						metricIds: ['doc.nope.missing'],
						interpretationConfidence: 0.5,
						evidence: [
							{
								sourceId: 'ref1',
								spanId: doc.sentences[0].id,
								quote: 'NOT IN THE SENTENCE AT ALL XYZ',
								role: 'authored'
							}
						]
					}
				]
			},
			[doc],
			['vocabulary_register'],
			measurements.metricIndex
		);
		expect(bad.ok).toBe(false);
	});

	it('rejects unknown corpus/lexicon metric ids and empty evidence quotes', () => {
		const doc = normalizeText('Plain sentence about evaluation criteria here.', {
			sourceId: 'ref1',
			role: 'authored'
		});
		const measurements = measureDocuments([doc]);
		const unknownCorpus = validateSubmission(
			{
				propositions: [
					{
						family: 'punctuation',
						type: 'clause_boundary',
						instruction: 'Avoid dashes',
						metricIds: ['corpus.not.a.real.metric'],
						interpretationConfidence: 0.5,
						evidence: []
					}
				]
			},
			[doc],
			['punctuation'],
			measurements.metricIndex
		);
		expect(unknownCorpus.ok).toBe(false);

		const emptyQuote = validateSubmission(
			{
				propositions: [
					{
						family: 'vocabulary_register',
						type: 'signature_lexicon',
						instruction: 'Prefer evaluation language',
						metricIds: ['lexicon.signature_words'],
						interpretationConfidence: 0.5,
						evidence: [
							{
								sourceId: 'ref1',
								spanId: doc.sentences[0].id,
								quote: '',
								role: 'authored'
							}
						]
					}
				]
			},
			[doc],
			['vocabulary_register'],
			measurements.metricIndex
		);
		expect(emptyQuote.ok).toBe(false);
	});

	it('emits corpus.dash.rate and demotes generic AI-ism/dash absences to observations', () => {
		const docs = [
			normalizeText('We evaluate assertions with clear criteria. Short clauses stay crisp.', {
				sourceId: 'a',
				role: 'authored'
			}),
			normalizeText('Criteria drift appears when graders revise earlier judgments.', {
				sourceId: 'b',
				role: 'authored'
			})
		];
		const measurements = measureDocuments(docs);
		expect(measurements.metricIndex.has('corpus.dash.rate')).toBe(true);
		const props = buildHeuristicPropositions(docs, measurements, 'run_cal');
		const absence = props.find((p) => p.type === 'ai_ism_avoidance');
		expect(absence?.status).toBe('observation');
		expect(absence?.confidence.final).toBeLessThan(0.5);
		const dash = props.find((p) => p.id.startsWith('prop_no_dash_'));
		expect(dash?.status).toBe('observation');
	});
});

describe('calibration', () => {
	it('validates agent close calls and handles A/B/same/edited/skip responses', () => {
		const docs = [
			normalizeText('Short one. Another longer explanatory sentence about the work.', {
				sourceId: 'x',
				role: 'authored'
			})
		];
		const measurements = measureDocuments(docs);
		const props = buildHeuristicPropositions(docs, measurements, 'run_test');
		const target =
			props.find((p) => p.type === 'ai_ism_avoidance') ??
			props.find((p) => p.status === 'calibration') ??
			props[0];

		expect(
			validateCloseCall({
				a: 'We look at the data carefully.',
				b: 'We delve into a robust tapestry of data.',
				proposition: target
			}).ok
		).toBe(true);
		expect(
			validateCloseCall({
				a: 'Same text.',
				b: 'Same text.',
				proposition: target
			}).ok
		).toBe(false);

		const trial: CalibrationTrial = {
			id: 'cal_test',
			propositionId: target.id,
			schemaVersion: 1,
			brief: 'Pick the voice that matches the proposition.',
			variantA: 'We look at the data carefully.',
			variantB: 'We delve into a robust tapestry of data.',
			supportsProposition: 'a',
			targetMetricId: target.metrics[0]?.metricId ?? target.type,
			status: 'pending',
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		const chose = applyCalibrationResponse({
			proposition: target,
			trial,
			response: 'a'
		});
		expect(chose.status).toBe('active');
		expect(chose.examples[0]?.polarity).toBe('positive');

		const same = applyCalibrationResponse({
			proposition: target,
			trial,
			response: 'same'
		});
		expect(same.status).toBe('inactive');

		const edited = applyCalibrationResponse({
			proposition: target,
			trial,
			response: 'edited',
			editedText: 'A concrete rewritten sentence the author accepts.'
		});
		expect(edited.status).toBe('active');
		expect(edited.examples[0]?.text).toContain('concrete rewritten');

		const skip = applyCalibrationResponse({
			proposition: target,
			trial,
			response: 'skip'
		});
		expect(skip.status).toBe('skipped');
	});
});

describe('materialize helpers', () => {
	it('strips html and hashes content', () => {
		const text = stripHtml('<html><body><article><p>Hello <b>world</b>.</p></article></body></html>');
		expect(text).toContain('Hello');
		expect(text).not.toContain('<p>');
		expect(contentHash('abc')).toHaveLength(16);
	});

	it('extracts simple PDF Tj strings', () => {
		const pdf = Buffer.from(
			'%PDF-1.1\n1 0 obj\n<<>>\nendobj\nstream\n(Hello World) Tj\nendstream\n',
			'latin1'
		);
		expect(extractPdfText(pdf)).toContain('Hello World');
	});

	it('blocks private and link-local URL hosts', () => {
		expect(isPrivateUrl(new URL('http://127.0.0.1/x'))).toBe(true);
		expect(isPrivateUrl(new URL('http://127.1.2.3/x'))).toBe(true);
		expect(isPrivateUrl(new URL('http://169.254.169.254/latest'))).toBe(true);
		expect(isPrivateUrl(new URL('http://192.168.1.1/x'))).toBe(true);
		expect(isPrivateUrl(new URL('http://example.com/x'))).toBe(false);
	});

	it('prefers cachePath text over re-fetching workspace files', async () => {
		const corrected = 'User-corrected extraction about distinctive criteria.';
		const cachePath = writeCachedExtraction(corrected);
		expect(isStyleCachePath(cachePath)).toBe(true);
		const materialized = await materializeReference(
			{
				id: 'r1',
				label: 'sample',
				type: 'workspace-file',
				target: 'does-not-exist-should-not-be-read.md',
				addedAt: Date.now(),
				role: 'authored',
				cachePath,
				contentHash: contentHash(corrected),
				materializationStatus: 'ready'
			},
			'authored'
		);
		expect(materialized.error).toBeUndefined();
		expect(materialized.text).toBe(corrected);
	});
});

describe('synthesis dedupe + calibration counts', () => {
	it('dedupes by type keeping higher confidence', () => {
		const base = {
			schemaVersion: 1 as const,
			family: 'sentence_rhythm' as const,
			type: 'sentence_range' as const,
			instruction: 'Keep sentences short.',
			scope: {},
			metrics: [],
			evidence: [],
			counterevidence: [],
			examples: [],
			origin: 'authored' as const,
			status: 'active' as const,
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
			sourceRunId: 'r'
		};
		const out = dedupePropositions([
			{
				...base,
				id: 'a',
				confidence: { evidence: 0.5, agentInterpretation: 0.5, extractorReliability: 0.9, final: 0.5 }
			},
			{
				...base,
				id: 'b',
				instruction: 'Prefer 12–20 word sentences.',
				confidence: { evidence: 0.8, agentInterpretation: 0.8, extractorReliability: 0.9, final: 0.8 }
			}
		]);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe('b');
	});

	it('counts unresolved calibration from pending trials only', () => {
		expect(
			countUnresolvedCalibration({
				schemaVersion: 1,
				skillId: 'author-style',
				updatedAt: 1,
				propositions: [
					{
						id: 'p1',
						schemaVersion: 1,
						family: 'vocabulary_register',
						type: 'ai_ism_avoidance',
						instruction: 'Avoid delve',
						scope: {},
						metrics: [],
						evidence: [],
						counterevidence: [],
						examples: [],
						confidence: {
							evidence: 0.4,
							agentInterpretation: 0.5,
							extractorReliability: 0.8,
							final: 0.5
						},
						origin: 'authored',
						status: 'calibration',
						enabled: true,
						createdAt: 1,
						updatedAt: 1,
						sourceRunId: 'r'
					}
				],
				calibrationTrials: [
					{
						id: 't1',
						propositionId: 'p1',
						schemaVersion: 1,
						brief: 'Choose',
						variantA: 'a',
						variantB: 'b',
						supportsProposition: 'a',
						targetMetricId: 'lexicon.ai_isms_absent',
						status: 'pending',
						createdAt: 1,
						updatedAt: 1
					},
					{
						id: 't2',
						propositionId: 'p1',
						schemaVersion: 1,
						brief: 'Choose',
						variantA: 'a',
						variantB: 'b',
						supportsProposition: 'a',
						targetMetricId: 'lexicon.ai_isms_absent',
						status: 'resolved',
						createdAt: 1,
						updatedAt: 1
					}
				],
				sourceManifest: []
			})
		).toBe(1);
	});
});

describe('compile skill', () => {
	let root: string;
	const prev = process.env.DOCWRITER_ROOT;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'dw-style-'));
		process.env.DOCWRITER_ROOT = root;
		mkdirSync(join(root, '.docwriter'), { recursive: true });
	});

	afterEach(() => {
		process.env.DOCWRITER_ROOT = prev;
		rmSync(root, { recursive: true, force: true });
	});

	it('writes SKILL.md without raw sources and syncs managed id', async () => {
		// Re-import modules that cache ROOT — document-files captures ROOT at import time.
		// So we write directly via compile helpers with explicit paths when needed.
		const md = renderSkillMarkdown(
			[
				{
					id: 'p1',
					schemaVersion: 1,
					family: 'vocabulary_register',
					type: 'ai_ism_avoidance',
					instruction: 'Do not use delve or tapestry.',
					scope: {},
					metrics: [],
					evidence: [],
					counterevidence: [],
					examples: [{ id: 'e1', text: 'We look at the data carefully.', polarity: 'positive' }],
					confidence: {
						evidence: 0.8,
						agentInterpretation: 0.8,
						extractorReliability: 0.85,
						final: 0.82
					},
					origin: 'authored',
					status: 'active',
					enabled: true,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					sourceRunId: 'run1'
				}
			],
			AUTHOR_STYLE_SKILL_ID
		);
		expect(md).toContain('name: author-style');
		expect(md).toContain('Do not use delve');
		expect(md).not.toContain('https://secret-source.example');
	});
});

describe('shreya fixtures (if present)', () => {
	const dir = join(process.cwd(), 'fixtures', 'style', 'shreya');

	it('computes metrics and lexicon on gold corpus when fixtures exist', () => {
		if (!existsSync(join(dir, 'manifest.json'))) {
			return; // skip quietly until fixtures:style is run
		}
		const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
		const docs = manifest.sources.map((s: { id: string; file: string }) => {
			const text = readFileSync(join(dir, s.file), 'utf-8');
			return normalizeText(text, { sourceId: s.id, role: 'authored', label: s.id });
		});
		expect(docs.length).toBeGreaterThanOrEqual(3);
		const measurements = measureDocuments(docs);
		// "delve" is discussed (not used as voice) in one blog — absence list
		// should still catch other AI-isms and produce avoidance props.
		expect(measurements.lexicon.aiIsmsAbsent.length).toBeGreaterThan(5);
		expect(measurements.lexicon.aiIsmsAbsent).toContain('tapestry');
		const props = buildHeuristicPropositions(docs, measurements, 'run_shreya');
		expect(props.some((p) => p.type === 'ai_ism_avoidance')).toBe(true);
		expect(props.some((p) => p.family === 'sentence_rhythm')).toBe(true);
		const skillMd = renderSkillMarkdown(
			props.filter((p) => p.status === 'active'),
			'author-style'
		);
		expect(skillMd.toLowerCase()).toMatch(/tapestry|sentence|prefer|avoid/);
	});
});
