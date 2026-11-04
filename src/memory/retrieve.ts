import { PLATFORM_DATASET } from './config.js';
import { renderMemoryBlock, typePrior } from './context.js';
import { cosine } from './embeddings.js';
import { recencyScore, toFtsMatch } from './text.js';
import type { MemoryStore } from './store.js';
import type {
  MemoryEdge, MemoryNode, RecallQuery, RecallResult, RecalledNode, ResolvedMemoryConfig, RetrievalMode, SeedVia,
} from './types.js';

/**
 * Recall = seed → expand → render. This is Cognee's graph-completion shape with
 * the vector dependency removed: lexical (BM25) seeds replace vector seeds, and
 * the graph traversal stage is unchanged. When an embedding provider is
 * configured the vector channel is fused back in via Reciprocal Rank Fusion.
 */
const RRF_K = 60;
const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_EDGES = 400;

export async function recall(
  store: MemoryStore,
  cfg: ResolvedMemoryConfig,
  q: RecallQuery,
): Promise<RecallResult> {
  const mode: RetrievalMode = q.mode ?? cfg.retrieval.mode;
  const datasets = uniqueDatasets(q.datasets?.length ? q.datasets : [PLATFORM_DATASET]);
  const k = clampInt(q.k ?? cfg.recall.k, 1, 50);
  const hops = clampInt(q.hops ?? cfg.recall.hops, 0, 3);
  const maxChars = clampInt(q.maxChars ?? cfg.recall.maxChars, 200, 20000);
  const influence = clamp01(q.feedbackInfluence ?? cfg.feedbackInfluence);
  const kinds = q.kinds ?? cfg.recall.kinds;
  const empty: RecallResult = { nodes: [], edges: [], rendered: '', chars: 0, mode, datasets };

  if (!cfg.enabled || !cfg.recall.enabled) return empty;
  if (!q.query || !q.query.trim() || !datasets.length) return empty;
  const match = toFtsMatch(q.query);
  if (!match) return empty;

  const seedLimit = Math.max(k * 4, 24);
  let lex = store.searchNodes(match, { datasets, kinds, limit: seedLimit });
  // A code-shaped query may only match File/Symbol nodes; retry unconstrained
  // before giving up rather than returning nothing.
  if (!lex.length && kinds?.length) lex = store.searchNodes(match, { datasets, limit: seedLimit });
  const lexEdges = store.searchEdges(match, { datasets, limit: 20 });

  const vectorHits = mode === 'lexical' || !q.embedder
    ? []
    : await vectorSeeds(store, q.embedder, datasets, q.query, seedLimit);

  if (!lex.length && !vectorHits.length) return empty;

  // --- fuse seeds (RRF) -----------------------------------------------------
  const seeds = new Map<string, { node: MemoryNode; lexRank?: number; vecRank?: number }>();
  lex.forEach((hit, i) => seeds.set(hit.node.id, { node: hit.node, lexRank: i }));
  vectorHits.forEach((hit, i) => {
    const existing = seeds.get(hit.id);
    if (existing) { existing.vecRank = i; return; }
    const node = store.getNode(hit.id);
    if (node && datasets.includes(node.dataset)) seeds.set(hit.id, { node, vecRank: i });
  });

  const rrf = (rank?: number): number => (rank == null ? 0 : 1 / (RRF_K + rank));
  let maxRrf = 0;
  for (const s of seeds.values()) maxRrf = Math.max(maxRrf, rrf(s.lexRank) + rrf(s.vecRank));
  if (!maxRrf) return empty;

  const scored = [...seeds.values()].map((s) => {
    const seedScore = (rrf(s.lexRank) + rrf(s.vecRank)) / maxRrf;
    const node = s.node;
    const base =
      0.55 * seedScore +
      0.25 * typePrior(node.node_type) +
      0.10 * clamp01(Number(node.importance ?? 0.5)) +
      0.10 * recencyScore(node.last_used_at ?? node.updated_at);
    // Feedback influence is the ONLY path from outcomes into ranking.
    const fb = 1 + influence * clampRange(Number(node.weight ?? 0), -1, 1);
    const scopePrior = node.dataset === PLATFORM_DATASET ? 0.9 : 1;
    const via: SeedVia = s.lexRank != null ? 'lexical' : 'vector';
    return { node, score: base * fb * scopePrior, via };
  });
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;
  const top: RecalledNode[] = scored.slice(0, k);
  // Keep the injected block focused: expansion may add nodes, but the whole list
  // stays within a multiple of k and above a relative relevance floor.
  const maxNodes = Math.max(k * 3, k + 8);
  const floor = topScore * 0.2;

  const kept = new Map<string, RecalledNode>(top.map((r) => [r.node.id, r]));
  const edges = new Map<string, MemoryEdge>();
  for (const e of lexEdges) edges.set(e.edge.id, e.edge);

  // --- graph expansion ------------------------------------------------------
  if (hops > 0) {
    let frontier = top.map((r) => ({ id: r.node.id, score: r.score }));
    for (let hop = 0; hop < hops; hop++) {
      const parentScore = new Map(frontier.map((f) => [f.id, f.score]));
      const ids = [...parentScore.keys()];
      const next: { id: string; score: number }[] = [];
      for (const ds of datasets) {
        for (const e of store.edgesAround(ids, ds)) {
          if (edges.size >= MAX_GRAPH_EDGES) break;
          edges.set(e.id, e);
          for (const [from, to] of [[e.source_id, e.target_id], [e.target_id, e.source_id]] as const) {
            if (!parentScore.has(from) || kept.has(to)) continue;
            if (kept.size >= Math.min(maxNodes, MAX_GRAPH_NODES)) break;
            const node = store.getNode(to);
            if (!node) continue;
            const score = (parentScore.get(from) ?? 0) * (Number(e.weight) || 1) * 0.5;
            if (score < floor) continue;
            kept.set(node.id, { node, score, via: 'graph' });
            next.push({ id: node.id, score });
          }
        }
      }
      if (!next.length) break;
      frontier = next;
    }
  }

  const nodes = [...kept.values()].sort((a, b) => b.score - a.score);
  store.touchNodes(top.map((r) => r.node.id));

  const nodeIds = new Set(nodes.map((n) => n.node.id));
  const facts = [...edges.values()].filter((e) => nodeIds.has(e.source_id) || nodeIds.has(e.target_id));
  // `contains`/`imports` are already conveyed by the node lines (a file's summary
  // lists what it defines and imports), so they are not repeated as facts.
  const renderedFacts = facts.filter((e) => e.relation !== 'contains' && e.relation !== 'imports');
  const rendered = renderMemoryBlock(nodes, renderedFacts, {
    maxChars,
    includeFacts: q.includeFacts ?? cfg.recall.includeFacts,
  });
  return { nodes, edges: facts, rendered, chars: rendered.length, mode, datasets };
}

async function vectorSeeds(
  store: MemoryStore,
  embedder: NonNullable<RecallQuery['embedder']>,
  datasets: string[],
  query: string,
  limit: number,
): Promise<{ id: string; sim: number }[]> {
  try {
    const [raw] = await embedder.embed([query.slice(0, 2000)]);
    if (!raw?.length) return [];
    const qv = Float32Array.from(raw);
    const hits: { id: string; sim: number }[] = [];
    for (const ds of datasets) {
      for (const row of store.getVectors(ds, embedder.model)) {
        hits.push({ id: row.node_id, sim: cosine(qv, row.vec) });
      }
    }
    hits.sort((a, b) => b.sim - a.sim);
    return hits.filter((h) => h.sim > 0).slice(0, limit);
  } catch {
    // A broken/misconfigured embedding endpoint must never break recall.
    return [];
  }
}

function uniqueDatasets(list: string[]): string[] {
  return [...new Set(list.filter((d) => typeof d === 'string' && d.length > 0))];
}
function clamp01(n: number): number { return clampRange(n, 0, 1); }
function clampRange(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}
