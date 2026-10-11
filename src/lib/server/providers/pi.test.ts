import { describe, expect, it } from 'vitest';
import { findPiSessionPath } from './pi';

const sessions = {
	list: async (_cwd: string, sessionDir?: string) => [
		{ id: 'session-a', path: `${sessionDir}/2026-10-10_session-a.jsonl` },
		{ id: 'session-b', path: `${sessionDir}/2026-10-10_session-b.jsonl` }
	]
};

describe('findPiSessionPath', () => {
	it('returns the saved file for a session id', async () => {
		expect(await findPiSessionPath(sessions, 'session-b', '/ws', '/ws/.docwriter/pi/sessions')).toBe(
			'/ws/.docwriter/pi/sessions/2026-10-10_session-b.jsonl'
		);
	});

	it('returns null when no saved session has that id', async () => {
		expect(await findPiSessionPath(sessions, 'missing', '/ws', '/ws/.docwriter/pi/sessions')).toBeNull();
	});
});
