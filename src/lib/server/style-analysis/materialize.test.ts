import { describe, expect, it } from 'vitest';
import { arxivFullTextUrls, cleanLatex, extractHtml, extractPdf } from './materialize';

describe('arxivFullTextUrls', () => {
	it('prefers full text over the abstract landing page', () => {
		expect(arxivFullTextUrls('https://arxiv.org/abs/2402.01030')).toEqual([
			'https://arxiv.org/html/2402.01030',
			'https://ar5iv.labs.arxiv.org/html/2402.01030',
			'https://arxiv.org/pdf/2402.01030'
		]);
	});

	it('handles versioned ids and pdf links', () => {
		expect(arxivFullTextUrls('https://arxiv.org/abs/2402.01030v2')[0]).toBe(
			'https://arxiv.org/html/2402.01030v2'
		);
		expect(arxivFullTextUrls('https://arxiv.org/pdf/2402.01030.pdf')[0]).toBe(
			'https://arxiv.org/html/2402.01030'
		);
	});

	it('leaves non-arxiv urls alone', () => {
		expect(arxivFullTextUrls('https://example.com/abs/123')).toEqual([]);
		expect(arxivFullTextUrls('not a url')).toEqual([]);
	});
});

function simplePdf(text: string): Uint8Array {
	const escaped = text.replace(/([\\()])/g, '\\$1');
	const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
	const objects = [
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
		`4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
		'5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
	];
	let body = '%PDF-1.4\n';
	const offsets = [0];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body));
		body += object;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(body, 'binary'));
}

describe('style reference extraction', () => {
	it('extracts readable HTML and ignores page controls', () => {
		const text = extractHtml('<html><body><nav>Menu</nav><article><h1>Result</h1><p>The measured result was stable.</p></article></body></html>', 'https://example.com/reference');
		expect(text).toContain('The measured result was stable.');
	});

	it('normalizes common LaTeX structure and inline commands', () => {
		const text = cleanLatex('\\section{Method}\nWe used \\textbf{careful} checks \\citep{smith2024}.');
		expect(text).toContain('# Method');
		expect(text).toContain('careful checks [smith2024]');
		expect(text).not.toContain('\\textbf');
	});

	it('extracts text from a PDF fixture', async () => {
		await expect(extractPdf(simplePdf('PDF reference sentence.'))).resolves.toContain('PDF reference sentence.');
	});
});
