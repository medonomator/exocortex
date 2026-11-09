/**
 * Langfuse-instrumented LLM wrapper.
 *
 * Wraps OpenAiLlmProvider and reports every LLM call as a Langfuse generation
 * with actual token usage (promptTokens, completionTokens, totalTokens).
 *
 * This is what makes Model Usage show real costs in Langfuse dashboard.
 */

import type {
  LlmProvider,
  LlmMessage,
  LlmOptions,
  LlmResponse,
} from '@cognitive-engine/core'
import type { LangfuseTrace } from './langfuse-types.js'

/** Subset of OpenAiLlmProvider that exposes cumulative token count. */
interface TokenCountingLlmProvider extends LlmProvider {
  readonly tokensUsed: number
}

/**
 * Per-token pricing for models not yet in Langfuse's built-in pricing table.
 * Langfuse calculates cost from its internal table — if a model isn't there,
 * cost shows as $0. We pass inputCost/outputCost explicitly to fix this.
 *
 * Prices in USD per token (not per 1K or 1M).
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.00000015, output: 0.0000006 },
  'gpt-5.4':      { input: 0.0000025,  output: 0.00001 },
  'gpt-5':        { input: 0.000005,   output: 0.000015 },
}

export class LangfuseLlmWrapper implements LlmProvider {
  private readonly inner: LlmProvider
  private readonly model: string
  private trace: LangfuseTrace | null = null
  private callIndex = 0

  constructor(inner: LlmProvider, model: string) {
    this.inner = inner
    this.model = model
  }

  /** Set the Langfuse trace to report generations to. */
  setTrace(trace: LangfuseTrace | null): void {
    this.trace = trace
  }

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    return this.traceCompletion(
      `llm-${++this.callIndex}`,
      () => this.inner.complete(messages, options),
      messages,
      options,
    )
  }

  async completeJson<T>(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse & { parsed: T }> {
    return this.traceCompletion(
      `llm-json-${++this.callIndex}`,
      () => this.inner.completeJson<T>(messages, options),
      messages,
      options,
      { responseFormat: 'json' },
    )
  }

  /** Proxy tokensUsed from inner provider if it supports it. */
  get tokensUsed(): number {
    return this.isTokenCounting(this.inner) ? this.inner.tokensUsed : 0
  }

  // ── Private ──

  private async traceCompletion<R extends LlmResponse>(
    genName: string,
    execute: () => Promise<R>,
    messages: LlmMessage[],
    options?: LlmOptions,
    extraMetadata?: Record<string, unknown>,
  ): Promise<R> {
    const model = options?.model ?? this.model
    const gen = this.trace?.generation({
      name: genName,
      model,
      input: messages[messages.length - 1]?.content?.slice(0, 500),
      metadata: { maxTokens: options?.maxTokens, ...extraMetadata },
    })

    const result = await execute()

    try {
      const pricing = MODEL_PRICING[model]
      const inputCost = pricing ? result.usage.promptTokens * pricing.input : undefined
      const outputCost = pricing ? result.usage.completionTokens * pricing.output : undefined
      const totalCost = inputCost != null && outputCost != null ? inputCost + outputCost : undefined

      gen?.end({
        output: result.content.slice(0, 500),
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          unit: 'TOKENS',
          ...(totalCost != null ? { inputCost, outputCost, totalCost } : {}),
        },
        model,
      })
    } catch {
      // Generation end failure should not break the LLM call
    }

    return result
  }

  private isTokenCounting(provider: LlmProvider): provider is TokenCountingLlmProvider {
    return 'tokensUsed' in provider && typeof (provider as TokenCountingLlmProvider).tokensUsed === 'number'
  }
}
