/**
 * LLMProvider - abstraction over chat-capable LLM backends.
 *
 * Split by cadence:
 *   - Daily/strategic jobs   → claude-opus-4-7 (high quality, low volume)
 *   - Frequent/tactical jobs → claude-sonnet-4-5 (good quality, high volume)
 *   - Extraction jobs        → gpt-4o-mini      (cheap, parallel, fast)
 *
 * The provider interface is deliberately minimal - we only need structured
 * text completion. Streaming, tools, and vision belong in higher layers that
 * don't apply to the memory pipeline.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompleteOpts {
  messages: LLMMessage[];
  /** Max tokens to generate. */
  maxTokens?: number;
  /** 0..1; deterministic at 0. Defaults to 0.2 for memory work. */
  temperature?: number;
  /** If set, expect JSON back; provider should hint the model accordingly. */
  responseFormat?: 'text' | 'json';
  /** Override model for this call (otherwise provider default). */
  model?: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD cost if the provider can compute it. */
  costUsd?: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: LLMUsage;
  /** True if the provider believes the output is valid JSON (responseFormat='json'). */
  parsedJson?: unknown;
}

export interface LLMProvider {
  /** Provider-stable identifier, e.g. 'anthropic' | 'openai'. */
  readonly name: string;
  /** Default model this provider is configured with. */
  readonly defaultModel: string;
  complete(opts: LLMCompleteOpts): Promise<LLMResponse>;
}
