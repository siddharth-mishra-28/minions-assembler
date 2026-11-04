import { MEMORY_DEFAULTS_KEY } from './schema.js';
import type { MemoryStore } from './store.js';
import type { DistillMode, MemoryConfig, MemoryNodeType, ResolvedMemoryConfig, RetrievalMode } from './types.js';

/**
 * Memory configuration resolution.
 *
 * Three layers, most specific last:
 *   1. code defaults (this file)
 *   2. platform defaults (mem_meta['platform.memory.defaults']) — editable at runtime
 *      through PUT /api/memory/config, so operators tune behavior from the DB
 *   3. the agent definition's `memory` block (stored in agents.definition_json)
 *
 * Everything is normalized/clamped, so a hand-edited row can never produce an
 * out-of-range budget or an unknown enum.
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  recall: { enabled: true, k: 8, hops: 1, kinds: ['Lesson', 'Fact', 'Symbol', 'File'], maxChars: 4000, includeFacts: true },
  scope: { agent: true, platform: true, crossAgentRead: false, writeTarget: 'agent' },
  retrieval: {
    mode: 'lexical',
    embedding: { provider: 'none', model: '', baseUrl: '', apiKeyRef: '${EMBEDDING_API_KEY}', batchSize: 32 },
  },
  codeGraph: {
    enabled: true,
    dataset: 'platform',
    root: '.',
    include: [],
    exclude: [],
    maxFiles: 4000,
    symbols: true,
    autoRefresh: true,
  },
  capture: { episodes: true, toolFailures: true, commands: true },
  distill: 'heuristic',
  feedbackInfluence: 0.15,
  lessons: { autoPromoteAcrossAgents: 2 },
};

export const NODE_TYPES: MemoryNodeType[] = ['File', 'Symbol', 'Package', 'Fact', 'Lesson', 'Episode', 'Preference', 'Task'];
const RETRIEVAL_MODES: RetrievalMode[] = ['lexical', 'vector', 'hybrid'];
const DISTILL_MODES: DistillMode[] = ['heuristic', 'llm', 'off'];
const EMBEDDING_PROVIDERS = ['none', 'openai', 'ollama', 'custom'] as const;

export const PLATFORM_DATASET = 'platform';

/** Agent memory is keyed by NAME (not name@version): a version bump keeps hard-won learning. */
export function agentDatasetName(def: { metadata: { name: string } }): string {
  return `agent:${def.metadata.name}`;
}

/** Read the platform defaults row (normalized over code defaults). */
export function loadPlatformDefaults(store: MemoryStore): MemoryConfig {
  const raw = store.getMeta(MEMORY_DEFAULTS_KEY);
  if (!raw) return clone(DEFAULT_MEMORY_CONFIG);
  try {
    return normalizeMemoryConfig(JSON.parse(raw), DEFAULT_MEMORY_CONFIG);
  } catch {
    return clone(DEFAULT_MEMORY_CONFIG);
  }
}

/** Persist a partial platform override (merged over the current value). */
export function savePlatformDefaults(store: MemoryStore, partial: unknown): MemoryConfig {
  const next = normalizeMemoryConfig(partial, loadPlatformDefaults(store));
  store.setMeta(MEMORY_DEFAULTS_KEY, JSON.stringify(next));
  return next;
}

/** Resolve: defaults ← platform row ← definition block. */
export function resolveMemoryConfig(
  store: MemoryStore,
  definition?: { memory?: Partial<MemoryConfig> } | null,
): ResolvedMemoryConfig {
  const platform = loadPlatformDefaults(store);
  const cfg = normalizeMemoryConfig(definition?.memory, platform);
  const sources: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_MEMORY_CONFIG) as (keyof MemoryConfig)[]) {
    const defHas = definition?.memory != null && Object.prototype.hasOwnProperty.call(definition.memory, key);
    const rawPlatform = store.getMeta(MEMORY_DEFAULTS_KEY);
    let platformHas = false;
    if (rawPlatform) {
      try { platformHas = Object.prototype.hasOwnProperty.call(JSON.parse(rawPlatform), key); } catch { /* ignore */ }
    }
    sources[key] = defHas ? 'definition' : platformHas ? 'platform' : 'default';
  }
  return { ...cfg, sources };
}

/**
 * Normalize an arbitrary partial config over a base. Unknown keys are ignored
 * (config is additive), numbers are clamped, enums fall back to the base value.
 */
