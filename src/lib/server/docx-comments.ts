import JSZip from 'jszip';
import type { ImportedComment } from '$lib/types';

/**
 * Extract comments from a .docx file. Parses `word/comments.xml` for
 * comment text/author and `word/document.xml` for the anchored passage
 * each comment refers to (the text between commentRangeStart/End markers).
 */
export async function extractDocxComments(buffer: Buffer): Promise<ImportedComment[]> {
	const zip = await JSZip.loadAsync(buffer);

	const commentsXml = await zip.file('word/comments.xml')?.async('text');
	if (!commentsXml) return [];

	const documentXml = await zip.file('word/document.xml')?.async('text');

	const comments = parseCommentsXml(commentsXml);
	const anchors = documentXml ? parseCommentAnchors(documentXml) : {};

	return comments.map((c) => ({
		id: 'imp_' + Math.random().toString(36).slice(2, 10),
		author: c.author,
		text: c.text,
		originalAnchor: anchors[c.commentId] || undefined
	}));
}

interface RawComment {
	commentId: string;
	author: string;
	text: string;
}

function parseCommentsXml(xml: string): RawComment[] {
	const results: RawComment[] = [];
	const commentRegex = /<w:comment\b[^>]*>/g;
	let match;

	while ((match = commentRegex.exec(xml)) !== null) {
		const tag = match[0];
		const id = attr(tag, 'w:id');
		const author = attr(tag, 'w:author') || 'Reviewer';
		if (!id) continue;

		const startIdx = match.index + tag.length;
		const endTag = '</w:comment>';
		const endIdx = xml.indexOf(endTag, startIdx);
		if (endIdx === -1) continue;

		const body = xml.slice(startIdx, endIdx);
		const text = extractTextRuns(body);
		if (text.trim()) {
			results.push({ commentId: id, author, text: text.trim() });
		}
	}

	return results;
}

function parseCommentAnchors(xml: string): Record<string, string> {
	const anchors: Record<string, string> = {};
	const startRegex = /<w:commentRangeStart\b[^>]*w:id="(\d+)"[^>]*\/>/g;
	let match;

	while ((match = startRegex.exec(xml)) !== null) {
		const id = match[1];
		const startIdx = match.index + match[0].length;
		const endPattern = `<w:commentRangeEnd w:id="${id}"`;
		const endAlt = `<w:commentRangeEnd w:id='${id}'`;
		let endIdx = xml.indexOf(endPattern, startIdx);
		if (endIdx === -1) endIdx = xml.indexOf(endAlt, startIdx);
		if (endIdx === -1) continue;

		const rangeXml = xml.slice(startIdx, endIdx);
		const text = extractTextRuns(rangeXml);
		if (text.trim()) {
			anchors[id] = text.trim();
		}
	}

	return anchors;
}

function extractTextRuns(xml: string): string {
	const parts: string[] = [];
	const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
	let m;
	while ((m = textRegex.exec(xml)) !== null) {
		parts.push(m[1]);
	}
	return parts.join('');
}

function attr(tag: string, name: string): string | null {
	const pattern = new RegExp(`${name}="([^"]*)"`, 'i');
	const m = tag.match(pattern);
	return m ? decodeXmlEntities(m[1]) : null;
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}
