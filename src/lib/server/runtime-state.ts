import { existsSync, readFileSync } from 'fs';
import { STATE_FILE } from './document-files';
import { writeJsonAtomic } from './file-utils';

interface RuntimeState {
	sessionId?: string;
}

function writeRuntimeState(state: RuntimeState) {
	writeJsonAtomic(STATE_FILE, state);
}

export function readRuntimeState(): RuntimeState {
	try {
		if (!existsSync(STATE_FILE)) return {};
		return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as RuntimeState;
	} catch {
		return {};
	}
}

export function getSessionId(): string | null {
	return readRuntimeState().sessionId || null;
}

export function setSessionId(sessionId: string) {
	const nextState = {
		...readRuntimeState(),
		sessionId
	};
	writeRuntimeState(nextState);
}
