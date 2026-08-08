// @ts-nocheck
import { createRequire } from 'node:module';
import { PUNCTUATION_METRIC_IDS } from './style-metric-registry.mjs';
import STYLE_DATA from './style-data.json' with { type: 'json' };

let nlp = null;
try {
	const loaded = createRequire(import.meta.url)('compromise');
	nlp = loaded.default ?? loaded;
} catch {
	// Downloaded skills keep the analyzer portable. In DocWriter, compromise is
	// installed and this branch is not used; outside it, T1 metrics still work.
}

const set = (value) => new Set(value.trim().split(/\s+/));
if (Object.keys(STYLE_DATA.concreteness ?? {}).length < 39000) throw new Error('Style concreteness data is incomplete');
if ((STYLE_DATA.commonWords ?? []).length < 5000) throw new Error('Style common word data is incomplete');
if ((STYLE_DATA.idioms ?? []).length < 500) throw new Error('Style idiom data is incomplete');

const FUNCTION_WORDS = set('a an and are as at be because been but by for from had has have he her hers his i if in is it its me mine my of on or our ours she so than that the their theirs them they this those to was we were what when which who whom whose why will with you your yours');
const CONTENT_STOP = new Set([...FUNCTION_WORDS, 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'would']);
const COMMON_WORDS = new Set(STYLE_DATA.commonWords);
const PRONOUNS = set('i me my mine we us our ours you your yours he she it they him her them his its their theirs this that these those');
const PREPOSITIONS = set('of in on at for from by with to into through between among about against under over after before during without within across around near');
const ARTICLES = set('a an the');
const MODALS = set('can could may might must shall should will would');
const HEDGES = set('perhaps possibly probably likely roughly approximately generally usually often sometimes seems appears apparently arguably relatively somewhat virtually largely mostly presumably tends tend suggest suggests');
const BOOSTERS = set('clearly obviously definitely certainly undoubtedly strongly completely entirely extremely always never every indeed plainly absolutely surely');
const COLLOQUIAL = ['gonna', 'wanna', 'kinda', 'sorta', 'stuff', 'thing', 'things', 'bunch', 'pretty much', 'a lot', 'lots of', 'you know', 'kind of', 'sort of'];
const EVALUATIVE = set('good bad important interesting great terrible useful poor excellent awful valuable effective ineffective significant remarkable compelling weak strong elegant problematic impressive unfortunate desirable undesirable better worse best worst');
const SENTIMENT_WORDS = new Set(Object.keys(STYLE_DATA.sentiment));
const IDIOMS = STYLE_DATA.idioms;
const IDIOMS_BY_LENGTH = new Map();
for (const idiom of IDIOMS) {
	const length = idiom.split(/\s+/).length;
	if (!IDIOMS_BY_LENGTH.has(length)) IDIOMS_BY_LENGTH.set(length, new Set());
	IDIOMS_BY_LENGTH.get(length).add(idiom);
}
const INTENSIFIERS = set('very extremely highly remarkably really particularly especially deeply totally absolutely incredibly exceptionally quite so');
const STANCE_ADVERBS = set('certainly obviously clearly frankly honestly importantly interestingly surprisingly notably unfortunately admittedly apparently arguably presumably fortunately ideally naturally plainly reportedly supposedly');
const STATIVE = set('be am is are was were been being have has had seem seems seemed know knows knew believe believes believed want wants wanted need needs needed like likes liked belong belongs contain contains consist consists exist exists matter matters own owns prefer prefers remember remembers understand understands mean means love loves hate hates');
const FACTIVE = set('know knows knew realize realizes realized regret regrets regretted discover discovers discovered show shows showed demonstrate demonstrates demonstrated prove proves proved establish establishes established reveal reveals revealed');
const NONFACTIVE = set('believe believes believed think thinks thought assume assumes assumed suspect suspects suspected claim claims claimed suppose supposes supposed');
const LY_EXCEPTIONS = set('only family early apply supply reply likely lovely friendly lonely lively costly ugly daily weekly monthly yearly');
const SUBORDINATORS = set('because although while whereas if when since unless until before after where though once whenever wherever as');
const COORDINATORS = set('and but or yet so nor');
const RELATIVE = set('who whom whose which that');
const COMPLEMENT_VERBS = set('show shows showed argue argues argued suggest suggests suggested believe believes believed know knows knew find finds found say says said note notes noted report reports reported state states stated');
const IRREGULAR_PP = set('been begun broken brought built bought caught chosen come done drawn driven eaten fallen felt found given gone grown heard held kept known left lost made met paid read run said seen sent shown spoken taken taught thought told understood won written');
const REPORTING_ASSERTIVE = set('show shows showed demonstrate demonstrates demonstrated prove proves proved establish establishes established reveal reveals revealed find finds found');
const REPORTING_DISCOURSE = set('argue argues argued claim claims claimed propose proposes proposed suggest suggests suggested contend contends contended');
const REPORTING_TENTATIVE = set('note notes noted observe observes observed report reports reported state states stated mention mentions mentioned');
const CONNECTIVES = {
	additive: ['and', 'also', 'moreover', 'furthermore', 'in addition', 'besides', 'likewise', 'similarly'],
	adversative: ['but', 'however', 'yet', 'nevertheless', 'nonetheless', 'instead', 'on the other hand', 'in contrast', 'whereas', 'although', 'though', 'despite', 'still', 'rather'],
	causal: ['because', 'therefore', 'thus', 'consequently', 'hence', 'as a result', 'so', 'since', 'accordingly', 'for this reason'],
	temporal: ['then', 'next', 'first', 'second', 'finally', 'meanwhile', 'subsequently', 'previously', 'before', 'after', 'during', 'while', 'once', 'now', 'at this point']
};
const LINKING_OPENERS = ['however', 'therefore', 'moreover', 'furthermore', 'instead', 'nevertheless', 'nonetheless', 'similarly', 'likewise', 'consequently', 'meanwhile', 'finally', 'first', 'second', 'in addition', 'in contrast', 'as a result'];

