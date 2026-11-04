import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Memory API contract: config layering, node curation, recall, code-graph
 * indexing, feedback, promotion and forget — all against a REAL in-process
 * server on a temp SQLite database (same pattern as inline-routes.test.ts).
 */
let dir: string;
let app: import('fastify').FastifyInstance;
let fixture: string;

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memory-routes-'));
  fixture = join(dir, 'fixture');
  put(fixture, 'src/a.ts', "import { beta } from './b';\nexport function alpha() { return beta(); }\n");
  put(fixture, 'src/b.ts', 'export function beta() { return 1; }\n');

  const { buildServer } = await import('../src/server.js');
  const built = await buildServer(join(dir, 't.db'));
  app = built.app;
});

afterAll(async () => {
  try { await app.close(); } catch { /* noop */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
});

describe('GET/PUT /api/memory/config', () => {
  it('returns code defaults and the platform layer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { platform: { retrieval: { mode: string }; recall: { k: number }; codeGraph: { dataset: string } }; defaults: { enabled: boolean } };
    expect(body.platform.retrieval.mode).toBe('lexical');
    expect(body.defaults.enabled).toBe(true);
    expect(body.platform.recall.k).toBe(8);
    // The code graph is shared knowledge by default (one copy for all agents).
    expect(body.platform.codeGraph.dataset).toBe('platform');
  });

  it('deep-merges and clamps a platform patch', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/memory/config',
      payload: { recall: { k: 999 }, feedbackInfluence: 5, retrieval: { mode: 'nonsense' } },
    });
    expect(res.statusCode).toBe(200);
    const platform = (res.json() as { platform: { recall: { k: number }; feedbackInfluence: number; retrieval: { mode: string } } }).platform;
    expect(platform.recall.k).toBe(50);
    expect(platform.feedbackInfluence).toBe(1);
    expect(platform.retrieval.mode).toBe('lexical'); // enum falling back to current value
    // Restore the default for later assertions.
    await app.inject({ method: 'PUT', url: '/api/memory/config', payload: { recall: { k: 8 }, feedbackInfluence: 0.15 } });
  });
});

