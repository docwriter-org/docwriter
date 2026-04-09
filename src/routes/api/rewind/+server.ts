import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { DOC_FILE, RENDER_DOC_FILE } from '$lib/server/document-files';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { checkpointId, sessionId } = await request.json();

		const rewindQuery = query({
			prompt: '',
			options: {
				enableFileCheckpointing: true,
				resume: sessionId,
				extraArgs: { 'replay-user-messages': null }
			}
		});

		for await (const msg of rewindQuery) {
			await rewindQuery.rewindFiles(checkpointId);
			break;
		}

		const targetFile = (() => {
			try {
				return readFileSync(RENDER_DOC_FILE, 'utf-8');
			} catch {
				return readFileSync(DOC_FILE, 'utf-8');
			}
		})();
		return json({ document: JSON.parse(targetFile) });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};