const CONCRETENESS = new Map(Object.entries(STYLE_DATA.concreteness));
const BACKGROUND_NGRAMS = new Map(Object.entries(STYLE_DATA.backgroundNgrams));
const BACKGROUND_NGRAM_TOTAL = Number(STYLE_DATA.backgroundTokenCount ?? 0) * 3;

const lower = (value) => String(value ?? '').toLocaleLowerCase();
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sd = (values) => {
	const average = mean(values);
	return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0;
};
const countWords = (text) => [...String(text).matchAll(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu)].map((match) => lower(match[0]));
const phraseCount = (text, phrase) => [...lower(text).matchAll(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'g'))].length;
const lexiconCount = (text, values) => [...values].reduce((sum, value) => sum + phraseCount(text, value), 0);
const setCount = (items, values) => items.filter((item) => values.has(item)).length;
const rate = (count, total) => total ? count * 1000 / total : 0;
const share = (count, total) => total ? count / total : 0;

function idiomCount(text) {
	const items = countWords(text);
	let count = 0;
	for (const [length, idioms] of IDIOMS_BY_LENGTH) {
		for (let index = 0; index + length <= items.length; index += 1) {
			if (idioms.has(items.slice(index, index + length).join(' '))) count += 1;
		}
	}
	return count;
}

function syllables(word) {
	const cleaned = lower(word).replace(/[^a-z]/g, '');
	if (!cleaned) return 0;
	return Math.max(1, cleaned.replace(/e$/, '').match(/[aeiouy]+/g)?.length ?? 0);
}

function morphemes(word) {
	let rest = lower(word);
	let count = 1;
	for (const prefix of ['anti', 'auto', 'counter', 'dis', 'inter', 'mis', 'non', 'over', 'pre', 're', 'sub', 'trans', 'un', 'under']) {
		if (rest.length > prefix.length + 3 && rest.startsWith(prefix)) { count += 1; rest = rest.slice(prefix.length); break; }
	}
	for (const suffix of ['ization', 'ational', 'fulness', 'ousness', 'ability', 'ibility', 'tion', 'sion', 'ment', 'ness', 'ity', 'able', 'ible', 'ful', 'less', 'ship', 'ism', 'ist', 'ize', 'ise', 'ing', 'edly', 'ed', 'ly']) {
		if (rest.length > suffix.length + 2 && rest.endsWith(suffix)) { count += 1; break; }
	}
	return count;
}

function lemma(word) {
	const value = lower(word);
	if (value.length > 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
	if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3).replace(/(.)\1$/, '$1');
	if (value.length > 4 && value.endsWith('ed')) return value.slice(0, -2).replace(/(.)\1$/, '$1');
	if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2);
	if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
	return value;
}

let posTagRuns = 0;

export function resetPosTagRunCount() {
	posTagRuns = 0;
}

export function getPosTagRunCount() {
	return posTagRuns;
}

function tagsFor(text) {
	posTagRuns += 1;
	if (!nlp) {
		const terms = countWords(text).map((word, index) => {
			const tags = new Set();
			if (PRONOUNS.has(word)) tags.add('Pronoun');
			else if (PREPOSITIONS.has(word)) tags.add('Preposition');
			else if (ARTICLES.has(word)) tags.add('Determiner');
			else if (MODALS.has(word)) tags.add('Modal');
			else if (/ly$/.test(word) && !LY_EXCEPTIONS.has(word)) tags.add('Adverb');
			else if (/(?:ous|ful|ive|able|ible|al|ic|less|ary)$/.test(word)) tags.add('Adjective');
			else if (/(?:ed|ing|ize|ise)$/.test(word) || STATIVE.has(word)) tags.add('Verb');
			else tags.add('Noun');
			return { text: word, tags, chunk: tags.has('Verb') ? 'Verb' : tags.has('Noun') ? 'Noun' : null, index };
		});
		return { terms, nounPhrases: [], verbPhrases: [] };
	}
	const document = nlp(text);
	const termFor = (term) => ({
		text: lower(term.text ?? term.normal ?? ''),
		tags: new Set(Array.isArray(term.tags) ? term.tags : Object.keys(term.tags ?? {})),
		chunk: term.chunk ?? null,
		index: Array.isArray(term.index) ? term.index[1] : -1
	});
	const terms = document.terms().json()
		.flatMap((row) => (Array.isArray(row.terms) ? row.terms : [row]))
		.map(termFor).filter((term) => term.text);
	const nounPhrases = document.nouns().json().map((phrase) => ({
		text: phrase.text,
		terms: (phrase.terms ?? []).map(termFor),
		adjectives: phrase.noun?.adjectives ?? []
	}));
	const verbPhrases = document.verbs().json().map((phrase) => ({
		text: phrase.text,
		terms: (phrase.terms ?? []).map(termFor),
		auxiliary: lower(phrase.verb?.auxiliary ?? '')
	}));
	return { terms, nounPhrases, verbPhrases };
}

