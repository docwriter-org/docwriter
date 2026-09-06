/**
 * Stand-in for build/index.js in supervisor tests: same env contract
 * (PORT, DOCWRITER_WS_PORT, DOCWRITER_GATEWAY_SECRET), same gateway check,
 * a health route, a header echo, an SSE stream, and an echoing WebSocket.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = parseInt(process.env.PORT, 10);
const wsPort = parseInt(process.env.DOCWRITER_WS_PORT, 10);
const secret = process.env.DOCWRITER_GATEWAY_SECRET ?? '';
const trusted = (req) => !secret || req.headers['x-docwriter-gateway'] === secret;

const server = http.createServer((req, res) => {
	if (!trusted(req)) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		return res.end('Forbidden');
	}
	if (req.url === '/api/health') {
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(JSON.stringify({ ok: true }));
	}
	if (req.url === '/echo') {
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(
			JSON.stringify({
				headers: req.headers,
				env: {
					DOCWRITER_ROOT: process.env.DOCWRITER_ROOT,
					HOME: process.env.HOME,
					ORIGIN: process.env.ORIGIN,
					PUBLIC_DOCWRITER_WS_URL: process.env.PUBLIC_DOCWRITER_WS_URL
				},
				pid: process.pid
			})
		);
	}
	if (req.url === '/sse') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		let n = 0;
		const t = setInterval(() => {
			res.write(`data: ${++n}\n\n`);
			if (n === 3) {
				clearInterval(t);
				res.end();
			}
		}, 20);
		return;
	}
	res.writeHead(404);
	res.end();
});
server.listen(port, '127.0.0.1');

const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1', verifyClient: ({ req }) => trusted(req) });
wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)));

process.on('SIGTERM', () => {
	wss.close();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 200);
});
