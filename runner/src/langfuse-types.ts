/**
 * Shared Langfuse SDK type interfaces.
 *
 * We define our own interfaces rather than depending on Langfuse's internal
 * types because the SDK is dynamically imported and the self-hosted instance
 * may lag behind the SDK version. These interfaces cover just the subset we use.
 */

export interface LangfuseClient {
  trace(body: Record<string, unknown>): LangfuseTrace
  shutdownAsync(): Promise<void>
  flushAsync(): Promise<void>
}

export interface LangfuseTrace {
  id: string
  traceId: string
  span(body: Record<string, unknown>): LangfuseSpan
  generation(body: Record<string, unknown>): LangfuseGeneration
  score(body: Record<string, unknown>): unknown
  update(body: Record<string, unknown>): LangfuseTrace
  event(body: Record<string, unknown>): unknown
}

export interface LangfuseSpan {
  id: string
  traceId: string
  span(body: Record<string, unknown>): LangfuseSpan
  generation(body: Record<string, unknown>): LangfuseGeneration
  event(body: Record<string, unknown>): unknown
  end(body?: Record<string, unknown>): LangfuseSpan
  update(body?: Record<string, unknown>): LangfuseSpan
}

export interface LangfuseGeneration {
  id: string
  end(body?: Record<string, unknown>): void
}

/**
 * Create a LangfuseClient from environment variables.
 * Returns null if not configured or SDK unavailable.
 */
export async function createLangfuseClient(label: string): Promise<LangfuseClient | null> {
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const baseUrl = process.env['LANGFUSE_BASE_URL']

  if (!secretKey || !publicKey || !baseUrl) {
    console.log(`   Langfuse ${label}: not configured`)
    return null
  }

  try {
    const { Langfuse } = await import('langfuse')
    const client = new Langfuse({ secretKey, publicKey, baseUrl }) as LangfuseClient
    console.log(`   Langfuse ${label}: connected (${baseUrl})`)
    return client
  } catch (err) {
    console.log(`   Langfuse SDK unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
