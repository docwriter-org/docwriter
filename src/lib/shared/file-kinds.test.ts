import { describe, expect, it } from 'vitest';
import { isBinaryOrPreviewPath, isPdfPath, looksLikeBinaryText } from './file-kinds';

describe('isBinaryOrPreviewPath', () => {
	it('treats PDFs and images as preview files', () => {
		expect(isPdfPath('cv.pdf')).toBe(true);
		expect(isBinaryOrPreviewPath('cv.pdf')).toBe(true);
		expect(isBinaryOrPreviewPath('figures/plot.png')).toBe(true);
	});

	it('keeps writing sources as text tabs', () => {
		expect(isBinaryOrPreviewPath('research_2026.tex')).toBe(false);
		expect(isBinaryOrPreviewPath('dblp.bib')).toBe(false);
		expect(isBinaryOrPreviewPath('chapter.md')).toBe(false);
	});

	it('detects embedded NUL bytes from a binary-as-text read', () => {
		expect(looksLikeBinaryText('hello\0world')).toBe(true);
		expect(looksLikeBinaryText('%PDF-1.7 text-like header')).toBe(false);
	});
});