export function normalizeMemoryConfig(partial: unknown, base: MemoryConfig = DEFAULT_MEMORY_CONFIG): MemoryConfig {
  const src = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>;
  const recall = obj(src.recall);
  const scope = obj(src.scope);
  const retrieval = obj(src.retrieval);
  const embedding = obj(retrieval.embedding);
  const codeGraph = obj(src.codeGraph);
  const capture = obj(src.capture);
  const lessons = obj(src.lessons);

  const kinds = Array.isArray(recall.kinds)
    ? (recall.kinds.filter((k): k is MemoryNodeType => NODE_TYPES.includes(k as MemoryNodeType)))
    : base.recall.kinds;

  return {
    enabled: bool(src.enabled, base.enabled),
    recall: {
      enabled: bool(recall.enabled, base.recall.enabled),
      k: int(recall.k, base.recall.k, 1, 50),
      hops: int(recall.hops, base.recall.hops, 0, 3),
      kinds: kinds.length ? kinds : base.recall.kinds,
      maxChars: int(recall.maxChars, base.recall.maxChars, 200, 20000),
      includeFacts: bool(recall.includeFacts, base.recall.includeFacts),
    },
    scope: {
      agent: bool(scope.agent, base.scope.agent),
      platform: bool(scope.platform, base.scope.platform),
      crossAgentRead: bool(scope.crossAgentRead, base.scope.crossAgentRead),
      writeTarget: scope.writeTarget === 'platform' || scope.writeTarget === 'agent' ? scope.writeTarget : base.scope.writeTarget,
    },
    retrieval: {
      mode: RETRIEVAL_MODES.includes(retrieval.mode as RetrievalMode) ? retrieval.mode as RetrievalMode : base.retrieval.mode,
      embedding: {
        provider: EMBEDDING_PROVIDERS.includes(embedding.provider as typeof EMBEDDING_PROVIDERS[number])
          ? embedding.provider as MemoryConfig['retrieval']['embedding']['provider']
          : base.retrieval.embedding.provider,
        model: str(embedding.model, base.retrieval.embedding.model, 200),
        baseUrl: str(embedding.baseUrl, base.retrieval.embedding.baseUrl, 500),
        apiKeyRef: str(embedding.apiKeyRef, base.retrieval.embedding.apiKeyRef, 200),
        batchSize: int(embedding.batchSize, base.retrieval.embedding.batchSize, 1, 256),
        dimensions: embedding.dimensions == null ? base.retrieval.embedding.dimensions : int(embedding.dimensions, base.retrieval.embedding.dimensions ?? 0, 1, 8192),
      },
    },
    codeGraph: {
      enabled: bool(codeGraph.enabled, base.codeGraph.enabled),
      dataset: codeGraph.dataset === 'agent' || codeGraph.dataset === 'platform' ? codeGraph.dataset : base.codeGraph.dataset,
      root: str(codeGraph.root, base.codeGraph.root, 500) || '.',
      include: strArray(codeGraph.include, base.codeGraph.include),
      exclude: strArray(codeGraph.exclude, base.codeGraph.exclude),
      maxFiles: int(codeGraph.maxFiles, base.codeGraph.maxFiles, 1, 50000),
      symbols: bool(codeGraph.symbols, base.codeGraph.symbols),
      autoRefresh: bool(codeGraph.autoRefresh, base.codeGraph.autoRefresh),
    },
    capture: {
      episodes: bool(capture.episodes, base.capture.episodes),
      toolFailures: bool(capture.toolFailures, base.capture.toolFailures),
      commands: bool(capture.commands, base.capture.commands),
    },
    distill: DISTILL_MODES.includes(src.distill as DistillMode) ? src.distill as DistillMode : base.distill,
    feedbackInfluence: num(src.feedbackInfluence, base.feedbackInfluence, 0, 1),
    lessons: {
      autoPromoteAcrossAgents: int(lessons.autoPromoteAcrossAgents, base.lessons.autoPromoteAcrossAgents, 0, 50),
    },
  };
}

function obj(v: unknown): Record<string, unknown> { return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }
function bool(v: unknown, d: boolean): boolean { return typeof v === 'boolean' ? v : d; }
function num(v: unknown, d: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
}
function int(v: unknown, d: number, lo: number, hi: number): number {
  return Math.floor(num(v, d, lo, hi));
}
function str(v: unknown, d: string, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : d;
}
function strArray(v: unknown, d: string[]): string[] {
  if (!Array.isArray(v)) return d;
  const out = v.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 500));
  return out.length ? out : d;
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
