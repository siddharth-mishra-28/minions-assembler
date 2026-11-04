import { resolve as resolvePath } from 'node:path';
import { resolveProviderApiKeyValue } from '../core/crypto.js';
import { agentDatasetName, PLATFORM_DATASET } from './config.js';
import { indexCodeGraph } from './code-index.js';
import { RunMemoryCollector } from './capture.js';
import { resolveEmbeddingProvider, vectorizeDataset } from './embeddings.js';
import { recall } from './retrieve.js';
import type { MemoryStore } from './store.js';
import { clip } from './text.js';
import type {
  EmbeddingProvider, IndexResult, MemoryConfig, MemoryEpisode, ResolvedMemoryConfig, RetrievalMode, ToolFailure,
} from './types.js';

/**
 * Per-run composition root for memory.
 *
 * Runners receive exactly one of these (or none). Keeping recall/index/collect
 * behind a small object means the run paths stay readable and the store never
 * leaks into the Copilot SDK options directly.
 */
export interface MemoryRuntime {
  store: MemoryStore;
  config: ResolvedMemoryConfig;
  agentDataset: string;
  platformDataset: string;
  collector: RunMemoryCollector;
  /** Datasets this run may read, most specific first. */
  datasets: string[];
  recall(query: string): Promise<{ block?: string; ids: string[]; mode: RetrievalMode; chars: number; datasets: string[]; nodes: number }>;
  /** Incremental code-graph refresh for the durable workspace root. */
  refreshCodeGraph(root: string, opts?: { force?: boolean }): Promise<IndexResult | undefined>;
  /** Index the files a run created (paths recorded relative to the run folder). */
  indexRunOutput(runRoot: string): Promise<IndexResult | undefined>;
  finish(outcome: 'done' | 'failed' | 'aborted'): Promise<{ lessons: number; promoted: number; feedbackApplied: number }>;
  /** Attach the audit sink once the caller knows the run id (events land in the run chain). */
  setEventSink(sink?: MemoryEventSink): void;
  /** Attach the run id once the run row exists, so the episode joins the run. */
  setRunId(runId: string): void;
}

export interface CreateRuntimeOptions {
  store: MemoryStore;
  config: ResolvedMemoryConfig;
  definition: MemoryDefinition;
  agentId: string;
  runId?: string;
  sessionId?: string;
  threadId?: string;
  task?: string;
  /** Emitted for audit events (memory.recalled, memory.captured…). */
  onEvent?: MemoryEventSink;
  /** Test seam: never hit a real embedding endpoint. */
  embedder?: EmbeddingProvider | null;
}

export type MemoryEventSink = (type: string, payload: Record<string, unknown>) => void;

/** The slice of an AgentDefinition the runtime needs (keeps this module decoupled). */
export interface MemoryDefinition {
  metadata: { name: string; tags?: string[] };
  provider?: { type: string; baseUrl?: string; model?: string; providerApiKey?: string };
  memory?: Partial<MemoryConfig>;
}