describe('nodes + search', () => {
  it('creates, lists, filters and deletes a node', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/memory/nodes',
      payload: { dataset: 'platform', node_type: 'Fact', name: 'fact:pkg-manager', content: 'quarantine uses npm', node_set: 'conventions' },
    });
    expect(created.statusCode).toBe(200);
    const node = created.json() as { id: string; dataset: string; names?: string };
    expect(node.id).toMatch(/^mem_/);

    const list = await app.inject({ method: 'GET', url: '/api/memory/nodes?dataset=platform&type=Fact' });
    expect((list.json() as { nodes: unknown[] }).nodes).toHaveLength(1);

    const filtered = await app.inject({ method: 'GET', url: '/api/memory/nodes?q=nomatch' });
    expect((filtered.json() as { nodes: unknown[] }).nodes).toHaveLength(0);

    const removed = await app.inject({ method: 'DELETE', url: `/api/memory/nodes/${node.id}` });
    expect((removed.json() as { deleted: boolean }).deleted).toBe(true);
    const missing = await app.inject({ method: 'DELETE', url: `/api/memory/nodes/${node.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('returns 400 for an incomplete node payload', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/nodes', payload: { dataset: 'platform' } });
    expect(res.statusCode).toBe(400);
  });

  it('recalls with the rendered block and the node list', async () => {
    await app.inject({
      method: 'POST', url: '/api/memory/nodes',
      payload: { dataset: 'platform', node_type: 'Lesson', name: 'lesson:bash:zz', content: 'intermittent sandbox flake', node_set: 'pitfalls' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/memory/search', payload: { query: 'sandbox flake' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: { name: string }[]; rendered: string; mode: string };
    expect(body.mode).toBe('lexical');
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.rendered).toContain('Known pitfalls');
  });

  it('rejects an empty search query', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/search', payload: { query: '' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('code graph', () => {
  it('indexes a tree over HTTP and exposes neighbourhoods', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/index', payload: { root: fixture, dataset: 'fixture' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: number; symbols: number; edges: number };
    expect(body.files).toBeGreaterThanOrEqual(2);
    expect(body.symbols).toBeGreaterThanOrEqual(2);

    const graph = await app.inject({ method: 'GET', url: '/api/memory/graph?path=src/a.ts&dataset=fixture&depth=1' });
    expect(graph.statusCode).toBe(200);
    const g = graph.json() as { nodes: { name: string }[]; edges: { relation: string }[] };
    expect(g.nodes.map((n) => n.name)).toContain('src/b.ts');
    expect(g.edges.some((e) => e.relation === 'imports')).toBe(true);
  });

  it('400s for a root that does not exist instead of silently indexing nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/index', payload: { root: join(dir, 'nope'), dataset: 'fixture' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('root not found');
  });

  it('404s for an unindexed path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/graph?path=src/nope.ts&dataset=fixture' });
    expect(res.statusCode).toBe(404);
  });
});

describe('lessons, feedback, promotion, forget', () => {
  it('records a manual lesson', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memory/lessons',
      payload: { text: 'run npm ci before tests', trigger: 'npm test ENOENT' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toContain('lesson:manual:');
  });

  it('applies operator feedback to explicit node ids', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/memory/nodes',
      payload: { dataset: 'agent:x', node_type: 'Fact', name: 'fact:fb', content: 'feedback target' },
    });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({ method: 'POST', url: '/api/memory/feedback', payload: { nodeIds: [id], signal: 1 } });
    expect((res.json() as { updated: number }).updated).toBe(1);
    const nodes = await app.inject({ method: 'GET', url: '/api/memory/nodes?dataset=agent:x' });
    expect((nodes.json() as { nodes: { weight: number }[] }).nodes[0].weight).toBeCloseTo(0.3, 5);
  });

  it('400s when there is nothing to score', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/feedback', payload: { signal: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('promotes an agent node into the platform dataset, then forgets the dataset', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/memory/nodes',
      payload: { dataset: 'agent:y', node_type: 'Lesson', name: 'lesson:promote', content: 'shared wisdom' },
    });
    const id = (created.json() as { id: string }).id;

    const promote = await app.inject({ method: 'POST', url: '/api/memory/promote', payload: { id } });
    expect(promote.statusCode).toBe(200);
    expect((promote.json() as { dataset: string }).dataset).toBe('platform');

    const platformNodes = await app.inject({ method: 'GET', url: '/api/memory/nodes?dataset=platform&q=promote' });
    expect((platformNodes.json() as { nodes: unknown[] }).nodes).toHaveLength(1);

    const forget = await app.inject({ method: 'POST', url: '/api/memory/forget', payload: { dataset: 'agent:y' } });
    expect((forget.json() as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    const after = await app.inject({ method: 'GET', url: '/api/memory/nodes?dataset=agent:y' });
    expect((after.json() as { nodes: unknown[] }).nodes).toHaveLength(0);
  });

  it('runs improve and reports what it did', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memory/improve', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { decayed: number; coChangeEdges: number; promoted: number };
    expect(typeof body.decayed).toBe('number');
    expect(typeof body.coChangeEdges).toBe('number');
    expect(typeof body.promoted).toBe('number');
  });
});

describe('stats + episodes + datasets', () => {
  it('reports counts and the dataset registry', async () => {
    const stats = await app.inject({ method: 'GET', url: '/api/memory/stats' });
    expect((stats.json() as { stats: { nodes: number } }).stats.nodes).toBeGreaterThan(0);
    const datasets = await app.inject({ method: 'GET', url: '/api/memory/datasets' });
    expect((datasets.json() as { datasets: { id: string }[] }).datasets.map((d) => d.id)).toContain('platform');
  });

  it('lists captured episodes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/episodes' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { episodes: unknown[] }).episodes)).toBe(true);
  });
});
