/** Static model lists for each provider, newest first. The server returns
 * them when a provider cannot list its models, and the client shows them
 * before `/api/models` responds. Keep both sides on these lists. */
import type { ProviderId } from './providers';

export type FallbackModelOption = { id: string; label: string; provider: ProviderId };

export const CLAUDE_FALLBACK_MODELS: FallbackModelOption[] = [
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'claude' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'claude' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'claude' }
];

// Current OpenAI frontier + reasoning models (newest first), per
// developers.openai.com/api/docs/models as of 2026-06.
export const OPENAI_FALLBACK_MODELS: FallbackModelOption[] = [
	{ id: 'codex-mini', label: 'Codex Mini', provider: 'openai' },
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
	{ id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', provider: 'openai' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'openai' },
	{ id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', provider: 'openai' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai' },
	{ id: 'o3', label: 'o3', provider: 'openai' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' }
];

export const CODEX_FALLBACK_MODELS: FallbackModelOption[] = [
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'codex' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'codex' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'codex' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'codex' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'codex' }
];

export const CURSOR_FALLBACK_MODELS: FallbackModelOption[] = [
	{ id: 'composer-2.5', label: 'Composer 2.5', provider: 'cursor' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'cursor' },
	{ id: 'gpt-4o', label: 'GPT-4o', provider: 'cursor' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'cursor' },
	{ id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', provider: 'cursor' },
	{ id: 'cursor-small', label: 'Cursor Small', provider: 'cursor' }
];

export const PI_FALLBACK_MODELS: FallbackModelOption[] = [
	{ id: 'together/moonshotai/Kimi-K2.6', label: 'Kimi K2.6 (Together)', provider: 'pi' },
	{ id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'pi' },
	{ id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'pi' },
	{ id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'pi' },
	{ id: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'pi' },
	{ id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'pi' },
	{ id: 'openai/o4-mini', label: 'o4-mini', provider: 'pi' },
	{ id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'pi' },
	{ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'pi' },
	{ id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', provider: 'pi' },
	{ id: 'ollama/llama3.1', label: 'Llama 3.1 (Ollama)', provider: 'pi' },
	{ id: 'ollama/qwen3', label: 'Qwen 3 (Ollama)', provider: 'pi' }
];
