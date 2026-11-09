/**
 * Anthropic provider for LLMProvider.
 *
 * Uses the Messages API directly via fetch (no SDK dep - we want this module
 * to be reusable from hooks / cron / CLI without pulling @anthropic-ai/sdk).
 */

import { ProviderError } from '../core/errors.js';
import type { LLMCompleteOpts, LLMProvider, LLMResponse } from './llm.js';

export interface AnthropicProviderOpts {
  apiKey?: string;
  /** Model id, e.g. 'claude-opus-4-7' or 'claude-sonnet-4-5'. */
  model: string;
  baseUrl?: string;
  /** Default maxTokens if caller doesn't specify. */
  maxTokens?: number;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicProviderOpts) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new ProviderError('ANTHROPIC_API_KEY missing for AnthropicProvider', 'anthropic');
    this.apiKey = key;
    this.defaultModel = opts.model;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.defaultMaxTokens = opts.maxTokens ?? 4096;
  }

  async complete(opts: LLMCompleteOpts): Promise<LLMResponse> {
    const model = opts.model ?? this.defaultModel;

    // Anthropic expects system as a top-level field, not inside messages[].
    const system = opts.messages.find((m) => m.role === 'system')?.content;
    const messages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? this.defaultMaxTokens,
      temperature: opts.temperature ?? 0.2,
      messages,
    };
    if (system) body.system = system;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(`Anthropic ${resp.status}: ${await resp.text()}`, 'anthropic');
    }

    const json = (await resp.json()) as AnthropicResponse;
    const text = json.content.map((c) => c.text ?? '').join('');

    let parsedJson: unknown;
    if (opts.responseFormat === 'json') {
      parsedJson = safeJson(text);
    }

    return {
      text,
      model: json.model,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
      parsedJson,
    };
  }
}

function safeJson(text: string): unknown {
  // Strip markdown code fences if present.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}
