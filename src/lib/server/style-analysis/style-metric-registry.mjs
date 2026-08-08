export const CHECKLIST_METRICS = {
	'a1-general': [
		'lexical.a1.morphological-complexity', 'lexical.a1.syllables-per-word', 'lexical.a1.word-characters',
		'lexical.a1.long-word-rate', 'lexical.a1.contraction-per-1000', 'lexical.a1.formality-score',
		'lexical.a1.colloquial-marker-per-1000', 'lexical.a1.evaluative-per-1000', 'lexical.a1.concreteness-mean',
		'lexical.a1.rare-word-rate', 'lexical.a1.sentiment-word-per-1000', 'lexical.a1.idiom-per-1000',
		'lexical.a1.hapax-rate', 'lexical.a1.abbreviation-per-1000', 'lexical.a1.hyphenated-compound-per-1000',
		'lexical.a1.nominalization-per-1000', 'lexical.a1.mattr', 'lexical.a1.lexical-density',
		'lexical.a1.repeated-content-share', 'lexical.a1.signature-ngrams'
	],
	'a2-nouns': ['lexical.a2.abstract-noun-rate', 'lexical.a2.proper-noun-per-1000', 'lexical.a2.proper-noun-per-1000-tagged'],
	'a3-adjectives': ['lexical.a3.adjective-rate', 'lexical.a3.intensifier-per-1000', 'lexical.a3.attributive-rate'],
	'a4-verbs': ['lexical.a4.stative-verb-share', 'lexical.a4.transitive-rate', 'lexical.a4.factive-verb-rate'],
	'a5-adverbs': [
		'lexical.a5.ly-adverb-per-1000', 'lexical.a5.adverb-rate', 'lexical.a5.discourse-marker-per-1000',
		'lexical.a5.stance-adverb-per-1000', 'lexical.a5.hedge-per-1000', 'lexical.a5.booster-per-1000'
	],
	'b1-sentence-types': [
		'grammatical.b1.question-rate', 'grammatical.b1.imperative-signal-rate', 'grammatical.b1.exclamation-rate',
		'grammatical.b1.fragment-rate', 'grammatical.b1.terminal.period', 'grammatical.b1.terminal.question',
		'grammatical.b1.terminal.exclamation', 'grammatical.b1.terminal.ellipsis'
	],
	'b2-sentence-complexity': [
		'grammatical.b2.clauses-per-sentence', 'grammatical.b2.words-mean', 'grammatical.b2.words-median',
		'grammatical.b2.words-p10', 'grammatical.b2.words-p90', 'grammatical.b2.subordination-ratio',
		'grammatical.b2.length-variation', 'grammatical.b2.consecutive-length-difference',
		'grammatical.b2.short-long-alternation-rate', 'grammatical.b2.coordination-per-1000',
		'grammatical.b2.subordination-per-1000', 'grammatical.b2.semicolon-per-1000',
		'grammatical.b2.parataxis-rate', 'grammatical.b2.short-sentence-rate', 'grammatical.b2.long-sentence-rate'
	],
	'b3-clause-types': [
		'grammatical.b3.relative-pronoun-per-1000', 'grammatical.b3.adverbial-clause-opener-rate',
		'grammatical.b3.that-complement-per-1000', 'grammatical.b3.wh-complement-per-1000',
		'grammatical.b3.ing-opener-rate', 'grammatical.b3.ed-opener-rate', 'grammatical.b3.infinitive-per-1000'
	],
	'b4-clause-structure': [
		...['subject', 'coordinator', 'linking', 'subordinator', 'prepositional', 'participial', 'adverbial', 'existential', 'other']
			.map((kind) => `grammatical.b4.opener-${kind}`),
		'grammatical.b4.existential-there-per-1000', 'grammatical.b4.cleft-it-per-1000'
	],
	'b5-noun-phrases': [
		'grammatical.b5.np-weight-proxy', 'grammatical.b5.np-weight', 'grammatical.b5.postmod-of-per-1000',
		'grammatical.b5.heavy-premod-rate', 'grammatical.b5.appositive-per-1000'
	],
	'b6-verb-phrases': [
		'grammatical.b6.present-tense-proxy-per-1000', 'grammatical.b6.past-tense-proxy-per-1000',
		'grammatical.b6.future-signal-per-1000', 'grammatical.b6.progressive-per-1000',
		'grammatical.b6.perfective-per-1000', 'grammatical.b6.modal-per-1000',
		'grammatical.b6.passive-proxy-per-1000', 'grammatical.b6.passive-rate'
	],
	'b7-other-phrases': ['grammatical.b7.preposition-per-1000'],
	'b8-function-words': [
		'grammatical.b8.definite-article-per-1000', 'grammatical.b8.indefinite-article-per-1000',
		'grammatical.b8.first-person-per-1000', 'grammatical.b8.second-person-per-1000',
		'grammatical.b8.third-person-per-1000', 'grammatical.b8.demonstrative-per-1000',
		'grammatical.b8.negative-per-1000', 'grammatical.b8.conjunction-per-1000'
	],
	'b9-general-grammar': [
		'grammatical.b9.comparative-per-1000', 'grammatical.b9.superlative-per-1000',
		'grammatical.b9.parenthetical-per-1000', 'grammatical.b9.dash-aside-per-1000',
		'grammatical.b9.list-length-2-share', 'grammatical.b9.list-length-3-share',
		'grammatical.b9.list-length-4plus-share', 'grammatical.b9.serial-comma-rate'
	],
	'c1-schemes': [
		'figures.c1.anaphora-rate', 'figures.c1.clause-anaphora-rate', 'figures.c1.structural-parallel-rate',
		'figures.c1.lexical-parallel-rate', 'figures.c1.recurring-phrase-rate', 'figures.c1.cross-paragraph-repetition-rate'
	],
	'c2-phonological': ['figures.c2.alliteration-rate', 'figures.c2.assonance-rate'],
	'c3-tropes': ['figures.c3.simile-marker-per-1000', 'figures.c3.concreteness-shift-rate', 'figures.c3.analogy-marker-per-1000'],
	'd1-cohesion': [
		'cohesion.d1.connective-per-sentence', 'cohesion.d1.additive-per-1000', 'cohesion.d1.adversative-per-1000',
		'cohesion.d1.causal-per-1000', 'cohesion.d1.temporal-per-1000', 'cohesion.d1.transition-opening-rate',
		'cohesion.d1.pronoun-noun-ratio', 'cohesion.d1.this-noun-per-1000',
		'cohesion.d1.adjacent-sentence-overlap', 'cohesion.d1.lexical-chain-rate'
	],
	'd2-context': [
		'cohesion.d2.second-person-per-1000', 'cohesion.d2.question-per-1000',
		'cohesion.d2.first-person-singular-per-1000', 'cohesion.d2.first-person-plural-per-1000',
		'cohesion.d2.quote-per-1000', 'cohesion.d2.citation-per-1000', 'cohesion.d2.integral-citation-rate',
		'cohesion.d2.attribution-per-1000', 'cohesion.d2.reporting-assertive-per-1000',
		'cohesion.d2.reporting-discourse-per-1000', 'cohesion.d2.reporting-tentative-per-1000',
		'cohesion.d2.footnote-per-1000', 'cohesion.d2.link-per-1000',
		'cohesion.d2.citation-ending-rate', 'cohesion.d2.citation-position'
	]
};

