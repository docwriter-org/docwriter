import AdmZip from 'adm-zip';
import type { RequestHandler } from './$types';
import { readStyleStudyEvents } from '$lib/server/style-analysis/study-log';

function csvCell(value: unknown): string {
	const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
	return `"${text.replace(/"/g, '""')}"`;
}

function median(values: number[]): number | '' {
	if (!values.length) return '';
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numeric(events: Array<Record<string, unknown>>, key: string): number[] {
	return events.flatMap((event) => typeof event[key] === 'number' ? [event[key] as number] : []);
}

function table(rows: Array<Record<string, unknown>>): string {
	const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return [keys.map(csvCell).join(','), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(','))].join('\n') + '\n';
}

export const GET: RequestHandler = async () => {
	const events = readStyleStudyEvents();
	const keys = [...new Set(events.flatMap((event) => Object.keys(event)))].sort();
	const eventsCsv = [keys.map(csvCell).join(','), ...events.map((event) => keys.map((key) => csvCell(event[key])).join(','))].join('\n') + '\n';
	const conditions = ['no-references', 'raw-references', 'compiled-author-skill'];
	const conditionSummary = conditions.map((condition) => {
		const rows = events.filter((event) => event.type === 'editing_completed' && event.condition === condition);
		return {
			condition,
			participants: new Set(rows.flatMap((event) => typeof event.participantId === 'string' ? [event.participantId] : [])).size,
			tasks: rows.length,
			medianDurationMs: median(numeric(rows, 'durationMs')),
			medianAgentRounds: median(numeric(rows, 'agentRounds')),
			medianAcceptedEdits: median(numeric(rows, 'acceptedEdits')),
			medianRejectedEdits: median(numeric(rows, 'rejectedEdits')),
			medianUserEditDistance: median(numeric(rows, 'userEditDistance')),
			medianFinalCorrectionSize: median(numeric(rows, 'finalCorrectionSize'))
		};
	});
	const preferenceRows = conditions.map((condition) => ({
		choice: condition,
		count: events.filter((event) => event.type === 'blind_preference' && event.choice === condition).length
	}));
	preferenceRows.push(
		{ choice: 'tie', count: events.filter((event) => event.type === 'blind_preference' && event.choice === 'tie').length },
		{ choice: 'none', count: events.filter((event) => event.type === 'blind_preference' && event.choice === 'none').length }
	);
	const zip = new AdmZip();
	zip.addFile('events.jsonl', Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8'));
	zip.addFile('events.csv', Buffer.from(eventsCsv, 'utf8'));
	zip.addFile('condition-summary.csv', Buffer.from(table(conditionSummary), 'utf8'));
	zip.addFile('preference-summary.csv', Buffer.from(table(preferenceRows), 'utf8'));
	zip.addFile('manifest.json', Buffer.from(`${JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), eventCount: events.length, containsRawText: false, conditions }, null, 2)}\n`, 'utf8'));
	return new Response(new Uint8Array(zip.toBuffer()), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': 'attachment; filename="docwriter-style-study.zip"',
			'cache-control': 'no-store'
		}
	});
};
