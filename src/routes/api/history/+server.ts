import { json } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { getSessionId, getLastSystemPrompt } from '$lib/server/runtime-state';
import { kvGet, dbGetConversationEvents } from '$lib/server/db-writes';

let _getSessionMessages: ((id: string, opts: any) => Promise<any>) | null = null;
async function loadGetSessionMessages() {
	if (_getSessionMessages) return _getSessionMessages;
	try {
		const sdk = await import('@anthropic-ai/claude-agent-sdk');
		_getSessionMessages = sdk.getSessionMessages;
		return _getSessionMessages;
	} catch {
		return null;
	}
}

function encodeProjectPath(absPath: string): string {
	return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export const GET: RequestHandler = async () => {
	const systemPrompt = getLastSystemPrompt();
	const sessionId = getSessionId();
	const provider = kvGet('provider') || 'claude';

	if (!sessionId) return json({ sessionId: null, raw: [], messages: [], systemPrompt, provider });

	// Non-Claude providers: load from the conversation_events DB table.
	if (provider !== 'claude') {
		const events = dbGetConversationEvents(sessionId);
		const raw = events.map((e) => {
			try { return JSON.parse(e.data); } catch { return null; }
		}).filter(Boolean);
		return json({ sessionId, raw, messages: [], systemPrompt, provider });
	}

	// Claude: try the direct JSONL path first.
	const encodedCwd = encodeProjectPath(process.cwd());
	const jsonlPath = join(homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);

	if (existsSync(jsonlPath)) {
		try {
			const raw = await readJsonlFile(jsonlPath);
			return json({ sessionId, raw, systemPrompt, provider });
		} catch (e) {
			console.error('[history] raw JSONL read failed:', e);
		}
	}

	// Fallback: SDK wrapper.
	try {
		const getSessionMessages = await loadGetSessionMessages();
		if (getSessionMessages) {
			const messages = await getSessionMessages(sessionId, {
				dir: process.cwd(),
				limit: 500
			});
			return json({ sessionId, raw: [], messages, systemPrompt, provider });
		}
	} catch (e) {
		console.error('[history] getSessionMessages failed:', e);
	}

	// Final fallback: check conversation_events anyway (maybe provider was switched)
	const events = dbGetConversationEvents(sessionId);
	if (events.length > 0) {
		const raw = events.map((e) => {
			try { return JSON.parse(e.data); } catch { return null; }
		}).filter(Boolean);
		return json({ sessionId, raw, messages: [], systemPrompt, provider });
	}

	return json({ sessionId, raw: [], messages: [], systemPrompt, provider });
};

function readJsonlFile(filePath: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const entries: unknown[] = [];
		const rl = createInterface({
			input: createReadStream(filePath, { encoding: 'utf8' }),
			crlfDelay: Infinity
		});
		rl.on('line', (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				entries.push(JSON.parse(trimmed));
			} catch {
				// Skip malformed lines
			}
		});
		rl.on('close', () => resolve(entries));
		rl.on('error', reject);
	});
}
