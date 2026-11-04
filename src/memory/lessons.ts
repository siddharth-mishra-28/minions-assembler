import { PLATFORM_DATASET } from './config.js';
import { clip, slug, stripControl } from './text.js';
import type { MemoryStore } from './store.js';
import type { MemoryEpisode, MemoryNode, ResolvedMemoryConfig, ToolFailure } from './types.js';

/**
 * Mistake-avoidance pipeline.
 *
 * capture (episode) → distill (lesson) → feedback (weight) → improve (promote/co-change).
 *
 * Distillation is evidence-based on purpose: a lesson records what actually failed
 * and what actually worked next. It never invents a causal explanation, so a wrong
 * hypothesis cannot ossify into "knowledge".
 */

export interface Observation {
  tool: string;
  args?: unknown;
  success?: boolean;
  error?: string;
  command?: string;
  path?: string;
}

/** Normalize an error message to a stable shape (paths/line numbers/ids removed). */
export function normalizeErrorMessage(message: string): string {
  return stripControl(String(message ?? ''))
    .replace(/[A-Za-z]:\\[^\s:'"]+/g, '<path>')
    .replace(/(?:\.{0,2}\/[\w.@-]+){2,}\/?/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+:\d+\b/g, ':L:C')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160);
}

/** Stable identity for "this tool failed this way" — survives machines, paths, reruns. */
export function errorSignature(tool: string, message: string): string {
  return `${String(tool || 'tool').toLowerCase()}:${slug(normalizeErrorMessage(message), 12)}`;
}

export interface DistillResult {
  lessons: MemoryNode[];
  promoted: number;
}

/**
 * Derive/merge lessons for one finished episode.
 *
 * `summarize` is the opt-in LLM path (`distill: 'llm'`); when it returns text the
 * lesson body is that summary instead of the heuristic sentence.
 */
export async function distillEpisode(
  store: MemoryStore,
  cfg: ResolvedMemoryConfig,
  episode: MemoryEpisode,
  observations: Observation[],
  opts?: { summarize?: (input: { episode: MemoryEpisode; failures: ToolFailure[] }) => Promise<string | undefined> },
): Promise<DistillResult> {
  const lessons: MemoryNode[] = [];
  if (cfg.distill === 'off') return { lessons, promoted: 0 };

  const dataset = `agent:${(episode.agent_id ?? 'unknown').split('@')[0]}`;
  const failures = collectFailures(observations, cfg.capture.commands);
  if (!failures.length) return { lessons, promoted: 0 };

  let summary: string | undefined;
  if (cfg.distill === 'llm' && opts?.summarize) {
    try { summary = await opts.summarize({ episode, failures }); } catch { summary = undefined; }
  }

  const seenThisEpisode = new Set<string>();
  for (const f of failures) {
    const sig = errorSignature(f.tool, f.error);
    if (seenThisEpisode.has(sig)) continue;
    seenThisEpisode.add(sig);

    const recovery = findRecovery(observations, f);
    const existing = store.findNode(dataset, 'Lesson', `lesson:${sig}`);
    const prev = existing?.properties_json ? safeJson(existing.properties_json) : undefined;
    const seen = Number(prev?.seen ?? 0) + 1;
    const firstLine = clip(f.error.split('\n')[0] ?? f.error, 200);
    const heuristic = recovery
      ? `When \`${f.tool}\` failed with "${firstLine}", retrying with \`${clip(recovery, 160)}\` succeeded.`
      : `When \`${f.tool}\` failed with "${firstLine}", the run did not recover — check this before retrying.`;
    const content = summary ? `${summary} (evidence: ${clip(firstLine, 140)})` : heuristic;
    const node = store.upsertNode({
      dataset,
      node_type: 'Lesson',
      name: `lesson:${sig}`,
      content: clip(content, 600),
      node_set: 'pitfalls',
      properties_json: JSON.stringify({
        seen,
        recovered: Boolean(recovery),
        tool: f.tool,
        signature: sig,
        last_error: firstLine,
        last_command: f.command ?? null,
        recovery: recovery ?? null,
        files: uniqueFiles(observations).slice(0, 5),
      }),
      importance: 0.65,
      source_run_id: episode.run_id ?? null,
      source_path: f.path ?? null,
    });
    lessons.push(node);
  }

  const promoted = promoteLessonsSync(store, cfg, dataset);
  return { lessons, promoted };
}

/** Recoveries: a later successful call to the same tool in the same episode. */
function findRecovery(observations: Observation[], failure: ToolFailure): string | undefined {
  const start = observations.findIndex((o) => o.tool === failure.tool && !o.success && o.error === failure.error);
  const from = start >= 0 ? start + 1 : 0;
  for (let i = from; i < observations.length; i++) {
    const o = observations[i];
    if (o.tool !== failure.tool || o.success !== true) continue;
    const attempt = o.command ?? o.path;
    if (attempt) return attempt;
  }
  return undefined;
}

export function collectFailures(observations: Observation[], withCommands = true): ToolFailure[] {
  const out: ToolFailure[] = [];
  for (const o of observations) {
    if (o.success !== false) continue;
    const error = o.error?.trim() || `${o.tool} reported failure`;
    out.push({
      tool: o.tool,
      args: o.args,
      error,
      command: withCommands ? o.command : undefined,
      path: o.path,
    });
  }
  return out;
}

export function uniqueFiles(observations: Observation[]): string[] {
  return [...new Set(observations.map((o) => o.path).filter((p): p is string => Boolean(p)))];
}

/** Apply ±1 outcome signals to every node a run actually used. Ranking only, never retraining. */
export function applyRunFeedback(
  store: MemoryStore,
  nodeIds: string[],
  outcome: 'done' | 'failed' | 'aborted',
  runId?: string | null,
): number {
  if (!nodeIds.length) return 0;
  const signal = outcome === 'done' ? 1 : -1;
  return store.applyFeedback(nodeIds, signal, runId ?? null, 'run-outcome');
}

export interface ImproveReport {
  decayed: number;
  coChangeEdges: number;
  promoted: number;
}

/**
 * `improve()` — the memify analog, run on demand (CLI/API) rather than per run:
 *   1. decay feedback weight for nodes untouched for 30+ days
 *   2. rebuild `co_change` edges from episode file history
 *   3. promote lessons learned by N distinct agents into the shared dataset
 */
export function improve(
  store: MemoryStore,
  cfg: ResolvedMemoryConfig,
  opts: { dataset?: string; now?: number } = {},
): ImproveReport {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - 30 * 86_400_000).toISOString();
  const decayed = store.decayWeights(cutoff, 0.98);

  const dataset = opts.dataset;
  let coChangeEdges = 0;
  if (dataset) {
    coChangeEdges = buildCoChangeEdges(store, dataset);
  }
  const promoted = promoteLessonsSync(store, cfg, dataset);
  return { decayed, coChangeEdges, promoted };
}

