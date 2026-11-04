import { resolveProviderApiKeyValue } from '../core/crypto.js';
import type { MemoryStore } from './store.js';
import type { EmbeddingProvider, MemoryConfig, MemoryNode } from './types.js';

/**
 * Embeddings are a CAPABILITY, not a dependency.
 *
 * Default `provider: 'none'` → no provider is constructed, `mem_vectors` stays
 * empty, and recall is pure lexical + graph. When an operator configures an
 * OpenAI-compatible `/embeddings` endpoint (OpenAI, Ollama `/v1`, LM Studio, a
 * gateway…), the same engine gains vector seeding without any code change.
 *
 * No model is bundled here: this is an HTTP client for a service the operator
 * supplies. That keeps "no embeddings for now" true while making the switch real.
 */
export interface HttpEmbeddingOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  batchSize?: number;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions?: number;
  private baseUrl: string;
  private apiKey: string;
  private batchSize: number;
  private fetchImpl: typeof fetch;

  constructor(opts: HttpEmbeddingOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.batchSize = Math.max(1, Math.min(256, opts.batchSize ?? 32));
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const body: Record<string, unknown> = { model: this.model, input: batch };
      if (this.dimensions) body.dimensions = this.dimensions;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`embedding endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json() as { data?: { embedding?: number[]; index?: number }[] };
      const rows = json.data ?? [];
      if (!rows.length) throw new Error('embedding endpoint returned no vectors');
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const r of sorted) {
        if (!Array.isArray(r.embedding) || !r.embedding.length) throw new Error('embedding endpoint returned a malformed vector');
        out.push(r.embedding);
      }
    }
    return out;
  }
}

/**
 * Build a provider from resolved config, or null when embeddings are off/unusable.
 * Definition authoring mistakes degrade to lexical recall instead of failing a run.
 */
export function resolveEmbeddingProvider(
  cfg: MemoryConfig['retrieval']['embedding'],
  opts?: { fetchImpl?: typeof fetch },
): EmbeddingProvider | null {
  if (!cfg || cfg.provider === 'none') return null;
  if (!cfg.baseUrl.trim() || !cfg.model.trim()) return null;
  let apiKey = '';
  if (cfg.apiKeyRef) {
    try { apiKey = resolveProviderApiKeyValue(cfg.apiKeyRef); } catch { return null; }
  }
  if (cfg.provider !== 'ollama' && !apiKey) return null;
  return new HttpEmbeddingProvider({
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey,
    batchSize: cfg.batchSize,
    dimensions: cfg.dimensions,
    fetchImpl: opts?.fetchImpl,
  });
}

/** Cosine similarity; returns 0 for zero/degenerate vectors instead of NaN. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Vectorize nodes that do not have a vector for this model yet. Bounded per call
 * (new content only), so a configured endpoint is used incrementally rather than
 * re-embedding a whole dataset.
 */
export async function vectorizeDataset(
  store: MemoryStore,
  provider: EmbeddingProvider,
  dataset: string,
  nodes: Pick<MemoryNode, 'id' | 'name' | 'content'>[],
  maxPerCall = 200,
): Promise<number> {
  if (!nodes.length) return 0;
  const batch = nodes.slice(0, maxPerCall);
  const texts = batch.map((n) => `${n.name}\n${(n.content ?? '').slice(0, 2000)}`);
  const vectors = await provider.embed(texts);
  for (let i = 0; i < batch.length; i++) {
    const vec = vectors[i];
    if (!vec?.length) continue;
    store.putVector(batch[i].id, dataset, provider.model, Float32Array.from(vec));
  }
  return batch.length;
}
