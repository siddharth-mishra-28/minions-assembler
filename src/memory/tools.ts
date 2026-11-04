import { PLATFORM_DATASET } from './config.js';
import { resolveEmbeddingProvider } from './embeddings.js';
import { recall } from './retrieve.js';
import { clip, slug } from './text.js';
import type { MemoryStore } from './store.js';
import type { EmbeddingProvider, MemoryNodeType, ResolvedMemoryConfig } from './types.js';

/**
 * Agent-facing memory tools. Injected like the coding-harness tools, so an agent
 * can consult the graph mid-task and record what it learns. `skipPermission` is
 * safe here: writes are confined to the resolved dataset and capped in size.
 */
export interface MemoryTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  skipPermission?: boolean;
  overridesBuiltInTool?: boolean;
  defer?: 'never' | 'auto';
}

export interface MemoryToolContext {
  store: MemoryStore;
  config: ResolvedMemoryConfig;
  /** The agent's own dataset (`agent:<name>`). */
  dataset: string;
  runId?: string;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Test seam; defaults to resolving from config (null when embeddings are off). */
  embedder?: EmbeddingProvider | null;
}

export const MEMORY_TOOL_NAMES = ['memory_search', 'memory_note', 'memory_lesson', 'memory_links'] as const;

export function buildMemoryTools(ctx: MemoryToolContext): MemoryTool[] {
  const { store, config } = ctx;
  const readDatasets = (): string[] => {
    const out: string[] = [];
    if (config.scope.agent) out.push(ctx.dataset);
    if (config.scope.platform) out.push(PLATFORM_DATASET);
    if (config.scope.crossAgentRead) {
      for (const ds of store.listDatasets()) {
        if (ds.id.startsWith('agent:') && ds.id !== ctx.dataset) out.push(ds.id);
      }
    }
    return out;
  };
  const writeDataset = (): string =>
    config.scope.writeTarget === 'platform' ? PLATFORM_DATASET : ctx.dataset;
  const embedder = ctx.embedder !== undefined
    ? ctx.embedder
    : config.retrieval.mode === 'lexical'
      ? null
      : resolveEmbeddingProvider(config.retrieval.embedding);
  const log = (type: string, payload: Record<string, unknown>): void => {
    try { ctx.onEvent?.(type, payload); } catch { /* best-effort */ }
  };

  const search: MemoryTool = {
    name: 'memory_search',
    description:
      'Search long-term memory (learned lessons, project facts, and the code graph of files/symbols/imports). ' +
      'Use it before repeating work: e.g. before running a command that failed earlier, or to find which files import a module. ' +
      'Returns observations from past runs — verify against the workspace before relying on them.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (identifiers, error text, file names, concepts)' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['File', 'Symbol', 'Package', 'Fact', 'Lesson', 'Preference'] },
          description: 'Optional node types to restrict to (omit for all)',
        },
        k: { type: 'number', description: 'Max results (default from memory config, max 50)' },
      },
      required: ['query'],
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('memory_search: query is required');
      const kinds = Array.isArray(args.kinds) ? args.kinds.filter((k): k is MemoryNodeType => typeof k === 'string') as MemoryNodeType[] : undefined;
      const result = await recall(store, config, {
        query,
        datasets: readDatasets(),
        kinds: kinds?.length ? kinds : config.recall.kinds,
        k: Number(args.k ?? config.recall.k),
        hops: config.recall.hops,
        maxChars: config.recall.maxChars,
        feedbackInfluence: config.feedbackInfluence,
        embedder,
      });
      log('memory.tool_search', { query: clip(query, 120), results: result.nodes.length, mode: result.mode });
      return {
        mode: result.mode,
        results: result.nodes.slice(0, 20).map((r) => ({
          type: r.node.node_type,
          name: r.node.name,
          content: clip(r.node.content ?? '', 400),
          score: Number(r.score.toFixed(3)),
          via: r.via,
          dataset: r.node.dataset,
        })),
        text: result.rendered,
      };
    },
  };

  const note: MemoryTool = {
    name: 'memory_note',
    description:
      'Record a durable fact or preference learned while working (e.g. "the app uses pnpm workspaces", ' +
      '"tests need NODE_OPTIONS=--experimental-vm-modules"). Stored in this agent\'s memory for future runs. ' +
      'Do not record secrets, credentials, or one-off task details.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, stated plainly and generically' },
        key: { type: 'string', description: 'Optional stable key so the same fact updates instead of duplicating' },
        kind: { type: 'string', enum: ['Fact', 'Preference'], description: 'Default Fact' },
      },
      required: ['text'],
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const text = clip(String(args.text ?? ''), 600);
      if (!text) throw new Error('memory_note: text is required');
      const kind = args.kind === 'Preference' ? 'Preference' : 'Fact';
      const dataset = writeDataset();
      const key = typeof args.key === 'string' && args.key.trim() ? args.key.trim() : slug(text);
      const node = store.upsertNode({
        dataset,
        node_type: kind,
        name: `${kind.toLowerCase()}:${slug(key)}`,
        content: text,
        node_set: 'conventions',
        properties_json: JSON.stringify({ key, recorded_by: ctx.dataset }),
        importance: 0.6,
        source_run_id: ctx.runId ?? null,
      });
      log('memory.tool_note', { id: node.id, dataset, kind });
      return { saved: true, id: node.id, dataset, kind, name: node.name };
    },
  };

  const lesson: MemoryTool = {
    name: 'memory_lesson',
    description:
      'Record a lesson that should prevent a future mistake. State the trigger (command/tool/error) and what to do instead. ' +
      'Lessons are surfaced automatically at the start of related runs, so keep them short and actionable.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The actionable lesson' },
        trigger: { type: 'string', description: 'The error signature / command / situation that triggers it' },
      },
      required: ['text', 'trigger'],
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const text = clip(String(args.text ?? ''), 600);
      const trigger = clip(String(args.trigger ?? ''), 300);
      if (!text || !trigger) throw new Error('memory_lesson: text and trigger are required');
      const node = store.upsertNode({
        dataset: writeDataset(),
        node_type: 'Lesson',
        name: `lesson:manual:${slug(trigger)}`,
        content: text,
        node_set: 'pitfalls',
        properties_json: JSON.stringify({ manual: true, trigger, recorded_by: ctx.dataset }),
        importance: 0.7,
        source_run_id: ctx.runId ?? null,
      });
      log('memory.tool_lesson', { id: node.id, trigger: clip(trigger, 120) });
      return { saved: true, id: node.id, name: node.name };
    },
  };

  const links: MemoryTool = {
    name: 'memory_links',
    description:
      'Look up the code graph for a file: what it imports, which files import it, what it defines, and its test file. ' +
      'Cheaper and more reliable than grepping when you need the blast radius of a change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path (e.g. src/execution/runner.ts)' },
      },
      required: ['path'],
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const raw = String(args.path ?? '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
      if (!raw) throw new Error('memory_links: path is required');
      const node = store.findNode(ctx.dataset, 'File', raw) ?? store.findNode(PLATFORM_DATASET, 'File', raw);
      if (!node) return { found: false, path: raw, hint: 'not indexed yet — run POST /api/memory/index or `minions-assembler memory index`' };
      const edges = store.edgesAround([node.id], node.dataset);
      const group = { imports: [] as string[], importedBy: [] as string[], defines: [] as string[], tests: [] as string[], testsAre: [] as string[], other: [] as string[] };
      for (const e of edges) {
        const otherId = e.source_id === node.id ? e.target_id : e.source_id;
        const other = store.getNode(otherId);
        if (!other) continue;
        const outgoing = e.source_id === node.id;
        if (e.relation === 'imports' && outgoing) group.imports.push(other.name);
        else if (e.relation === 'imports') group.importedBy.push(other.name);
        else if (e.relation === 'contains' && outgoing) group.defines.push(other.name.split('#').pop() ?? other.name);
        else if (e.relation === 'tests' && outgoing) group.tests.push(other.name);
        else if (e.relation === 'tests') group.testsAre.push(other.name);
        else group.other.push(`${e.relation}: ${other.name}`);
      }
      log('memory.tool_links', { path: raw, edges: edges.length });
      return { found: true, path: raw, dataset: node.dataset, ...group };
    },
  };

  return [search, note, lesson, links];
}
