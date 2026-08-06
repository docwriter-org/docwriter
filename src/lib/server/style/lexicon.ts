/**
 * Distinctive lexicon extractor: signature words/phrases + AI-ism absences.
 */
import type { NormalizedDocument } from './schemas';

/** Common English + academic boilerplate — down-weighted for signature scoring. */
export const COMMON_WORDS = new Set(
	`a an the and or but if then else when while for of to in on at by from with as is are was were be been being
	this that these those it its i you he she we they them my your our their me him her us not no nor so than too
	very can could should would may might will just also into over under again further once here there all any both
	each few more most other some such only own same do does did done have has had having get got make made use used
	using used new old first second last next previous one two three many much well way ways thing things people
	time times year years day days work works working paper papers system systems data model models method methods
	result results figure table section approach based using using using however therefore moreover furthermore
	additionally overall specifically generally typically often often also also via per each within without across
	between among against during before after about above below between through during including whether whether
	utilize utilized utilizing facilitate facilitates facilitating leverage leveraged leveraging`.split(/\s+/)
);

/** Words LLMs overuse — absence in authored text is a strong "do not use" signal. */
export const AI_OVERUSE_WORDS = [
	'delve',
	'delves',
	'delving',
	'tapestry',
	'landscape',
	'robust',
	'leverage',
	'leveraging',
	'pivotal',
	'underscore',
	'underscores',
	'showcase',
	'showcasing',
	'intricate',
	'meticulous',
	'meticulously',
	'commendable',
	'exemplary',
	'nestled',
	'beacon',
	'testament',
	'embark',
	'embarking',
	'realm',
	'realms',
	'plethora',
	'myriad',
	'utilize',
	'utilizing',
	'whilst',
	'aforementioned',
	'heretofore',
	'crucial',
	'vital',
	'seamless',
	'seamlessly',
	'innovative',
	'groundbreaking',
	'cutting-edge',
	'paradigm',
	'holistic',
	'synergy',
	'synergies',
	'unlock',
	'unleash',
	'game-changer',
	'gamechanger'
];

export type LexiconEntry = {
	term: string;
	count: number;
	documentFrequency: number;
	score: number;
	exampleSpanIds: string[];
	sourceIds: string[];
};

export type LexiconMetrics = {
	signatureWords: LexiconEntry[];
	signaturePhrases: LexiconEntry[];
	aiIsmsAbsent: string[];
	aiIsmsPresent: Array<{ term: string; count: number }>;
	lexicalDiversity: number;
	avgWordLength: number;
	contractionRatePerThousand: number;
};

function contentTokens(doc: NormalizedDocument) {
	return doc.tokens.filter((t) => !t.isStopword && t.lemma && /[a-z]/i.test(t.lemma) && t.lemma.length > 2);
}

export function computeLexiconMetrics(docs: NormalizedDocument[]): LexiconMetrics {
	const authored = docs.filter((d) => d.role === 'authored');
	const corpus = authored.length ? authored : docs;

	const wordStats = new Map<
		string,
		{ count: number; docs: Set<string>; spanIds: string[] }
	>();
	const bigramStats = new Map<
		string,
		{ count: number; docs: Set<string>; spanIds: string[] }
	>();

	let totalContent = 0;
	let totalChars = 0;
	let types = new Set<string>();
	let contractions = 0;
	let wordCount = 0;

	for (const doc of corpus) {
		const tokens = contentTokens(doc);
		const seenWords = new Set<string>();
		const seenBigrams = new Set<string>();
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			const lemma = t.lemma!;
			totalContent++;
			totalChars += lemma.length;
			types.add(lemma);
			wordCount++;
			if (/'/.test(t.text)) contractions++;

			const ws = wordStats.get(lemma) ?? { count: 0, docs: new Set(), spanIds: [] };
			ws.count++;
			ws.docs.add(doc.sourceId);
			if (ws.spanIds.length < 3) ws.spanIds.push(t.id);
			wordStats.set(lemma, ws);
			seenWords.add(lemma);

			if (i + 1 < tokens.length) {
				const next = tokens[i + 1].lemma!;
				if (COMMON_WORDS.has(lemma) && COMMON_WORDS.has(next)) continue;
				const phrase = `${lemma} ${next}`;
				const bs = bigramStats.get(phrase) ?? { count: 0, docs: new Set(), spanIds: [] };
				bs.count++;
				bs.docs.add(doc.sourceId);
				if (bs.spanIds.length < 3) bs.spanIds.push(t.id);
				bigramStats.set(phrase, bs);
				seenBigrams.add(phrase);
			}
		}
		// mark doc membership already via Sets
		void seenWords;
		void seenBigrams;
	}

	const minDf = corpus.length >= 2 ? 2 : 1;
	const signatureWords: LexiconEntry[] = [...wordStats.entries()]
		.filter(([term, s]) => s.docs.size >= minDf && !COMMON_WORDS.has(term) && !/^\d+$/.test(term))
		.map(([term, s]) => {
			const boilerplatePenalty = COMMON_WORDS.has(term) ? 0.2 : 1;
			const score = Math.log1p(s.count) * s.docs.size * boilerplatePenalty;
			return {
				term,
				count: s.count,
				documentFrequency: s.docs.size,
				score,
				exampleSpanIds: s.spanIds,
				sourceIds: [...s.docs]
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 40);

	const signaturePhrases: LexiconEntry[] = [...bigramStats.entries()]
		.filter(([, s]) => s.docs.size >= minDf && s.count >= 2)
		.map(([term, s]) => ({
			term,
			count: s.count,
			documentFrequency: s.docs.size,
			score: Math.log1p(s.count) * s.docs.size,
			exampleSpanIds: s.spanIds,
			sourceIds: [...s.docs]
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, 30);

	const presentCounts = new Map<string, number>();
	for (const doc of corpus) {
		for (const t of doc.tokens) {
			const lemma = (t.lemma ?? '').toLowerCase();
			if (AI_OVERUSE_WORDS.includes(lemma)) {
				presentCounts.set(lemma, (presentCounts.get(lemma) ?? 0) + 1);
			}
		}
	}
	const aiIsmsPresent = [...presentCounts.entries()].map(([term, count]) => ({ term, count }));
	const aiIsmsAbsent = AI_OVERUSE_WORDS.filter(
		(w) => !presentCounts.has(w) && !w.endsWith('ing') && !w.endsWith('es')
	)
		// unique stems roughly
		.filter((w, i, arr) => arr.indexOf(w) === i)
		.slice(0, 25);

	// Dedupe morphological variants in absent list by stem-ish prefix
	const absentDedup: string[] = [];
	for (const w of ['delve', 'tapestry', 'landscape', 'robust', 'leverage', 'pivotal', 'underscore', 'showcase', 'intricate', 'meticulous', 'commendable', 'realm', 'plethora', 'myriad', 'utilize', 'whilst', 'aforementioned', 'seamless', 'innovative', 'groundbreaking', 'paradigm', 'holistic', 'synergy', 'unleash']) {
		if (!presentCounts.has(w) && !presentCounts.has(w + 's') && !presentCounts.has(w + 'ing')) {
			absentDedup.push(w);
		}
	}

	return {
		signatureWords,
		signaturePhrases,
		aiIsmsAbsent: absentDedup.length ? absentDedup : aiIsmsAbsent,
		aiIsmsPresent,
		lexicalDiversity: totalContent ? types.size / totalContent : 0,
		avgWordLength: totalContent ? totalChars / totalContent : 0,
		contractionRatePerThousand: wordCount ? (contractions / wordCount) * 1000 : 0
	};
}
