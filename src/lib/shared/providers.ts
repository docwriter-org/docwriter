/** Agent providers, in the order the app lists them. */
export const PROVIDER_IDS = ['claude', 'openai', 'codex', 'cursor', 'pi'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	claude: 'Claude',
	openai: 'OpenAI',
	codex: 'Codex',
	cursor: 'Cursor',
	pi: 'Pi'
};

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
