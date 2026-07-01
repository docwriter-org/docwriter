/**
 * Custom production entry point for Fly.io deployment.
 *
 * Serves SvelteKit + Hocuspocus WebSocket on a single port.
 * In dev mode, use `npm run dev` instead (separate WS port).
 */
import http from 'node:http';
import { handler } from './build/handler.js';

const port = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(handler);

// handler.js transitively imports hooks.server.ts, which creates the
// Hocuspocus Server (without binding a port when SINGLE_PORT_WS=1)
// and stores it on globalThis.__docwriterWsServer.
const wsServer = /** @type {any} */ (globalThis).__docwriterWsServer;

if (wsServer) {
	const wss = wsServer.webSocketServer;
	server.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url || '/', `http://${request.headers.host}`);
		if (url.pathname === '/ws') {
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit('connection', ws, request);
			});
		} else {
			socket.destroy();
		}
	});
	console.log('[docwriter] WebSocket upgrade handler wired on /ws');
} else {
	console.warn('[docwriter] No Hocuspocus server found on globalThis — WebSocket disabled');
}

server.listen(port, '0.0.0.0', () => {
	console.log(`[docwriter] Listening on http://0.0.0.0:${port}`);
});
