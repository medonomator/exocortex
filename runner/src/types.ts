export interface LlmProvider {
  complete(
    messages: Array<{ role: string; content: string }>,
    options?: { maxTokens?: number },
  ): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }>
  completeJson<T>(
    messages: Array<{ role: string; content: string }>,
    options?: { maxTokens?: number },
  ): Promise<{ parsed: T }>
}