export function createMemoryRuntime(opts: CreateRuntimeOptions): MemoryRuntime {
  const { store, config, definition } = opts;
  const agentDataset = agentDatasetName(definition);
  // The code graph describes the shared repository, so it lives in the platform
  // dataset by default (one copy for every agent). `codeGraph.dataset: 'agent'`
  // keeps it private for agents with their own dedicated workspace.
  const codeDataset = config.codeGraph.dataset === 'agent' ? agentDataset : PLATFORM_DATASET;
  const embedder = opts.embedder !== undefined
    ? opts.embedder
    : config.retrieval.mode === 'lexical'
      ? null
      : resolveEmbeddingProvider(config.retrieval.embedding);

  const datasets: string[] = [];
  if (config.scope.agent) datasets.push(agentDataset);
  if (config.scope.platform) datasets.push(PLATFORM_DATASET);
  if (config.scope.crossAgentRead) {
    for (const ds of store.listDatasets()) {
      if (ds.id.startsWith('agent:') && ds.id !== agentDataset) datasets.push(ds.id);
    }
  }

  let sink: MemoryEventSink | undefined = opts.onEvent;
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try { sink?.(type, payload); } catch { /* audit must never break a run */ }
  };

  const summarize = config.distill === 'llm' ? createLlmSummarizer(definition, config) : undefined;
  const collector = new RunMemoryCollector({
    store,
    config,
    dataset: agentDataset,
    agentId: opts.agentId,
    runId: opts.runId,
    sessionId: opts.sessionId,
    threadId: opts.threadId,
    task: opts.task,
    summarize,
  });

  const runtime: MemoryRuntime = {
    store,
    config,
    agentDataset,
    platformDataset: PLATFORM_DATASET,
    collector,
    datasets,

    async recall(query) {
      const result = await recall(store, config, {
        query,
        datasets,
        kinds: config.recall.kinds,
        k: config.recall.k,
        hops: config.recall.hops,
        maxChars: config.recall.maxChars,
        feedbackInfluence: config.feedbackInfluence,
        mode: config.retrieval.mode,
        embedder,
      });
      const ids = result.nodes.map((n) => n.node.id);
      collector.setInjected(ids);
      emit('memory.recalled', {
        datasets: result.datasets,
        mode: result.mode,
        nodes: result.nodes.length,
        chars: result.chars,
        ids: ids.slice(0, 40),
      });
      return {
        block: result.rendered || undefined,
        ids,
        mode: result.mode,
        chars: result.chars,
        datasets: result.datasets,
        nodes: result.nodes.length,
      };
    },

    async refreshCodeGraph(root, refreshOpts) {
      if (!config.codeGraph.enabled) return undefined;
      if (!config.codeGraph.autoRefresh && !refreshOpts?.force) return undefined;
      // A relative codeGraph.root is workspace-relative (an absolute one wins).
      const indexRoot = config.codeGraph.root && config.codeGraph.root !== '.'
        ? resolvePath(root, config.codeGraph.root)
        : resolvePath(root);
      const result = indexCodeGraph(store, {
        root: indexRoot,
        dataset: codeDataset,
        include: config.codeGraph.include,
        exclude: config.codeGraph.exclude,
        maxFiles: config.codeGraph.maxFiles,
        symbols: config.codeGraph.symbols,
        timeBudgetMs: 3000,
        runId: opts.runId,
      });
      emit('memory.indexed', { ...result });
      if (embedder) await vectorizeNewNodes(store, embedder, codeDataset).catch(() => undefined);
      return result;
    },

    async indexRunOutput(runRoot) {
      if (!config.codeGraph.enabled) return undefined;
      // Run artifacts are the agent's own work product: keep them in its dataset so
      // they never pollute the shared repository graph.
      const result = indexCodeGraph(store, {
        root: runRoot,
        dataset: agentDataset,
        exclude: config.codeGraph.exclude,
        maxFiles: Math.min(config.codeGraph.maxFiles, 500),
        symbols: config.codeGraph.symbols,
        timeBudgetMs: 1500,
        runId: opts.runId,
        removeStale: false,
      });
      if (result.files) emit('memory.indexed_run', { ...result });
      if (embedder && result.files) await vectorizeNewNodes(store, embedder, agentDataset).catch(() => undefined);
      return result;
    },

    async finish(outcome) {
      const out = await collector.finish(outcome);
      emit('memory.captured', {
        outcome,
        episodeId: out.episode?.id ?? null,
        lessons: out.lessons.length,
        promoted: out.promoted,
        feedbackApplied: out.feedbackApplied,
      });
      return { lessons: out.lessons.length, promoted: out.promoted, feedbackApplied: out.feedbackApplied };
    },

    setEventSink(next) { sink = next; },
    setRunId(id) { collector.setRunId(id); },
  };
  return runtime;
}

/** Embed nodes that have no vector for the configured model yet (bounded per call). */
async function vectorizeNewNodes(store: MemoryStore, embedder: EmbeddingProvider, dataset: string): Promise<void> {
  const have = new Set(store.getVectors(dataset, embedder.model).map((v) => v.node_id));
  const pending = store.listNodes({ dataset, node_type: ['File', 'Symbol', 'Lesson', 'Fact'], limit: 1000 })
    .filter((n) => !have.has(n.id) && (n.content ?? '').length > 0)
    .slice(0, 100);
  if (!pending.length) return;
  await vectorizeDataset(store, embedder, dataset, pending, 100);
}

/**
 * Opt-in (`distill: 'llm'`) lesson summarizer. Uses the agent's own provider and
 * is capped to one small call per finished run. Any failure falls back to the
 * heuristic lesson, so distillation can never block a run.
 */
function createLlmSummarizer(
  definition: MemoryDefinition,
  config: ResolvedMemoryConfig,
): ((input: { episode: MemoryEpisode; failures: ToolFailure[] }) => Promise<string | undefined>) | undefined {
  const provider = definition.provider;
  if (!provider?.baseUrl || !provider.model || !provider.providerApiKey) return undefined;
  const maxChars = Math.max(200, Math.min(600, Math.floor(config.recall.maxChars / 6)));
  return async ({ episode, failures }) => {
    const key = resolveProviderApiKeyValue(provider.providerApiKey!);
    const base = provider.baseUrl!.replace(/\/+$/, '');
    const isAnthropic = provider.type === 'anthropic';
    const system = 'You write one durable engineering lesson from a failed agent run. Answer with a single imperative sentence (max 220 chars) that helps a future agent avoid the same failure. No preamble, no markdown.';
    const user = [
      `Task: ${clip(episode.task ?? '', 300)}`,
      `Outcome: ${episode.outcome}`,
      `Failures:\n${failures.slice(0, 6).map((f) => `- ${f.tool}: ${clip(f.error, 200)}${f.command ? ` (command: ${clip(f.command, 120)})` : ''}`).join('\n')}`,
    ].join('\n');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isAnthropic) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else headers.Authorization = `Bearer ${key}`;
    const body = isAnthropic
      ? { model: provider.model, max_tokens: 160, system, messages: [{ role: 'user', content: user }] }
      : { model: provider.model, max_tokens: 160, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    const res = await fetch(`${base}/${isAnthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const json = await res.json() as { choices?: { message?: { content?: string } }[]; content?: { type: string; text?: string }[] };
    const text = isAnthropic
      ? (json.content ?? []).map((c) => c.text ?? '').join(' ')
      : (json.choices?.[0]?.message?.content ?? '');
    const out = text.trim().replace(/^["'`]+|["'`]+$/g, '');
    return out ? clip(out, maxChars) : undefined;
  };
}