function hasTag(term, ...tags) {
	return tags.some((tag) => term.tags.has(tag));
}

function ngrams(items, min = 2, max = 4) {
	const counts = new Map();
	for (let size = min; size <= max; size += 1) {
		for (let index = 0; index + size <= items.length; index += 1) {
			const slice = items.slice(index, index + size);
			if (slice.every((word) => FUNCTION_WORDS.has(word))) continue;
			const key = slice.join(' ');
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}

function corpusNgrams(documents) {
	const counts = new Map();
	let positions = 0;
	for (const document of documents) {
		for (const paragraph of document.paragraphs) {
			const items = countWords(paragraph.text);
			for (const [phrase, count] of ngrams(items)) counts.set(phrase, (counts.get(phrase) ?? 0) + count);
			for (let size = 2; size <= 4; size += 1) positions += Math.max(0, items.length - size + 1);
		}
	}
	return { counts, positions };
}

export function rankSignatureNgrams(documents, limit = 60) {
	const { counts, positions } = corpusNgrams(documents);
	const priorScale = 0.01;
	const alphaTotal = (BACKGROUND_NGRAM_TOTAL + BACKGROUND_NGRAMS.size * 0.5) * priorScale;
	return [...counts]
		.filter(([, count]) => count >= 2)
		.map(([phrase, count]) => {
			const background = Number(BACKGROUND_NGRAMS.get(phrase) ?? 0);
			const alpha = (background + 0.5) * priorScale;
			const corpusOther = Math.max(1, positions - count + alphaTotal - alpha);
			const backgroundOther = Math.max(1, BACKGROUND_NGRAM_TOTAL - background + alphaTotal - alpha);
			const delta = Math.log((count + alpha) / corpusOther) - Math.log((background + alpha) / backgroundOther);
			const variance = 1 / (count + alpha) + 1 / (background + alpha);
			return { phrase, count, score: delta / Math.sqrt(variance) };
		})
		.sort((left, right) => right.score - left.score || right.count - left.count || left.phrase.localeCompare(right.phrase))
		.slice(0, limit);
}

export function computeCorpusStyleMetrics(documents) {
	const corpusWords = documents.flatMap((document) => document.tokens
		.filter((token) => token.kind === 'word')
		.map((token) => token.normalized));
	const frequencies = new Map();
	for (const word of corpusWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
	const rankedSignatures = rankSignatureNgrams(documents, 500);
	const paragraphs = documents.flatMap((document) => document.paragraphs);
	const paragraphPhrases = paragraphs.map((paragraph) => new Set(ngrams(countWords(paragraph.text), 3, 4).keys()));
	const phraseParagraphCounts = new Map();
	for (const phrases of paragraphPhrases) {
		for (const phrase of phrases) phraseParagraphCounts.set(phrase, (phraseParagraphCounts.get(phrase) ?? 0) + 1);
	}
	const { counts: phraseCounts } = corpusNgrams(documents);
	return {
		hapaxRate: share([...frequencies.values()].filter((count) => count === 1).length, corpusWords.length),
		signatureNgramScore: mean(rankedSignatures.slice(0, 20).map((item) => Math.max(0, item.score))),
		recurringPhraseRate: rate([...phraseCounts.values()].filter((count) => count >= 3).length, corpusWords.length),
		crossParagraphRepetitionRate: rate([...phraseParagraphCounts.values()].filter((count) => count >= 2).length, corpusWords.length),
		signaturePhrases: rankedSignatures.map((item) => item.phrase)
	};
}

function openerClass(sentence) {
	const text = sentence.text.trim();
	const first = lower(text.match(/^["'“‘(]*([\p{L}]+)/u)?.[1]);
	if (/^(?:there\s+(?:is|are|was|were)|it\s+(?:is|was)\b)/i.test(text)) return 'existential';
	if (COORDINATORS.has(first)) return 'coordinator';
	if (SUBORDINATORS.has(first)) return 'subordinator';
	if (PREPOSITIONS.has(first)) return 'prepositional';
	if (/ing$/i.test(first)) return 'participial';
	if (['i', 'we', 'you', 'he', 'she', 'it', 'they', 'this', 'that', 'these', 'those'].includes(first) || /^["'“‘(]*\p{Lu}[\p{L}-]+/u.test(text)) return 'subject';
	if (LINKING_OPENERS.some((phrase) => lower(text).startsWith(`${phrase},`))) return 'linking';
	if (['here', 'now', 'then', 'often', 'sometimes', 'usually', 'finally'].includes(first) || /ly$/i.test(first)) return 'adverbial';
	return 'other';
}

function listShares(text) {
	const lengths = [];
	for (const sentence of String(text).split(/(?<=[.!?])\s+/)) {
		const commaParts = sentence.split(/,\s+/);
		if (commaParts.length >= 2 && /\b(?:and|or)\b/i.test(commaParts.at(-1) ?? '')) lengths.push(commaParts.length);
		else if (/\b[^,.;]+\s+(?:and|or)\s+[^,.;]+/.test(sentence)) lengths.push(2);
	}
	return {
		two: share(lengths.filter((length) => length === 2).length, lengths.length),
		three: share(lengths.filter((length) => length === 3).length, lengths.length),
		fourPlus: share(lengths.filter((length) => length >= 4).length, lengths.length)
	};
}

function adjacentOverlap(sentences) {
	const values = [];
	for (let index = 1; index < sentences.length; index += 1) {
		const left = new Set(countWords(sentences[index - 1].text).filter((word) => !CONTENT_STOP.has(word)).map(lemma));
		const right = new Set(countWords(sentences[index].text).filter((word) => !CONTENT_STOP.has(word)).map(lemma));
		const union = new Set([...left, ...right]);
		values.push(union.size ? [...left].filter((word) => right.has(word)).length / union.size : 0);
	}
	return mean(values);
}

function repeatedOpeningRate(items, getText) {
	const openings = items.map((item) => countWords(getText(item)).slice(0, 2).join(' ')).filter((value) => value.split(' ').length === 2);
	const counts = new Map(openings.map((value) => [value, openings.filter((other) => other === value).length]));
	return share(openings.filter((value) => (counts.get(value) ?? 0) > 1).length, openings.length);
}

export function computeStyleMetrics(document, punctuation, support = {}) {
	// This is the single POS pass for the document; every T2 metric below shares it.
	const syntax = tagsFor(document.text);
	const tagged = syntax.terms;
	const wordTokens = document.tokens.filter((token) => token.kind === 'word');
	const words = wordTokens.map((token) => token.normalized);
	const total = words.length;
	const sentences = document.sentences;
	const sentenceTotal = Math.max(1, sentences.length);
	const paragraphs = document.paragraphs;
	const content = words.filter((word) => !CONTENT_STOP.has(word) && word.length > 2);
	const nouns = tagged.filter((term) => hasTag(term, 'Noun', 'ProperNoun'));
	const adjectives = tagged.filter((term) => hasTag(term, 'Adjective'));
	const verbs = tagged.filter((term) => hasTag(term, 'Verb', 'Copula', 'Modal'));
	const adverbs = tagged.filter((term) => hasTag(term, 'Adverb'));
	const prepositions = tagged.filter((term) => hasTag(term, 'Preposition'));
	const articles = tagged.filter((term) => hasTag(term, 'Determiner')).filter((term) => ARTICLES.has(term.text));
	const pronouns = tagged.filter((term) => hasTag(term, 'Pronoun'));
	const interjections = tagged.filter((term) => hasTag(term, 'Interjection'));
	const sentenceLengths = sentences.map((sentence) => sentence.wordCount);
	const clauseCounts = sentences.map((sentence) => sentence.clauseIds.length);
	const corpus = support.corpus ?? computeCorpusStyleMetrics([document]);
	const contentFrequencies = new Map(content.map((word) => [word, content.filter((other) => other === word).length]));
	const concreteValues = content.map((word) => CONCRETENESS.get(word)).filter((value) => typeof value === 'number');
	const connectiveCounts = Object.fromEntries(Object.entries(CONNECTIVES).map(([key, values]) => [key, lexiconCount(document.text, values)]));
	const allConnectives = Object.values(connectiveCounts).reduce((sum, value) => sum + value, 0);
	const conjunctionCount = setCount(words, new Set([...COORDINATORS, ...SUBORDINATORS]));
	const subordinatorCount = setCount(words, SUBORDINATORS);
	const coordinatorCount = setCount(words, COORDINATORS);
	const openerCounts = new Map();
	for (const sentence of sentences) {
		const kind = openerClass(sentence);
		openerCounts.set(kind, (openerCounts.get(kind) ?? 0) + 1);
	}
	const lists = listShares(document.text);
	const paragraphContent = paragraphs.map((paragraph) => new Set(countWords(paragraph.text)
		.filter((word) => !CONTENT_STOP.has(word)).map(lemma)));
	const paragraphSpread = new Map();
	paragraphContent.forEach((items) => items.forEach((word) => paragraphSpread.set(word, (paragraphSpread.get(word) ?? 0) + 1)));
	const lexicalChains = [...paragraphSpread.values()].filter((count) => count >= 3).length;
	const terminal = (name) => punctuation.filter((item) => item.metricId === `grammatical.punct.terminal.${name}`).length;
	const terminalTotal = ['period', 'question', 'exclamation', 'ellipsis'].reduce((sum, name) => sum + terminal(name), 0);
	const parenthesisPairs = punctuation.filter((item) => item.metricId === 'grammatical.punct.enclosure.parenthesis-open').length;
	const emDashes = punctuation.filter((item) => item.metricId === 'grammatical.punct.boundary.em-dash').length;
	const spec = {};
	const put = (id, value) => { spec[id] = Number.isFinite(value) ? value : 0; };

	// A — Lexis
	put('lexical.a1.morphological-complexity', mean(content.map(morphemes)));
	put('lexical.a1.syllables-per-word', mean(words.map(syllables)));
	put('lexical.a1.word-characters', mean(wordTokens.map((token) => token.text.length)));
	put('lexical.a1.long-word-rate', share(words.filter((word) => syllables(word) >= 3).length, total));
	put('lexical.a1.contraction-per-1000', rate(wordTokens.filter((token) => /['’]/.test(token.text)).length, total));
	const formalClasses = nouns.length + adjectives.length + prepositions.length + articles.length;
	const contextualClasses = pronouns.length + verbs.length + adverbs.length + interjections.length;
	put('lexical.a1.formality-score', 50 * (formalClasses - contextualClasses) / Math.max(1, tagged.length) + 50);
	put('lexical.a1.colloquial-marker-per-1000', rate(lexiconCount(document.text, COLLOQUIAL), total));
	put('lexical.a1.evaluative-per-1000', rate(setCount(words, EVALUATIVE), total));
	put('lexical.a1.concreteness-mean', mean(concreteValues));
	put('lexical.a1.rare-word-rate', share(content.filter((word) => !COMMON_WORDS.has(word)).length, content.length));
	put('lexical.a1.sentiment-word-per-1000', rate(setCount(words, SENTIMENT_WORDS), total));
	put('lexical.a1.idiom-per-1000', rate(idiomCount(document.text), total));
	put('lexical.a1.hapax-rate', corpus.hapaxRate);
	put('lexical.a1.abbreviation-per-1000', support.abbreviationPer1000 ?? rate((document.text.match(/\b(?:[A-Z]{2,}|(?:[A-Z]\.){2,})\b/g) ?? []).length, total));
	put('lexical.a1.hyphenated-compound-per-1000', rate((document.text.match(/\b[\p{L}]+-[\p{L}]+\b/gu) ?? []).length, total));
	put('lexical.a1.nominalization-per-1000', rate(words.filter((word) => /(?:tion|sion|ment|ness|ity)$/.test(word)).length, total));
	put('lexical.a1.mattr', support.mattr ?? 0);
	put('lexical.a1.lexical-density', share(content.length, total));
	put('lexical.a1.repeated-content-share', share(Math.max(0, ...contentFrequencies.values()), content.length));
	put('lexical.a1.signature-ngrams', corpus.signatureNgramScore);
	put('lexical.a2.abstract-noun-rate', share(nouns.filter((term) => /(?:tion|sion|ment|ness|ity|ism)$/.test(term.text)).length, nouns.length));
	put('lexical.a2.proper-noun-per-1000', rate(sentences.reduce((sum, sentence) => sum + (sentence.text.match(/(?<!^)\b\p{Lu}[\p{L}-]+\b/gu) ?? []).length, 0), total));
	put('lexical.a2.proper-noun-per-1000-tagged', rate(tagged.filter((term) => hasTag(term, 'ProperNoun', 'Person', 'Place', 'Organization')).length, total));
	put('lexical.a3.adjective-rate', share(adjectives.length, tagged.length));
	put('lexical.a3.intensifier-per-1000', rate(setCount(words, INTENSIFIERS), total));
	const attributiveAdjectives = syntax.nounPhrases.reduce((sum, phrase) => sum + phrase.terms.filter((term, index) =>
		hasTag(term, 'Adjective') && phrase.terms.slice(index + 1).some((next) => hasTag(next, 'Noun', 'ProperNoun'))
	).length, 0);
	put('lexical.a3.attributive-rate', share(attributiveAdjectives, adjectives.length));
	const stativeCount = setCount(words, STATIVE);
	const factiveCount = setCount(words, FACTIVE);
	const nonFactiveCount = setCount(words, NONFACTIVE);
	put('lexical.a4.stative-verb-share', share(stativeCount, verbs.length));
	const transitiveVerbs = tagged.filter((term, index) => {
		if (!hasTag(term, 'Verb') || hasTag(term, 'Copula', 'Auxiliary')) return false;
		let cursor = index + 1;
		while (cursor < tagged.length && tagged[cursor].chunk === 'Verb') cursor += 1;
		return cursor < tagged.length
			&& !hasTag(tagged[cursor], 'Preposition')
			&& (tagged[cursor].chunk === 'Noun' || hasTag(tagged[cursor], 'Pronoun'));
	}).length;
	put('lexical.a4.transitive-rate', share(transitiveVerbs, verbs.filter((term) => !hasTag(term, 'Copula', 'Auxiliary')).length));
	put('lexical.a4.factive-verb-rate', share(factiveCount, factiveCount + nonFactiveCount));
	put('lexical.a5.ly-adverb-per-1000', rate(words.filter((word) => /ly$/.test(word) && !LY_EXCEPTIONS.has(word)).length, total));
	put('lexical.a5.adverb-rate', share(adverbs.length, tagged.length));
	put('lexical.a5.discourse-marker-per-1000', rate(allConnectives, total));
	put('lexical.a5.stance-adverb-per-1000', rate(setCount(words, STANCE_ADVERBS), total));
	put('lexical.a5.hedge-per-1000', rate(setCount(words, HEDGES), total));
	put('lexical.a5.booster-per-1000', rate(setCount(words, BOOSTERS), total));

	// B — Grammar
	put('grammatical.b1.question-rate', terminal('question') / sentenceTotal);
	put('grammatical.b1.imperative-signal-rate', sentences.filter((sentence) => /^(?:use|write|keep|avoid|choose|add|remove|make|run|check|set|start|end|explain|show|state)\b/i.test(sentence.text)).length / sentenceTotal);
	put('grammatical.b1.exclamation-rate', terminal('exclamation') / sentenceTotal);
	put('grammatical.b1.fragment-rate', sentences.filter((sentence) => sentence.wordCount <= 4 && !/[.!?]\s*$/.test(sentence.text)).length / sentenceTotal);
	for (const name of ['period', 'question', 'exclamation', 'ellipsis']) put(`grammatical.b1.terminal.${name}`, share(terminal(name), terminalTotal));
	put('grammatical.b2.clauses-per-sentence', mean(clauseCounts));
	put('grammatical.b2.words-mean', mean(sentenceLengths));
	put('grammatical.b2.words-median', support.sentenceWords?.median ?? 0);
	put('grammatical.b2.words-p10', support.sentenceWords?.p10 ?? 0);
	put('grammatical.b2.words-p90', support.sentenceWords?.p90 ?? 0);
	put('grammatical.b2.subordination-ratio', share(subordinatorCount, subordinatorCount + coordinatorCount));
	put('grammatical.b2.length-variation', mean(sentenceLengths) ? sd(sentenceLengths) / mean(sentenceLengths) : 0);
	put('grammatical.b2.consecutive-length-difference', mean(sentenceLengths.slice(1).map((value, index) => Math.abs(value - sentenceLengths[index]))));
	put('grammatical.b2.short-long-alternation-rate', sentenceLengths.length > 1 ? sentenceLengths.slice(1).filter((value, index) => (value <= 8) !== (sentenceLengths[index] <= 8)).length / (sentenceLengths.length - 1) : 0);
	put('grammatical.b2.coordination-per-1000', rate(coordinatorCount, total));
	put('grammatical.b2.subordination-per-1000', rate(subordinatorCount, total));
	put('grammatical.b2.semicolon-per-1000', rate(punctuation.filter((item) => item.metricId === 'grammatical.punct.boundary.semicolon').length, total));
	put('grammatical.b2.parataxis-rate', share(sentences.filter((sentence) => /;/.test(sentence.text) || (sentence.clauseIds.length > 1 && !/\b(?:and|but|or|yet|so|because|although|while|whereas)\b/i.test(sentence.text))).length, sentenceTotal));
	put('grammatical.b2.short-sentence-rate', sentences.filter((sentence) => sentence.wordCount <= 8).length / sentenceTotal);
	put('grammatical.b2.long-sentence-rate', sentences.filter((sentence) => sentence.wordCount >= 30).length / sentenceTotal);
	put('grammatical.b3.relative-pronoun-per-1000', rate(setCount(words, RELATIVE), total));
	put('grammatical.b3.adverbial-clause-opener-rate', sentences.filter((sentence) => SUBORDINATORS.has(lower(countWords(sentence.text)[0]))).length / sentenceTotal);
	put('grammatical.b3.that-complement-per-1000', rate((document.text.match(new RegExp(`\\b(?:${[...COMPLEMENT_VERBS].join('|')})\\s+that\\b`, 'gi')) ?? []).length, total));
	put('grammatical.b3.wh-complement-per-1000', rate(tagged.filter((term, index) =>
		['what', 'how', 'why', 'whether'].includes(term.text) && hasTag(tagged[index - 1] ?? { tags: new Set() }, 'Verb')
	).length, total));
	put('grammatical.b3.ing-opener-rate', sentences.filter((sentence) => /^(?!According\b)\p{L}+ing\b/iu.test(sentence.text)).length / sentenceTotal);
	put('grammatical.b3.ed-opener-rate', sentences.filter((sentence) => /^\p{L}+ed\b/iu.test(sentence.text)).length / sentenceTotal);
	put('grammatical.b3.infinitive-per-1000', rate((document.text.match(/\bto\s+(?!the\b|a\b|an\b|this\b|that\b|these\b|those\b)[a-z]+\b/g) ?? []).length, total));
	for (const kind of ['subject', 'coordinator', 'linking', 'subordinator', 'prepositional', 'participial', 'adverbial', 'existential', 'other']) put(`grammatical.b4.opener-${kind}`, share(openerCounts.get(kind) ?? 0, sentences.length));
	put('grammatical.b4.existential-there-per-1000', rate((document.text.match(/\bthere\s+(?:is|are|was|were)\b/gi) ?? []).length, total));
	put('grammatical.b4.cleft-it-per-1000', rate((document.text.match(/\bit\s+(?:is|was)\b[^.!?]{0,80}\b(?:that|to)\b/gi) ?? []).length, total));
	const determiners = set('the a an this that these those my his her its our their');
	const npWeights = words.map((word, index) => determiners.has(word) ? words.slice(index + 1).findIndex((next) => /^(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|may|might|must|will|would|should)$/.test(next)) : -1).filter((value) => value >= 0);
	put('grammatical.b5.np-weight-proxy', mean(npWeights));
	const nounPhraseWeights = syntax.nounPhrases.length
		? syntax.nounPhrases.map((item) => item.terms.length)
		: (document.text.match(/\b(?:the|a|an|this|that|these|those|my|his|her|its|our|their)(?:\s+[\p{L}-]+){1,6}/giu) ?? []).map((item) => countWords(item).length);
	put('grammatical.b5.np-weight', mean(nounPhraseWeights));
	put('grammatical.b5.postmod-of-per-1000', rate((document.text.match(/\b(?:of|in|for|with)\s+the\b/gi) ?? []).length, total));
	const heavyPremodifiers = syntax.nounPhrases.filter((phrase) => {
		const head = phrase.terms.findLastIndex((term) => hasTag(term, 'Noun', 'ProperNoun'));
		return head >= 0 && phrase.terms.slice(0, head).filter((term) => !hasTag(term, 'Determiner')).length >= 3;
	}).length;
	put('grammatical.b5.heavy-premod-rate', share(heavyPremodifiers, syntax.nounPhrases.length));
	put('grammatical.b5.appositive-per-1000', rate((document.text.match(/,\s+(?:a|an|the)\s+[\p{L}-]+/giu) ?? []).length, total));
	put('grammatical.b6.present-tense-proxy-per-1000', rate(words.filter((word) => ['am', 'is', 'are', 'has', 'have', 'do', 'does'].includes(word)).length, total));
	put('grammatical.b6.past-tense-proxy-per-1000', rate(words.filter((word) => /ed$/.test(word) || ['was', 'were', 'had', 'did'].includes(word)).length, total));
	put('grammatical.b6.future-signal-per-1000', rate((document.text.match(/\b(?:will|shall|going\s+to)\b/gi) ?? []).length, total));
	put('grammatical.b6.progressive-per-1000', rate((document.text.match(/\b(?:is|are|was|were|been)\s+\p{L}+ing\b/giu) ?? []).length, total));
	put('grammatical.b6.perfective-per-1000', rate(words.slice(1).filter((word, index) => ['has', 'have', 'had'].includes(words[index]) && (/ed$/.test(word) || IRREGULAR_PP.has(word))).length, total));
	put('grammatical.b6.modal-per-1000', rate(setCount(words, MODALS), total));
	put('grammatical.b6.passive-proxy-per-1000', rate((document.text.match(/\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/giu) ?? []).length, total));
	const passivePhrases = syntax.verbPhrases.filter((phrase) =>
		['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'].includes(phrase.auxiliary)
		&& phrase.terms.some((term) => hasTag(term, 'PastTense', 'Participle'))
	).length;
	put('grammatical.b6.passive-rate', share(passivePhrases, syntax.verbPhrases.length));
	put('grammatical.b7.preposition-per-1000', rate(setCount(words, PREPOSITIONS), total));
	put('grammatical.b8.definite-article-per-1000', rate(words.filter((word) => word === 'the').length, total));
	put('grammatical.b8.indefinite-article-per-1000', rate(words.filter((word) => word === 'a' || word === 'an').length, total));
	put('grammatical.b8.first-person-per-1000', rate(setCount(words, set('i me my mine we us our ours')), total));
	put('grammatical.b8.second-person-per-1000', rate(setCount(words, set('you your yours')), total));
	put('grammatical.b8.third-person-per-1000', rate(setCount(words, set('he she it they him her them his its their')), total));
	put('grammatical.b8.demonstrative-per-1000', rate(setCount(words, set('this that these those')), total));
	put('grammatical.b8.negative-per-1000', rate(setCount(words, set("not no never neither nor nothing nobody nowhere isn't aren't wasn't weren't don't doesn't didn't can't couldn't won't wouldn't shouldn't")), total));
	put('grammatical.b8.conjunction-per-1000', rate(conjunctionCount, total));
	put('grammatical.b9.comparative-per-1000', rate(words.filter((word) => ['more', 'less', 'better', 'worse', 'than'].includes(word) || /er$/.test(word)).length, total));
	put('grammatical.b9.superlative-per-1000', rate(words.filter((word) => ['most', 'least', 'best', 'worst'].includes(word) || /est$/.test(word)).length, total));
	put('grammatical.b9.parenthetical-per-1000', rate(parenthesisPairs, total));
	put('grammatical.b9.dash-aside-per-1000', rate(Math.floor(emDashes / 2), total));
	put('grammatical.b9.list-length-2-share', lists.two);
	put('grammatical.b9.list-length-3-share', lists.three);
	put('grammatical.b9.list-length-4plus-share', lists.fourPlus);
	const serialCommaCandidates = (document.text.match(/,[^,.;]+,\s+(?:and|or)\b/gi) ?? []).length;
	const listCandidates = (document.text.match(/,[^,.;]+\s+(?:and|or)\b/gi) ?? []).length;
	put('grammatical.b9.serial-comma-rate', share(serialCommaCandidates, listCandidates));
	for (const id of PUNCTUATION_METRIC_IDS) put(id, support.punctuationRates?.[id] ?? 0);

	// C — Figures
	put('figures.c1.anaphora-rate', mean(paragraphs.map((paragraph) => repeatedOpeningRate(sentences.filter((sentence) => paragraph.sentenceIds.includes(sentence.id)), (item) => item.text))));
	put('figures.c1.clause-anaphora-rate', repeatedOpeningRate(document.clauses, (item) => item.text));
	let taggedCursor = 0;
	const posPrefixes = sentences.map((sentence) => {
		const length = countWords(sentence.text).length;
		const prefix = tagged.slice(taggedCursor, taggedCursor + length).slice(0, 4)
			.map((term) => [...term.tags][0] ?? '').join('-');
		taggedCursor += length;
		return prefix;
	});
	put('figures.c1.structural-parallel-rate', share(posPrefixes.slice(1).filter((value, index) => value && value === posPrefixes[index]).length, Math.max(0, posPrefixes.length - 1)));
	put('figures.c1.lexical-parallel-rate', share(sentences.slice(1).filter((sentence, index) => {
		const left = new Set(countWords(sentences[index].text));
		const right = new Set(countWords(sentence.text));
		const overlap = [...left].filter((word) => right.has(word)).length / Math.max(1, new Set([...left, ...right]).size);
		return overlap >= 0.5 && overlap < 1;
	}).length, Math.max(0, sentences.length - 1)));
	put('figures.c1.recurring-phrase-rate', corpus.recurringPhraseRate);
	put('figures.c1.cross-paragraph-repetition-rate', corpus.crossParagraphRepetitionRate);
	const onset = (word) => word.match(/^[^aeiouy]+|^[aeiouy]/)?.[0] ?? '';
	put('figures.c2.alliteration-rate', share(content.slice(2).filter((word, index) =>
		onset(word) && onset(word) === onset(content[index] ?? '') && onset(word) === onset(content[index + 1] ?? '')
	).length, content.length));
	const vowel = (word) => word.match(/[aeiouy]+/)?.[0] ?? '';
	put('figures.c2.assonance-rate', share(content.slice(2).filter((word, index) =>
		vowel(word) && vowel(word) === vowel(content[index] ?? '') && vowel(word) === vowel(content[index + 1] ?? '')
	).length, content.length));
	put('figures.c3.simile-marker-per-1000', rate(lexiconCount(document.text, ['like a', 'like an', 'like the', 'as if', 'as though', 'resembles', 'reminds one of']) + (document.text.match(/\bas\s+\w+\s+as\b/gi) ?? []).length, total));
	put('figures.c3.concreteness-shift-rate', share(sentences.filter((sentence) => {
		const values = countWords(sentence.text).map((word) => CONCRETENESS.get(word)).filter((value) => typeof value === 'number');
		return values.length >= 2 && Math.max(...values) - Math.min(...values) >= 2;
	}).length, sentenceTotal));
	put('figures.c3.analogy-marker-per-1000', rate(lexiconCount(document.text, ['think of', 'imagine', 'picture', 'consider', 'suppose', 'analogous to', 'comparable to']), total));

	// D — Cohesion and context
	put('cohesion.d1.connective-per-sentence', allConnectives / sentenceTotal);
	for (const [name, count] of Object.entries(connectiveCounts)) put(`cohesion.d1.${name}-per-1000`, rate(count, total));
	put('cohesion.d1.transition-opening-rate', sentences.filter((sentence) => LINKING_OPENERS.some((phrase) => lower(sentence.text).startsWith(phrase))).length / sentenceTotal);
	put('cohesion.d1.pronoun-noun-ratio', share(pronouns.length, nouns.length));
	put('cohesion.d1.this-noun-per-1000', rate((document.text.match(/(?:^|[.!?]\s+)(?:This|These)\s+(?!is\b|are\b|was\b|were\b)[\p{L}-]+/gu) ?? []).length, total));
	put('cohesion.d1.adjacent-sentence-overlap', adjacentOverlap(sentences));
	put('cohesion.d1.lexical-chain-rate', share(lexicalChains, content.length));
	// Paragraph shape is passage-level prose, not page layout.
	for (const [suffix, value] of Object.entries(support.paragraphs ?? {})) {
		put(`cohesion.d1.${suffix}`, value);
	}
	put('cohesion.d2.second-person-per-1000', rate(setCount(words, set('you your yours')), total));
	put('cohesion.d2.question-per-1000', rate(terminal('question'), total));
	put('cohesion.d2.first-person-singular-per-1000', rate(setCount(words, set('i me my mine')), total));
	put('cohesion.d2.first-person-plural-per-1000', rate(setCount(words, set('we us our ours')), total));
	put('cohesion.d2.quote-per-1000', rate((document.text.match(/(?:"[^"\n]+"|“[^”\n]+”)/g) ?? []).length, total));
	const citationPattern = /\((?:(?:[\p{L}'’-]+(?:\s+(?:and|&|et\s+al\.?)\s+[\p{L}'’-]+)?(?:,?\s+et\s+al\.?)?),?\s*)?\d{4}[a-z]?(?:,\s*p{1,2}\.\s*[^)]+)?\)|\[[0-9,\s-]+\]|\\cite\w*\{[^}]+\}/giu;
	const citations = [...document.text.matchAll(citationPattern)];
	put('cohesion.d2.citation-per-1000', rate(citations.length, total));
	put('cohesion.d2.integral-citation-rate', share(citations.filter((match) => /\b\p{Lu}[\p{L}'’-]+\s*$/.test(document.text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0))).length, citations.length));
	put('cohesion.d2.attribution-per-1000', rate(setCount(words, new Set([...REPORTING_ASSERTIVE, ...REPORTING_DISCOURSE, ...REPORTING_TENTATIVE])), total));
	put('cohesion.d2.reporting-assertive-per-1000', rate(setCount(words, REPORTING_ASSERTIVE), total));
	put('cohesion.d2.reporting-discourse-per-1000', rate(setCount(words, REPORTING_DISCOURSE), total));
	put('cohesion.d2.reporting-tentative-per-1000', rate(setCount(words, REPORTING_TENTATIVE), total));
	put('cohesion.d2.footnote-per-1000', rate((document.text.match(/\[\^[^\]]+\]|\\footnote\{/g) ?? []).length, total));
	put('cohesion.d2.link-per-1000', rate((document.text.match(/\[[^\]]+\]\([^)]+\)|https?:\/\/\S+/g) ?? []).length, total));
	put('cohesion.d2.citation-ending-rate', share(citations.filter((match) => /[.!?]\s*$/.test(document.text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 4))).length, citations.length));
	put('cohesion.d2.citation-position', mean(citations.map((match) => (match.index ?? 0) / Math.max(1, document.text.length))));

	return { spec, wordCount: total, sentenceLengths, paragraphLengths: paragraphs.map((paragraph) => paragraph.wordCount) };
}
