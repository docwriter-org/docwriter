import { describe, expect, it } from 'vitest';
import { GATEWAY_HEADER, isTrustedGatewayRequest } from './gateway';

describe('isTrustedGatewayRequest', () => {
	it('allows everything when no secret is configured', () => {
		expect(isTrustedGatewayRequest(new Headers(), '')).toBe(true);
		expect(isTrustedGatewayRequest({}, '')).toBe(true);
	});

	it('rejects a request without the header', () => {
		expect(isTrustedGatewayRequest(new Headers(), 's3cret')).toBe(false);
		expect(isTrustedGatewayRequest({}, 's3cret')).toBe(false);
	});

	it('rejects a wrong or partial secret', () => {
		expect(isTrustedGatewayRequest(new Headers({ [GATEWAY_HEADER]: 's3cre' }), 's3cret')).toBe(false);
		expect(isTrustedGatewayRequest(new Headers({ [GATEWAY_HEADER]: 'S3CRET' }), 's3cret')).toBe(false);
	});

	it('accepts the configured secret from Fetch and Node header shapes', () => {
		expect(isTrustedGatewayRequest(new Headers({ [GATEWAY_HEADER]: 's3cret' }), 's3cret')).toBe(true);
		expect(isTrustedGatewayRequest({ [GATEWAY_HEADER]: 's3cret' }, 's3cret')).toBe(true);
		expect(isTrustedGatewayRequest({ [GATEWAY_HEADER]: ['s3cret'] }, 's3cret')).toBe(true);
	});
});
