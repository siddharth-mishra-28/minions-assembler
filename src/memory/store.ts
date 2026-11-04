import type {
  MemoryDataset, MemoryEdge, MemoryEpisode, MemoryFeedback, MemoryNode, MemoryNodeType,
} from './types.js';

/**
 * Persistence port for the memory subsystem.
 *
 * Deliberately NOT part of DbAdapter: memory is its own bounded context with its
 * own lifecycle, and keeping it separate lets the existing adapter (and its
 * Postgres stub) stay untouched. A future Cognee-backed implementation only has
 * to satisfy this interface.
 */

export interface UpsertNodeInput {
  dataset: string;
  node_type: MemoryNodeType;
  name: string;
  content?: string | null;
  terms?: string | null;
  node_set?: string | null;
  properties_json?: string | null;
  importance?: number;
  source_run_id?: string | null;
  source_path?: string | null;
}

export interface UpsertEdgeInput {
  dataset: string;
  source_id: string;
  target_id: string;
  relation: string;
  edge_text?: string | null;
  weight?: number;
  weights_json?: string | null;
  properties_json?: string | null;
}

export interface NodeQuery {
  dataset?: string;
  datasets?: string[];
  node_type?: MemoryNodeType | MemoryNodeType[];
  node_set?: string;
  /** Substring match on name (case-insensitive, parameterized). */
  nameContains?: string;
  limit?: number;
  orderBy?: 'recent' | 'weight' | 'name';
}

export interface EdgeQuery {
  dataset?: string;
  datasets?: string[];
  relations?: string[];
  limit?: number;
}

export interface LexicalHit {
  node: MemoryNode;
  /** Raw bm25() value: more negative is a better match (SQLite FTS5 contract). */
  rank: number;
}

export interface EpisodeQuery {
  runId?: string;
  agentId?: string;
  threadId?: string;
  limit?: number;
}

export interface MemoryStats {
  nodes: number;
  edges: number;
  episodes: number;
  datasets: number;
  lessons: number;
  files: number;
  vectors: number;
  byType: Record<string, number>;
}

export interface MemoryStore {
  // nodes
  upsertNode(input: UpsertNodeInput): MemoryNode;
  getNode(id: string): MemoryNode | undefined;
  findNode(dataset: string, nodeType: string, name: string): MemoryNode | undefined;
  listNodes(q: NodeQuery): MemoryNode[];
  deleteNode(id: string): boolean;
  /** Delete every node+edge in a dataset ('forget'). Returns rows removed. */
  deleteDataset(dataset: string): number;
  touchNodes(ids: string[]): void;

  // edges
  upsertEdge(input: UpsertEdgeInput): MemoryEdge;
  listEdges(q: EdgeQuery): MemoryEdge[];
  /** Both directions around the given node ids. */
  edgesAround(ids: string[], dataset: string, relations?: string[]): MemoryEdge[];
  deleteEdge(id: string): boolean;

  // lexical search (FTS5 BM25)
  searchNodes(match: string, opts: { datasets: string[]; kinds?: MemoryNodeType[]; limit?: number }): LexicalHit[];
  searchEdges(match: string, opts: { datasets: string[]; limit?: number }): { edge: MemoryEdge; rank: number }[];

  // episodes
  insertEpisode(input: Omit<MemoryEpisode, 'id' | 'created_at'> & { id?: string }): MemoryEpisode;
  listEpisodes(q?: EpisodeQuery): MemoryEpisode[];

  // feedback
  addFeedback(input: { runId?: string | null; nodeId?: string | null; edgeId?: string | null; signal: number; source?: string }): MemoryFeedback;
  /** EMA weight update + win/loss counters for every node used by a run. */
  applyFeedback(nodeIds: string[], signal: number, runId?: string | null, source?: string): number;
  /** Multiplicative decay for nodes not used since `olderThanIso` (improve()). Returns rows touched. */
  decayWeights(olderThanIso: string, factor: number): number;
  listFeedback(q: { runId?: string; nodeId?: string; limit?: number }): MemoryFeedback[];

  // datasets + meta
  upsertDataset(id: string, kind: 'platform' | 'agent', label?: string): void;
  listDatasets(): MemoryDataset[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  // vectors (only written when an embedding provider is configured)
  putVector(nodeId: string, dataset: string, model: string, vec: Float32Array): void;
  getVectors(dataset: string, model: string, limit?: number): { node_id: string; vec: Float32Array }[];

  stats(dataset?: string): MemoryStats;
  close(): void;
}
