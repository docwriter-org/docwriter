/**
 * Gateway trust for hosted deployments.
 *
 * A hosted DocWriter process runs one-per-user behind a supervisor that
 * authenticates the browser and proxies to the process's localhost ports.
 * Other users' processes share the same machine and network namespace, so
 * "bound to 127.0.0.1" is not isolation: any process could connect to any
 * port. When `DOCWRITER_GATEWAY_SECRET` is set, every HTTP request and
 * every WebSocket upgrade must carry the secret in the
 * `x-docwriter-gateway` header, which only the supervisor adds.
 *
 * Unset (the CLI, dev) means no check at all: the process trusts whoever
 * can reach its ports, as it always has.
 */

export const GATEWAY_HEADER = 'x-docwriter-gateway';

export function gatewaySecret(): string {
	return process.env.DOCWRITER_GATEWAY_SECRET ?? '';
}

/** Read a header from either a Fetch `Headers` or Node's flat header map. */
type HeaderSource =
	| { get(name: string): string | null }
	| Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string {
	if (typeof (headers as { get?: unknown }).get === 'function') {
		return (headers as { get(name: string): string | null }).get(name) ?? '';
	}
	const raw = (headers as Record<string, string | string[] | undefined>)[name];
	return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

/**
 * True when the request may proceed: either no secret is configured, or
 * the request carries the configured one. Comparison is length-checked and
 * constant-time-ish by construction (string compare on equal lengths only)
 * to avoid leaking prefix matches through timing.
 */
export function isTrustedGatewayRequest(headers: HeaderSource, secret = gatewaySecret()): boolean {
	if (!secret) return true;
	const presented = readHeader(headers, GATEWAY_HEADER);
	if (presented.length !== secret.length) return false;
	let diff = 0;
	for (let i = 0; i < secret.length; i++) {
		diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
	}
	return diff === 0;
}
