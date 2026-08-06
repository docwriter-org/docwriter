import { describe, expect, it } from 'vitest';
import {
	extractUrls,
	parseReportedSources,
	proseWithoutUrls,
	sampleNameFrom,
	visibleNarration
} from './references-ingest';

describe('extractUrls', () => {
	it('finds links that carry a scheme', () => {
		expect(extractUrls('see https://example.com/essays/one')).toEqual([
			'https://example.com/essays/one'
		]);
	});

	it('finds bare domains, which is how people actually type them', () => {
		expect(extractUrls('sh-reya.com')).toEqual(['https://sh-reya.com']);
		expect(extractUrls('read www.example.co.uk/blog please')).toEqual([
			'https://www.example.co.uk/blog'
		]);
	});

	it('drops sentence punctuation that trails a link', () => {
		expect(extractUrls('I like sh-reya.com.')).toEqual(['https://sh-reya.com']);
		expect(extractUrls('go to https://example.com/a, then stop')).toEqual([
			'https://example.com/a'
		]);
	});

	it('de-duplicates repeats', () => {
		expect(extractUrls('sh-reya.com and again sh-reya.com')).toEqual(['https://sh-reya.com']);
	});

	it('does not mistake filenames for domains', () => {
		expect(extractUrls('my draft is chapter-1.md and notes.txt')).toEqual([]);
		expect(extractUrls('see paper.pdf')).toEqual([]);
	});

	it('does not mistake abbreviations or emails for domains', () => {
		expect(extractUrls('e.g. this and i.e. that')).toEqual([]);
		expect(extractUrls('mail me at shreya@example.com')).toEqual([]);
	});

	it('returns nothing for plain prose', () => {
		expect(extractUrls('The first draft is only a way of finding the argument.')).toEqual([]);
	});
});

describe('proseWithoutUrls', () => {
	it('is empty when the note is only a link', () => {
		expect(proseWithoutUrls('sh-reya.com')).toBe('');
		expect(proseWithoutUrls('https://example.com/a')).toBe('');
	});

	it('keeps the writing around a link without leaving a gap', () => {
		expect(proseWithoutUrls('Love the voice here sh-reya.com really do')).toBe(
			'Love the voice here really do'
		);
		expect(proseWithoutUrls('Look at https://example.com/a then stop')).toBe(
			'Look at then stop'
		);
	});

	it('keeps filenames, which are not links', () => {
		expect(proseWithoutUrls('see chapter-1.md')).toBe('see chapter-1.md');
	});
});

describe('visibleNarration', () => {
	it('keeps the prose and drops the machine-readable block', () => {
		const reply = 'I found her blog.\n\nSOURCE: https://example.com/a | One\nSOURCE: https://example.com/b | Two';
		expect(visibleNarration(reply)).toBe('I found her blog.');
	});

	it('hides a SOURCE line that is still mid-stream', () => {
		expect(visibleNarration('Here is what I found. SOURCE: https://exa')).toBe(
			'Here is what I found.'
		);
	});

	it('leaves prose with no block untouched', () => {
		expect(visibleNarration('Let me fetch her site first.')).toBe('Let me fetch her site first.');
	});
});

describe('parseReportedSources', () => {
	it('reads the reported lines with their titles', () => {
		const reply = [
			'I found these:',
			'SOURCE: https://example.com/a | On Revision',
			'SOURCE: https://example.com/b | Data Flywheels'
		].join('\n');
		expect(parseReportedSources(reply)).toEqual([
			{ url: 'https://example.com/a', label: 'On Revision' },
			{ url: 'https://example.com/b', label: 'Data Flywheels' }
		]);
	});

	it('adds a scheme and drops duplicates', () => {
		const reply = 'SOURCE: example.com/a | One\nSOURCE: https://example.com/a | One again';
		expect(parseReportedSources(reply)).toEqual([
			{ url: 'https://example.com/a', label: 'One' }
		]);
	});

	it('tolerates a missing title', () => {
		expect(parseReportedSources('SOURCE: https://example.com/a')).toEqual([
			{ url: 'https://example.com/a', label: undefined }
		]);
	});

	it('falls back to any links in the reply when the format is ignored', () => {
		const reply = 'I found https://example.com/a and also paulgraham.com worth reading.';
		expect(parseReportedSources(reply)).toEqual([
			{ url: 'https://example.com/a' },
			{ url: 'https://paulgraham.com' }
		]);
	});

	it('returns nothing when the agent found nothing', () => {
		expect(parseReportedSources('I could not find any writing by this person.')).toEqual([]);
	});
});

describe('sampleNameFrom', () => {
	it('uses the first few words', () => {
		expect(sampleNameFrom('The first draft is only a way of finding it')).toBe(
			'The first draft is only a'
		);
	});

	it('strips a leading markdown heading marker', () => {
		expect(sampleNameFrom('# On revision\n\nmore text')).toBe('On revision');
	});

	it('falls back when there is nothing usable', () => {
		expect(sampleNameFrom('   ')).toBe('Pasted writing');
	});
});
