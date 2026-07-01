import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionId, getLastSystemPrompt } from '$lib/server/runtime-state';
import {
	kvGet,
	dbGetConversationEvents,
	dbGetConversationSessionSummary
} from '$lib/server/db-writes';
import { getEffectiveRoot } from '$lib/server/document-files';
import {
	createProviderSessionStore,
	loadProviderSessionEntries
} from '$lib/server/provider-session-store';

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

export const GET: RequestHandler = async ({ url }) => {
	const systemPrompt = getLastSystemPrompt();
	const requestedSessionId = url.searchParams.get('session');
	const sessionId = requestedSessionId || getSessionId();
	const requestedSummary = requestedSessionId
		? dbGetConversationSessionSummary(requestedSessionId)
		: null;
	const provider = requestedSummary?.provider || kvGet('provider') || 'claude';
	const model = requestedSummary?.model || kvGet('model') || null;

	if (!sessionId) {
		return json({
			sessionId: null,
			raw: [],
			rawFormat: 'conversation_events',
			messages: [],
			systemPrompt,
			provider,
			model
		});
	}
	const activeSessionId = sessionId;

	function conversationEventsPayload() {
		const events = dbGetConversationEvents(activeSessionId);
		const raw = events.map((e) => {
			try { return JSON.parse(e.data); } catch { return null; }
		}).filter(Boolean);
		return raw;
	}

	// Non-Claude providers: load from the conversation_events DB table.
	if (provider !== 'claude') {
		return json({
			sessionId,
			raw: conversationEventsPayload(),
			rawFormat: 'conversation_events',
			messages: [],
			systemPrompt,
			provider,
			model
		});
	}

	// Claude: read from the provider-native SessionStore mirror in SQLite.
	// Local JSONL is just the SDK's write-through implementation detail, not
	// our durable source.
	const raw = loadProviderSessionEntries('claude', activeSessionId);
	if (raw.length > 0) {
		return json({
			sessionId,
			raw,
			rawFormat: 'provider_native',
			messages: [],
			systemPrompt,
			provider,
			model
		});
	}

	const workspaceRoot = getEffectiveRoot();
	try {
		const getSessionMessages = await loadGetSessionMessages();
		if (getSessionMessages) {
			const messages = await getSessionMessages(sessionId, {
				dir: workspaceRoot,
				limit: 500,
				sessionStore: createProviderSessionStore('claude')
			});
			if (Array.isArray(messages) && messages.length > 0) {
				return json({
					sessionId,
					raw: [],
					rawFormat: 'provider_native',
					messages,
					systemPrompt,
					provider,
					model
				});
			}
		}
	} catch (e) {
		console.error('[history] getSessionMessages failed:', e);
	}

	return json({
		sessionId,
		raw: conversationEventsPayload(),
		rawFormat: 'conversation_events',
		messages: [],
		systemPrompt,
		provider,
		model
	});
};
