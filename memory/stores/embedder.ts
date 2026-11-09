/**
 * Embedder: text → dense vector.
 *
 * The embedder is pluggable because (a) we may swap OpenAI → local model in
 * the future, and (b) we need to keep multiple embedder versions side by
 * side during migrations (old items stay readable while new items use the
 * new model). Every embedding carries the `model` name so joins work.
 */

import { EmbedderError } from '../core/errors.js';

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface OpenAIEmbedderOpts {
  apiKey: string;
  model?: string; // 'text-embedding-3-small' default
  dim?: number; // Matryoshka truncation; default = model native
  timeoutMs?: number;
  baseUrl?: string; // for OpenAI-compatible endpoints (Together, DeepInfra, ...)
}

export class OpenAIEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OpenAIEmbedderOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dim = opts.dim ?? 1536;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts.map((t) => t.slice(0, 8000)),
          dimensions: this.dim,
        }),
      });
      if (!resp.ok) {
        throw new EmbedderError(
          `${this.model} returned ${resp.status}: ${await resp.text()}`,
        );
      }
      const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => new Float32Array(d.embedding));
    } catch (err) {
      if (err instanceof EmbedderError) throw err;
      throw new EmbedderError(`Embedder failed: ${String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}
