/**
 * Long-term memory domain model.
 *
 * The shape mirrors Cognee's building blocks (DataPoint / Edge / NodeSet /
 * dataset pipelines) so a future backend adapter can map onto it 1:1:
 *
 *   DataPoint  → MemoryNode      (node_type, properties, importance, node_set)
 *   Edge       → MemoryEdge      (source, target, relation, weight, edge_text)
 *   NodeSet    → node_set column (a TAG, not an isolation boundary)
 *   Dataset    → dataset column  ('platform' | 'agent:<name>')
 *   add        → MemoryEpisode + code-graph indexing
 *   cognify    → deterministic extraction (symbols/imports) + lesson distillation
 *   improve    → dedupe, decay, co-change edges, cross-agent promotion
 *   search     → recall() = lexical/vector seeds + graph expansion
 *   forget     → scoped row deletes (never DDL)
 *
 * Stores own persistence; everything here is storage-agnostic.
 */

export type MemoryNodeType = 'File' | 'Symbol' | 'Package' | 'Fact' | 'Lesson' | 'Episode' | 'Preference' | 'Task';

export type MemoryRelation =
  | 'imports'
  | 'contains'
  | 'defines'
  | 'tests'
  | 'caused'
  | 'fixed_by'
  | 'co_change'
  | 'related_to'
  | 'belongs_to_set'
  | (string & {});

export interface MemoryNode {
  id: string;
  dataset: string;
  node_type: MemoryNodeType;
  /** Identity within (dataset, node_type): path, `path#symbol`, `lesson:<sig>`, `fact:<slug>`. */
  name: string;
  content?: string | null;
  /** Expanded identifiers for lexical search (camelCase/snake_case/path segments). */
  terms?: string | null;
  /** Cognee NodeSet tag: code | pitfalls | conventions | deps. */
  node_set?: string | null;
  properties_json?: string | null;
  /** Cognee `importance_weight` analog: 0..1, ranks the node itself. */
  importance: number;
  /** Feedback weight: EMA of ±1 run outcomes. Ranking signal, not retraining. */
  weight: number;
  hits: number;
  wins: number;
  losses: number;
  source_run_id?: string | null;
  source_path?: string | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

export interface MemoryEdge {
  id: string;
  dataset: string;
  source_id: string;
  target_id: string;
  relation: MemoryRelation;
  /** Natural-language statement of the edge — the lexical channel for facts. */
  edge_text?: string | null;
  weight: number;
  weights_json?: string | null;
  properties_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolFailure {
  tool: string;
  args?: unknown;
  error: string;
  command?: string;
  path?: string;
}

export interface MemoryEpisode {
  id: string;
  run_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  task?: string | null;
  outcome: 'done' | 'failed' | 'aborted';
  error?: string | null;
  summary?: string | null;
  memory_injected_json?: string | null;
  tool_failures_json?: string | null;
  files_touched_json?: string | null;
  commands_json?: string | null;
  created_at: string;
}

export interface MemoryFeedback {
  id: string;
  run_id?: string | null;
  node_id?: string | null;
  edge_id?: string | null;
  signal: number;
  source?: string | null;
  created_at: string;
}

export interface MemoryDataset {
  id: string;
  kind: 'platform' | 'agent';
  label?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- retrieval ----------

export type RetrievalMode = 'lexical' | 'vector' | 'hybrid';
export type SeedVia = 'lexical' | 'vector' | 'graph';

export interface RecallQuery {
  query: string;
  /** Datasets to search, most-specific first. Defaults to the runtime's own. */
  datasets?: string[];
  /** Restrict to node types (e.g. ['Lesson','Fact']). */
  kinds?: MemoryNodeType[];
  /** Number of seeds kept before expansion. */
  k?: number;
  /** Graph expansion depth (0 = seeds only, max 3). */
  hops?: number;
  /** Rendered block budget in characters. */
  maxChars?: number;
  /** 0..1 — how strongly feedback weight reorders results (Cognee feedback_influence). */
  feedbackInfluence?: number;
  /** Include edge_text facts in the rendered block. */
  includeFacts?: boolean;
  /** Optional embedder for vector/hybrid seeding; ignored in lexical mode. */
  embedder?: EmbeddingProvider | null;
  mode?: RetrievalMode;
}

export interface RecalledNode {
  node: MemoryNode;
  score: number;
  via: SeedVia;
}

export interface RecallResult {
  nodes: RecalledNode[];
  edges: MemoryEdge[];
  /** Markdown block for prompt injection; empty when nothing was recalled. */
  rendered: string;
  chars: number;
  mode: RetrievalMode;
  datasets: string[];
}

// ---------- embeddings (dormant by default) ----------

export interface EmbeddingProvider {
  /** Provider label recorded with the vector (e.g. 'openai', 'ollama'). */
  readonly provider: string;
  /** Model id recorded with the vector — vectors from different models never mix. */
  readonly model: string;
  readonly dimensions?: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ---------- config ----------

export type DistillMode = 'heuristic' | 'llm' | 'off';

export interface MemoryConfig {
  enabled: boolean;
  recall: {
    enabled: boolean;
    k: number;
    hops: number;
    kinds: MemoryNodeType[];
    maxChars: number;
    /** Include edge_text facts alongside node lines. */
    includeFacts: boolean;
  };
  scope: {
    /** Read the agent's own dataset. */
    agent: boolean;
    /** Read the shared platform dataset. */
    platform: boolean;
    /** Read datasets belonging to other agents (off by default). */
    crossAgentRead: boolean;
    /** Where agent tool writes land: its own dataset, or the shared platform one. */
    writeTarget: 'agent' | 'platform';
  };
  retrieval: {
    mode: RetrievalMode;
    embedding: {
      provider: 'none' | 'openai' | 'ollama' | 'custom';
      model: string;
      baseUrl: string;
      /** `${ENV_VAR}` / `enc:v1:…` reference — never a literal secret at rest. */
      apiKeyRef: string;
      batchSize: number;
      dimensions?: number;
    };
  };
  codeGraph: {
    enabled: boolean;
    /** Where the graph lives: the shared platform dataset (default) or this agent's own. */
    dataset: 'platform' | 'agent';
    root: string;
    include: string[];
    exclude: string[];
    maxFiles: number;
    symbols: boolean;
    /** Incrementally refresh the graph at the start of each run/turn. */
    autoRefresh: boolean;
  };
  capture: {
    episodes: boolean;
    toolFailures: boolean;
    commands: boolean;
  };
  distill: DistillMode;
  feedbackInfluence: number;
  lessons: {
    /** Promote a lesson to the shared platform dataset once N distinct agents learned it (0 = off). */
    autoPromoteAcrossAgents: number;
  };
}

/** Fully-resolved config (defaults ← platform row ← definition), plus provenance. */
export interface ResolvedMemoryConfig extends MemoryConfig {
  /** Which layer supplied the last word for each top-level key (audit/debug). */
  sources?: Record<string, string>;
}

// ---------- code graph ----------

export interface IndexOptions {
  root: string;
  dataset: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
  symbols?: boolean;
  timeBudgetMs?: number;
  runId?: string;
  /** Strip this path prefix from recorded names (run_<id>/ → '') so lessons point at durable paths. */
  stripPrefix?: string;
  /** Remove File nodes that no longer exist under the root. Default true; false for run-scoped scans. */
  removeStale?: boolean;
}

export interface IndexResult {
  root: string;
  dataset: string;
  files: number;
  symbols: number;
  edges: number;
  skipped: number;
  removed: number;
  truncated: boolean;
  durationMs: number;
}
