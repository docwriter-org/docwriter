/**
 * Minimal reverse proxy on node:http and node:net. One HTTP request or one
 * WebSocket upgrade at a time, to a localhost port, with the gateway secret
 * and forwarding headers added. No dependency, no buffering: long-lived
 * SSE responses and WebSocket frames stream straight through.
 */
import http from 'node:http';
import net from 'node:net';

export const GATEWAY_HEADER = 'x-docwriter-gateway';

const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

/** Headers to send upstream. `upgrade` keeps the two headers a WS handshake needs. */
export function forwardHeaders(req, { secret, secure, upgrade = false, remoteAddress = req.socket?.remoteAddress }) {
	const out = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (HOP_BY_HOP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue;
		out[k] = v;
	}
	out[GATEWAY_HEADER] = secret;
	out['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (secure ? 'https' : 'http');
	out['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
	const prior = req.headers['x-forwarded-for'];
	out['x-forwarded-for'] = prior ? `${prior}, ${remoteAddress ?? ''}` : String(remoteAddress ?? '');
	return out;
}

/** Response headers to send back; strips what Node re-derives itself. */
export function responseHeaders(upstreamHeaders) {
	const out = {};
	for (const [k, v] of Object.entries(upstreamHeaders)) {
		if (HOP_BY_HOP.has(k)) continue;
		out[k] = v;
	}
	return out;
}

export function proxyRequest(req, res, { port, secret, secure, onError }) {
	const upstream = http.request(
		{ host: '127.0.0.1', port, method: req.method, path: req.url, headers: forwardHeaders(req, { secret, secure }) },
		(up) => {
			res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
			up.pipe(res);
			up.on('error', () => res.destroy());
		}
	);
	upstream.setTimeout(0);
	upstream.on('error', (err) => {
		onError?.(err);
		if (!res.headersSent) {
			res.writeHead(502, { 'content-type': 'text/plain' });
			res.end('Bad gateway: the workspace process did not answer.');
		} else {
			res.destroy();
		}
	});
	req.on('aborted', () => upstream.destroy());
	req.pipe(upstream);
}

export function proxyUpgrade(req, socket, head, { port, secret, secure, onClose, onError }) {
	const upstream = net.connect({ host: '127.0.0.1', port });
	let closed = false;
	const finish = () => {
		if (closed) return;
		closed = true;
		onClose?.();
		socket.destroy();
		upstream.destroy();
	};
	upstream.on('connect', () => {
		const headers = forwardHeaders(req, { secret, secure, upgrade: true });
		let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
		for (const [k, v] of Object.entries(headers)) {
			for (const value of Array.isArray(v) ? v : [v]) raw += `${k}: ${value}\r\n`;
		}
		raw += '\r\n';
		upstream.write(raw);
		if (head && head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	upstream.on('error', (err) => {
		onError?.(err);
		finish();
	});
	upstream.on('close', finish);
	socket.on('error', finish);
	socket.on('close', finish);
}
