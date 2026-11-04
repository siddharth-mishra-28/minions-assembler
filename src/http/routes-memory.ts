import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  DEFAULT_MEMORY_CONFIG, PLATFORM_DATASET, loadPlatformDefaults, savePlatformDefaults,
} from '../memory/config.js';
import { indexCodeGraph } from '../memory/code-index.js';
import { resolveEmbeddingProvider } from '../memory/embeddings.js';
import { improve } from '../memory/lessons.js';
import { recall } from '../memory/retrieve.js';
import { slug } from '../memory/text.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryConfig, MemoryNodeType } from '../memory/types.js';
import { errorSchema } from './route-schemas.js';

/**
 * Memory route group: inspect and curate the knowledge graph, tune the platform
 * defaults, and drive the pipelines (index / improve / forget) from the outside.
 * All state lives in SQLite; nothing here can drop a table.
 */
export async function registerMemoryRoutes(app: FastifyInstance, ctx: { store: MemoryStore }): Promise<void> {
  const { store } = ctx;

  /** Platform defaults are the DB-editable layer every agent inherits. */
  const platformConfig = (): MemoryConfig => loadPlatformDefaults(store);

  app.get('/api/memory/config', {
    schema: {
      tags: ['memory'],
      summary: 'Memory configuration (platform defaults + code defaults)',
      description: 'Effective platform defaults come from mem_meta and are overridable per agent via the definition\'s `memory` block.',
    },
  }, async () => ({
    platform: platformConfig(),
    defaults: DEFAULT_MEMORY_CONFIG,
    datasets: store.listDatasets(),
  }));

  app.put('/api/memory/config', {
    schema: {
      tags: ['memory'],
      summary: 'Update platform memory defaults',
      description: 'Deep-merges the body over the current platform defaults, clamps every value, and saves it to mem_meta. Applies to every agent that does not override the key in its definition.',
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req) => {
    const saved = savePlatformDefaults(store, req.body ?? {});
    return { platform: saved };
  });

  app.get('/api/memory/stats', {
    schema: {
      tags: ['memory'],
      summary: 'Node/edge/episode counts (optionally per dataset)',
      querystring: { type: 'object', properties: { dataset: { type: 'string' } } },
    },
  }, async (req) => {
    const q = req.query as { dataset?: string };
    return { stats: store.stats(q.dataset || undefined) };
  });

  app.get('/api/memory/datasets', {
    schema: { tags: ['memory'], summary: 'List memory datasets (isolation boundaries)' },
  }, async () => ({ datasets: store.listDatasets() }));

  app.get('/api/memory/nodes', {
    schema: {
      tags: ['memory'],
      summary: 'List memory nodes',
      querystring: {
        type: 'object',
        properties: {
          dataset: { type: 'string', example: 'agent:full-stack-engineer' },
          type: { type: 'string', description: 'Node type (File/Symbol/Package/Fact/Lesson/Preference)' },
          q: { type: 'string', description: 'Substring match on node name' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          orderBy: { type: 'string', enum: ['recent', 'weight', 'name'] },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { dataset?: string; type?: string; q?: string; limit?: string; orderBy?: 'recent' | 'weight' | 'name' };
    return {
      nodes: store.listNodes({
        dataset: q.dataset || undefined,
        node_type: q.type ? q.type as MemoryNodeType : undefined,
        nameContains: q.q || undefined,
        limit: Number(q.limit ?? 100),
        orderBy: q.orderBy,
      }),
    };
  });

  app.post('/api/memory/nodes', {
    schema: {
      tags: ['memory'],
      summary: 'Create or update a memory node (identity: dataset + type + name)',
      body: {
        type: 'object',
        required: ['dataset', 'node_type', 'name'],
        properties: {
          dataset: { type: 'string', example: 'platform' },
          node_type: { type: 'string', enum: ['File', 'Symbol', 'Package', 'Fact', 'Lesson', 'Preference', 'Task'] },
          name: { type: 'string' },
          content: { type: 'string' },
          node_set: { type: 'string', description: 'Tag (Cognee NodeSet): code|pitfalls|conventions|deps' },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          properties: { type: 'object', additionalProperties: true },
        },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      dataset?: string; node_type?: string; name?: string; content?: string; node_set?: string;
      importance?: number; properties?: Record<string, unknown>;
    };
    if (!body.dataset || !body.node_type || !body.name) {
      return reply.code(400).send({ error: 'dataset, node_type and name are required' });
    }
    const node = store.upsertNode({
      dataset: body.dataset,
      node_type: body.node_type as MemoryNodeType,
      name: body.name,
      content: body.content ?? null,
      node_set: body.node_set ?? null,
      importance: body.importance,
      properties_json: body.properties ? JSON.stringify(body.properties) : null,
    });
    return node;
  });

  app.delete('/api/memory/nodes/:id', {
    schema: {
      tags: ['memory'],
      summary: 'Delete one memory node (and its edges)',
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getNode(id)) return reply.code(404).send({ error: `memory node not found: ${id}` });
    return { deleted: store.deleteNode(id), id };
  });

  app.post('/api/memory/search', {
    schema: {
      tags: ['memory'],
      summary: 'Recall from memory (lexical seeds + graph expansion)',
      description: 'Uses the platform retrieval mode. With no embedding provider configured the vector channel is skipped and results are pure lexical+graph.',
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          datasets: { type: 'array', items: { type: 'string' } },
          kinds: { type: 'array', items: { type: 'string' } },
          k: { type: 'integer', minimum: 1, maximum: 50 },
          hops: { type: 'integer', minimum: 0, maximum: 3 },
        },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { query?: string; datasets?: string[]; kinds?: string[]; k?: number; hops?: number };
    if (!body.query?.trim()) return reply.code(400).send({ error: 'query is required' });
    const cfg = platformConfig();
    const datasetList = body.datasets?.length ? body.datasets : store.listDatasets().map((d) => d.id);
    const result = await recall(store, { ...cfg }, {
      query: body.query,
      datasets: datasetList,
      kinds: body.kinds?.length ? body.kinds as MemoryNodeType[] : undefined,
      k: body.k,
      hops: body.hops,
      mode: cfg.retrieval.mode,
      embedder: resolveEmbeddingProvider(cfg.retrieval.embedding),
    });
    return {
      mode: result.mode,
      datasets: result.datasets,
      chars: result.chars,
      nodes: result.nodes.map((r) => ({
        id: r.node.id, type: r.node.node_type, name: r.node.name, dataset: r.node.dataset,
        content: r.node.content, score: Number(r.score.toFixed(3)), via: r.via,
      })),
      edges: result.edges.map((e) => ({ relation: e.relation, text: e.edge_text })),
      rendered: result.rendered,
    };
  });

  app.get('/api/memory/graph', {
    schema: {
      tags: ['memory'],
      summary: 'Node neighbourhood (by id, or by file path)',
      querystring: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          dataset: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        },
      },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const q = req.query as { id?: string; path?: string; dataset?: string; depth?: string };
    const depth = Math.max(1, Math.min(3, Number(q.depth ?? 1)));
    let node = q.id ? store.getNode(q.id) : undefined;
    if (!node && q.path) {
      const dataset = q.dataset || PLATFORM_DATASET;
      node = store.findNode(dataset, 'File', q.path.replace(/^\.\//, '').replace(/\\/g, '/'));
    }
    if (!node) return reply.code(404).send({ error: 'memory node not found (index the workspace first: POST /api/memory/index)' });
    const seen = new Map([[node.id, node]]);
    let frontier = [node.id];
    const edges = [];
    for (let hop = 0; hop < depth; hop++) {
      const around = store.edgesAround(frontier, node.dataset);
      edges.push(...around);
      const next: string[] = [];
      for (const e of around) {
        for (const id of [e.source_id, e.target_id]) {
          if (seen.has(id)) continue;
          const n = store.getNode(id);
          if (!n) continue;
          seen.set(id, n);
          next.push(id);
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    const uniqueEdges = [...new Map(edges.map((e) => [e.id, e])).values()];
    return {
      root: node.id,
      nodes: [...seen.values()].map((n) => ({ id: n.id, type: n.node_type, name: n.name, dataset: n.dataset, content: n.content })),
      edges: uniqueEdges.map((e) => ({ id: e.id, source: e.source_id, target: e.target_id, relation: e.relation, weight: e.weight, text: e.edge_text })),
    };
  });

  app.post('/api/memory/index', {
    schema: {
      tags: ['memory'],
      summary: 'Build/refresh the code graph',
      description: 'Incremental: unchanged files (sha256) are skipped, and a full scan removes File nodes whose path no longer exists. Symbols/imports are regex-extracted (no AST).',
      body: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Root to index (default: platform codeGraph.root, resolved against cwd)' },
          dataset: { type: 'string', description: 'Dataset to write into (default: platform)' },
          removeStale: { type: 'boolean', default: true },
        },
      },
      response: { 400: { ...errorSchema, description: 'Root does not exist' } },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { root?: string; dataset?: string; removeStale?: boolean };
    const cfg = platformConfig();
    const root = body.root ? resolvePath(body.root) : resolvePath(cfg.codeGraph.root || '.');
    if (!existsSync(root)) return reply.code(400).send({ error: `root not found: ${root}` });
    const result = indexCodeGraph(store, {
      root,
      dataset: body.dataset || PLATFORM_DATASET,
      include: cfg.codeGraph.include,
      exclude: cfg.codeGraph.exclude,
      maxFiles: cfg.codeGraph.maxFiles,
      symbols: cfg.codeGraph.symbols,
      removeStale: body.removeStale !== false,
    });
    return result;
  });

  app.get('/api/memory/episodes', {
    schema: {
      tags: ['memory'],
      summary: 'Captured run episodes (the raw evidence lessons come from)',
      querystring: {
        type: 'object',
        properties: {
          runId: { type: 'string' }, agentId: { type: 'string' }, threadId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { runId?: string; agentId?: string; threadId?: string; limit?: string };
    return { episodes: store.listEpisodes({ runId: q.runId, agentId: q.agentId, threadId: q.threadId, limit: Number(q.limit ?? 50) }) };
  });

  app.post('/api/memory/lessons', {
    schema: {
      tags: ['memory'],
      summary: 'Record a lesson manually',
      body: {
        type: 'object',
        required: ['text', 'trigger'],
        properties: {
          text: { type: 'string' },
          trigger: { type: 'string' },
          dataset: { type: 'string', description: 'Default: platform' },
        },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string; trigger?: string; dataset?: string };
    if (!body.text?.trim() || !body.trigger?.trim()) return reply.code(400).send({ error: 'text and trigger are required' });
    const node = store.upsertNode({
      dataset: body.dataset || PLATFORM_DATASET,
      node_type: 'Lesson',
      name: `lesson:manual:${slug(body.trigger)}`,
      content: body.text.trim().slice(0, 600),
      node_set: 'pitfalls',
      properties_json: JSON.stringify({ manual: true, trigger: body.trigger.trim().slice(0, 300) }),
      importance: 0.7,
    });
    return node;
  });

  app.post('/api/memory/feedback', {
    schema: {
      tags: ['memory'],
      summary: 'Record an outcome signal for a run (or explicit node ids)',
      description: 'Signal is +1..-1. Applied as an EMA to each node\'s weight, which is a ranking signal only — it never retrains anything.',
      body: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          nodeIds: { type: 'array', items: { type: 'string' } },
          signal: { type: 'number', minimum: -1, maximum: 1 },
        },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { runId?: string; nodeIds?: string[]; signal?: number };
    const signal = Number(body.signal ?? 1);
    if (!Number.isFinite(signal)) return reply.code(400).send({ error: 'signal must be a number between -1 and 1' });
    let ids = body.nodeIds ?? [];
    if (!ids.length && body.runId) {
      const episode = store.listEpisodes({ runId: body.runId, limit: 1 })[0];
      if (episode?.memory_injected_json) {
        try { ids = JSON.parse(episode.memory_injected_json) as string[]; } catch { ids = []; }
      }
    }
    if (!ids.length) return reply.code(400).send({ error: 'no nodes to score — pass nodeIds or a runId with a captured episode' });
    const updated = store.applyFeedback(ids, signal, body.runId ?? null, 'operator');
    return { updated, signal };
  });

  app.post('/api/memory/improve', {
    schema: {
      tags: ['memory'],
      summary: 'Run the improve pass (decay, co-change edges, cross-agent lesson promotion)',
      body: { type: 'object', properties: { dataset: { type: 'string' } } },
    },
  }, async (req) => {
    const body = (req.body ?? {}) as { dataset?: string };
    return improve(store, platformConfig(), { dataset: body.dataset });
  });

  app.post('/api/memory/promote', {
    schema: {
      tags: ['memory'],
      summary: 'Copy a node into the shared platform dataset',
      description: 'The operator path for sharing agent learning across the fleet (agents cannot write to the platform dataset unless their definition opts in).',
      body: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) return reply.code(400).send({ error: 'id is required' });
    const node = store.getNode(body.id);
    if (!node) return reply.code(404).send({ error: `memory node not found: ${body.id}` });
    if (node.dataset === PLATFORM_DATASET) return reply.code(400).send({ error: 'node already belongs to the platform dataset' });
    const promoted = store.upsertNode({
      dataset: PLATFORM_DATASET,
      node_type: node.node_type,
      name: node.name,
      content: node.content,
      node_set: node.node_set,
      properties_json: JSON.stringify({ promoted_from: [node.dataset], promoted_at: new Date().toISOString() }),
      importance: Math.max(Number(node.importance), 0.6),
    });
    return { promoted: true, id: promoted.id, dataset: promoted.dataset };
  });

  app.post('/api/memory/forget', {
    schema: {
      tags: ['memory'],
      summary: 'Delete memory (one node, or a whole dataset)',
      description: 'Row deletes only — schema and other datasets are untouched.',
      body: {
        type: 'object',
        properties: { id: { type: 'string' }, dataset: { type: 'string' } },
      },
      response: { 400: errorSchema },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; dataset?: string };
    if (!body.id && !body.dataset) return reply.code(400).send({ error: 'pass id or dataset' });
    if (body.id) return { deleted: store.deleteNode(body.id) ? 1 : 0, id: body.id };
    const removed = store.deleteDataset(body.dataset!);
    return { deleted: removed, dataset: body.dataset };
  });
}
