import { json } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { getSessionId, getLastSystemPrompt } from '$lib/server/runtime-state';

/** Encode a filesystem path the same way the Claude SDK does when creating its
 * `~/.claude/projects/<encoded>/<sessionId>.jsonl` file layout. */
function encodeProjectPath(absPath: string): string {
	return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Return the raw JSONL entries for the current agent session.
 *
 * The Claude SDK stores a full transcript of every session at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * We read that file directly rather than going through the SDK's
 * `getSessionMessages` wrapper, which applies its own filtering and limit
 * and can silently truncate a long conversation. The raw JSONL has all
 * message types the SDK writes: user, assistant, system, ai-title, etc.
 * The SessionViewer component filters down to the relevant conversation
 * entries on the client side.
 *
 * Falls back to `getSessionMessages` when the JSONL file can't be found
 * (e.g. very first session before any messages have been written).
 */
export const GET: RequestHandler = async () => {
	const systemPrompt = getLastSystemPrompt();

	const sessionId = getSessionId();
	if (!sessionId) return json({ sessionId: null, raw: [], messages: [], systemPrompt });

	// Try the direct JSONL path first.
	const encodedCwd = encodeProjectPath(process.cwd());
	const jsonlPath = join(homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);

	if (existsSync(jsonlPath)) {
		try {
			const raw = await readJsonlFile(jsonlPath);
			return json({ sessionId, raw, systemPrompt });
		} catch (e) {
			console.error('[history] raw JSONL read failed:', e);
		}
	}

	// Fallback: SDK wrapper (returns formatted messages, not raw entries).
	try {
		const messages = await getSessionMessages(sessionId, {
			dir: process.cwd(),
			limit: 500
		});
		return json({ sessionId, raw: [], messages, systemPrompt });
	} catch (e) {
		console.error('[history] getSessionMessages failed:', e);
		return json({ sessionId, raw: [], messages: [], systemPrompt });
	}
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
