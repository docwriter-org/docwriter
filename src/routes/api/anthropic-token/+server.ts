import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	clearAnthropicApiKey,
	getAnthropicTokenStatus,
	saveAnthropicApiKey
} from '$lib/server/anthropic-token';

export const GET: RequestHandler = async ({ cookies }) => {
	return json(getAnthropicTokenStatus(cookies));
};

export const PUT: RequestHandler = async ({ request, cookies }) => {
	const body = await request.json().catch(() => ({}));
	const token = typeof body.token === 'string' ? body.token.trim() : '';
	if (!token) throw error(400, 'Missing Anthropic API key.');
	if (!token.startsWith('sk-ant-')) {
		throw error(400, 'Anthropic API keys should start with sk-ant-.');
	}
	return json(saveAnthropicApiKey(token, cookies));
};

export const DELETE: RequestHandler = async ({ cookies }) => {
	return json(clearAnthropicApiKey(cookies));
};