function buildCoChangeEdges(store: MemoryStore, dataset: string): number {
  const agentId = dataset.startsWith('agent:') ? `${dataset.slice('agent:'.length)}@` : undefined;
  const episodes = agentId
    ? store.listEpisodes({ limit: 500 }).filter((e) => (e.agent_id ?? '').startsWith(agentId))
    : store.listEpisodes({ limit: 500 });
  const pairs = new Map<string, { a: string; b: string; count: number }>();
  for (const episode of episodes) {
    const files = parseJsonArray(episode.files_touched_json).slice(0, 20).sort();
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}|${files[j]}`;
        const entry = pairs.get(key) ?? { a: files[i], b: files[j], count: 0 };
        entry.count++;
        pairs.set(key, entry);
      }
    }
  }
  let created = 0;
  for (const { a, b, count } of pairs.values()) {
    if (count < 2) continue;
    // The code graph normally lives in the shared platform dataset; fall back to it
    // so co-change edges still resolve for agent-scoped memory.
    const from = store.findNode(dataset, 'File', a) ?? store.findNode(PLATFORM_DATASET, 'File', a);
    const to = store.findNode(dataset, 'File', b) ?? store.findNode(PLATFORM_DATASET, 'File', b);
    if (!from || !to || from.id === to.id) continue;
    store.upsertEdge({
      dataset,
      source_id: from.id,
      target_id: to.id,
      relation: 'co_change',
      edge_text: `${a} and ${b} change together (${count} runs)`,
      weight: count,
      properties_json: JSON.stringify({ observations: count }),
    });
    created++;
  }
  return created;
}

/**
 * Promote lessons that N distinct agents independently learned into the platform
 * dataset. This is how shared memory becomes real without any single agent being
 * able to poison the platform pool.
 */
function promoteLessonsSync(store: MemoryStore, cfg: ResolvedMemoryConfig, dataset?: string): number {
  const threshold = cfg.lessons.autoPromoteAcrossAgents;
  if (threshold <= 0) return 0;
  const lessons = store.listNodes({ node_type: 'Lesson', limit: 50000 });
  const byName = new Map<string, MemoryNode[]>();
  for (const node of lessons) {
    if (node.dataset === PLATFORM_DATASET) continue;
    const list = byName.get(node.name) ?? [];
    list.push(node);
    byName.set(node.name, list);
  }
  let promoted = 0;
  for (const [name, nodes] of byName) {
    const datasets = new Set(nodes.map((n) => n.dataset));
    if (datasets.size < threshold) continue;
    if (store.findNode(PLATFORM_DATASET, 'Lesson', name)) continue;
    // Prefer the lesson from the dataset that triggered this pass; else the most weighted.
    const source = (dataset ? nodes.find((n) => n.dataset === dataset) : undefined)
      ?? [...nodes].sort((a, b) => Number(b.weight) - Number(a.weight))[0];
    store.upsertNode({
      dataset: PLATFORM_DATASET,
      node_type: 'Lesson',
      name,
      content: source.content,
      node_set: 'pitfalls',
      properties_json: JSON.stringify({ promoted_from: [...datasets].sort(), seen_across_agents: datasets.size }),
      importance: Math.max(0.6, Number(source.importance)),
    });
    promoted++;
  }
  return promoted;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
}

function safeJson(raw: string): { seen?: number } | undefined {
  try { return JSON.parse(raw) as { seen?: number }; } catch { return undefined; }
}
