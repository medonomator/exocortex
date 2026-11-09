/**
 * OpenAI provider for LLMProvider.
 *
 * Used for cheap high-volume extraction (gpt-4o-mini) during ingest and
 * consolidation. Also works against OpenAI-compatible endpoints (Groq,
 * Together, local vLLM) via baseUrl override.
 */

import { ProviderError } from '../core/errors.js';
import type { LLMCompleteOpts, LLMProvider, LLMResponse } from './llm.js';

export interface OpenAIProviderOpts {
  apiKey?: string;
  /** Model id, e.g. 'gpt-4o-mini'. */
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: OpenAIProviderOpts) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new ProviderError('OPENAI_API_KEY missing for OpenAIProvider', 'openai');
    this.apiKey = key;
    this.defaultModel = opts.model;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.defaultMaxTokens = opts.maxTokens ?? 4096;
  }

  async complete(opts: LLMCompleteOpts): Promise<LLMResponse> {
    const model = opts.model ?? this.defaultModel;

    const body: Record<string, unknown> = {
      model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: opts.maxTokens ?? this.defaultMaxTokens,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(`OpenAI ${resp.status}: ${await resp.text()}`, 'openai');
    }

    const json = (await resp.json()) as OpenAIResponse;
    const text = json.choices[0]?.message.content ?? '';

    let parsedJson: unknown;
    if (opts.responseFormat === 'json') {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = undefined;
      }
    }

    return {
      text,
      model: json.model,
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
      },
      parsedJson,
    };
  }
}
