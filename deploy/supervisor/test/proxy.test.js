import { describe, expect, it } from 'vitest';
import { forwardHeaders, responseHeaders } from '../proxy.js';

const req = (headers) => ({ headers, socket: { remoteAddress: '10.0.0.9' } });

describe('proxy headers', () => {
	it('adds the gateway secret and forwarding headers, strips hop-by-hop', () => {
		const h = forwardHeaders(req({ host: 'app.example.org', connection: 'keep-alive', 'transfer-encoding': 'chunked', cookie: 'a=1' }), { secret: 's', secure: true });
		expect(h['x-docwriter-gateway']).toBe('s');
		expect(h['x-forwarded-proto']).toBe('https');
		expect(h['x-forwarded-host']).toBe('app.example.org');
		expect(h['x-forwarded-for']).toBe('10.0.0.9');
		expect(h.cookie).toBe('a=1');
		expect(h.connection).toBeUndefined();
		expect(h['transfer-encoding']).toBeUndefined();
	});
	it('keeps the two headers a WebSocket handshake needs and appends to x-forwarded-for', () => {
		const h = forwardHeaders(req({ host: 'h', connection: 'Upgrade', upgrade: 'websocket', 'x-forwarded-for': '1.1.1.1', 'x-forwarded-proto': 'https' }), { secret: 's', secure: false, upgrade: true });
		expect(h.connection).toBe('Upgrade');
		expect(h.upgrade).toBe('websocket');
		expect(h['x-forwarded-for']).toBe('1.1.1.1, 10.0.0.9');
		expect(h['x-forwarded-proto']).toBe('https');
	});
	it('drops transfer-encoding from upstream responses so Node re-frames them', () => {
		expect(responseHeaders({ 'content-type': 'text/html', 'transfer-encoding': 'chunked', connection: 'close' })).toEqual({ 'content-type': 'text/html' });
	});
});