export const PUNCTUATION_METRIC_IDS = [
	...['period', 'question', 'exclamation', 'ellipsis'].map((name) => `grammatical.punct.terminal.${name}`),
	...['comma', 'semicolon', 'colon', 'em-dash', 'en-dash', 'double-hyphen'].map((name) => `grammatical.punct.boundary.${name}`),
	...['parenthesis-open', 'parenthesis-close', 'bracket-open', 'bracket-close', 'double-quote', 'single-quote'].map((name) => `grammatical.punct.enclosure.${name}`),
	...['repeated-period', 'repeated-exclamation', 'repeated-question', 'mixed-question-exclamation'].map((name) => `grammatical.punct.sequence.${name}`),
	...['and', 'but', 'or', 'yet', 'so', 'because', 'although', 'while', 'whereas'].map((name) => `grammatical.punct.boundary.conjunction.${name}`)
];

export const REQUIRED_CHECKLIST_METRIC_IDS = [...new Set(Object.values(CHECKLIST_METRICS).flat())];

export const T2_METRIC_IDS = [
	'lexical.a1.formality-score', 'lexical.a2.proper-noun-per-1000-tagged', 'lexical.a3.adjective-rate',
	'lexical.a3.attributive-rate', 'lexical.a4.transitive-rate', 'lexical.a5.adverb-rate',
	'grammatical.b3.wh-complement-per-1000', 'grammatical.b5.np-weight',
	'grammatical.b5.heavy-premod-rate', 'grammatical.b6.passive-rate', 'figures.c1.structural-parallel-rate'
];

export const RESOURCE_BACKED_METRIC_IDS = [
	'lexical.a1.concreteness-mean', 'lexical.a1.rare-word-rate', 'lexical.a1.sentiment-word-per-1000',
	'lexical.a1.idiom-per-1000', 'lexical.a1.signature-ngrams', 'figures.c3.concreteness-shift-rate'
];

export const CORPUS_METRIC_IDS = [
	'lexical.a1.hapax-rate', 'lexical.a1.signature-ngrams',
	'figures.c1.recurring-phrase-rate', 'figures.c1.cross-paragraph-repetition-rate'
];
