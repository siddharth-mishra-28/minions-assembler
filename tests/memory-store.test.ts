import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../src/memory/sqlite-store.js';

const dir = mkdtempSync(join(tmpdir(), 'memory-store-'));
afterEach(() => { try { store?.close(); } catch { /* already closed */ } });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });

let store: SqliteMemoryStore;
let counter = 0;
beforeEach(() => {
  store = new SqliteMemoryStore(join(dir, `s${counter++}.db`));
});
const closeAll = (): void => { try { store.close(); } catch { /* noop */ } };

describe('nodes', () => {
  it('upserts by identity (dataset + type + name) and keeps the id', () => {
    const a = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'pkgs', content: 'uses npm' });
    const b = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'pkgs', content: 'uses pnpm' });
    expect(b.id).toBe(a.id);
    expect(b.content).toBe('uses pnpm');
    expect(store.listNodes({ dataset: 'platform' })).toHaveLength(1);
    closeAll();
  });

  it('treats the same name in another dataset (or type) as a different node', () => {
    store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'x', content: '1' });
    store.upsertNode({ dataset: 'agent:a', node_type: 'Fact', name: 'x', content: '2' });
    store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'x', content: '3' });
    expect(store.listNodes({ node_type: 'Fact' })).toHaveLength(2);
    expect(store.listNodes({ dataset: 'agent:a' })).toHaveLength(1);
    closeAll();
  });

  it('keeps the FTS index in sync on update and delete', () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'f', content: 'alpha beta' });
    expect(store.searchNodes('"alpha"*', { datasets: ['platform'] })).toHaveLength(1);
    store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'f', content: 'gamma delta' });
    expect(store.searchNodes('"alpha"*', { datasets: ['platform'] })).toHaveLength(0);
    expect(store.searchNodes('"gamma"*', { datasets: ['platform'] })).toHaveLength(1);
    store.deleteNode(node.id);
    expect(store.searchNodes('"gamma"*', { datasets: ['platform'] })).toHaveLength(0);
    closeAll();
  });

  it('expands camelCase and snake_case identifiers into searchable terms', () => {
    store.upsertNode({ dataset: 'platform', node_type: 'Symbol', name: 'src/a.ts#parseApiToken', content: 'function parseApiToken' });
    for (const q of ['"api"*', '"parse"*', '"token"*', '"parseapitoken"*']) {
      expect(store.searchNodes(q, { datasets: ['platform'] }).length).toBeGreaterThan(0);
    }
    closeAll();
  });

  it('survives a malformed MATCH expression instead of throwing', () => {
    expect(store.searchNodes('"unterminated', { datasets: ['platform'] })).toEqual([]);
    closeAll();
  });
});

describe('edges', () => {
  it('dedupes edges and traverses both directions', () => {
    const a = store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'a.ts', content: '' });
    const b = store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'b.ts', content: '' });
    const e1 = store.upsertEdge({ dataset: 'platform', source_id: a.id, target_id: b.id, relation: 'imports', edge_text: 'a.ts imports b.ts' });
    const e2 = store.upsertEdge({ dataset: 'platform', source_id: a.id, target_id: b.id, relation: 'imports', weight: 2 });
    expect(e2.id).toBe(e1.id);
    expect(store.listEdges({ dataset: 'platform' })).toHaveLength(1);
    expect(store.edgesAround([b.id], 'platform')).toHaveLength(1);
    expect(store.searchEdges('"imports"*', { datasets: ['platform'] }).length).toBe(1);
    closeAll();
  });

  it('removes edges when an endpoint node is deleted', () => {
    const a = store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'a', content: '' });
    const b = store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'b', content: '' });
    store.upsertEdge({ dataset: 'platform', source_id: a.id, target_id: b.id, relation: 'imports' });
    store.deleteNode(a.id);
    expect(store.listEdges({ dataset: 'platform' })).toHaveLength(0);
    closeAll();
  });
});

describe('feedback', () => {
  it('applies an EMA weight and win/loss counters', () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'l', content: 'x' });
    store.applyFeedback([node.id], 1, 'run_1');
    expect(Number(store.getNode(node.id)?.weight)).toBeCloseTo(0.3, 5);
    store.applyFeedback([node.id], 1, 'run_2');
    expect(Number(store.getNode(node.id)?.weight)).toBeCloseTo(0.51, 5);
    store.applyFeedback([node.id], -1, 'run_3');
    expect(Number(store.getNode(node.id)?.weight)).toBeCloseTo(0.057, 5);
    const after = store.getNode(node.id);
    expect(after?.wins).toBe(2);
    expect(after?.losses).toBe(1);
    expect(store.listFeedback({ nodeId: node.id })).toHaveLength(3);
    closeAll();
  });

  it('clamps signals and ignores unknown ids', () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'f', content: 'x' });
    store.applyFeedback([node.id, 'missing'], 42, null);
    expect(Number(store.getNode(node.id)?.weight)).toBeCloseTo(0.3, 5);
    closeAll();
  });

  it('decays only weights untouched since the cutoff', () => {
    const old = store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'old', content: 'x' });
    const fresh = store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'fresh', content: 'y' });
    store.applyFeedback([old.id, fresh.id], 1, null);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const touched = store.decayWeights(future, 0.5);
    expect(touched).toBe(2);
    expect(Number(store.getNode(old.id)?.weight)).toBeCloseTo(0.15, 5);
    // With a cutoff in the past nothing is decayed.
    expect(store.decayWeights(new Date(Date.now() - 86_400_000).toISOString(), 0.5)).toBe(0);
    closeAll();
  });
});

describe('datasets, episodes, vectors, stats', () => {
  it('forgets a whole dataset without touching others', () => {
    store.upsertDataset('platform', 'platform');
    store.upsertDataset('agent:a', 'agent');
    const p = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'p', content: '' });
    const a = store.upsertNode({ dataset: 'agent:a', node_type: 'Fact', name: 'a', content: '' });
    store.upsertEdge({ dataset: 'agent:a', source_id: a.id, target_id: a.id, relation: 'related_to' });
    expect(store.deleteDataset('agent:a')).toBe(2);
    expect(store.getNode(a.id)).toBeUndefined();
    expect(store.getNode(p.id)).toBeDefined();
    expect(store.listDatasets().map((d) => d.id)).toEqual(['platform']);
    closeAll();
  });

  it('records episodes and reads them back newest first', () => {
    const ep = store.insertEpisode({ run_id: 'run_1', agent_id: 'a@1.0.0', outcome: 'failed', error: 'boom', tool_failures_json: '[]' });
    store.insertEpisode({ run_id: 'run_2', agent_id: 'a@1.0.0', outcome: 'done' });
    expect(store.listEpisodes({ agentId: 'a@1.0.0' })).toHaveLength(2);
    expect(store.listEpisodes({ runId: 'run_1' })[0].id).toBe(ep.id);
    closeAll();
  });

  it('round-trips float32 vectors', () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'v', content: 'x' });
    store.putVector(node.id, 'platform', 'm1', Float32Array.from([0.5, -0.25, 1]));
    const rows = store.getVectors('platform', 'm1');
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0].vec)).toEqual([0.5, -0.25, 1]);
    expect(store.getVectors('platform', 'other-model')).toHaveLength(0);
    closeAll();
  });

  it('counts nodes by type and dataset', () => {
    store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'a', content: '' });
    store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'b', content: '' });
    store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'l', content: '' });
    store.upsertNode({ dataset: 'agent:x', node_type: 'Fact', name: 'f', content: '' });
    const all = store.stats();
    expect(all.nodes).toBe(4);
    expect(all.files).toBe(2);
    expect(all.lessons).toBe(1);
    expect(all.byType.File).toBe(2);
    const scoped = store.stats('platform');
    expect(scoped.nodes).toBe(3);
    expect(scoped.files).toBe(2);
    closeAll();
  });

  it('stores and reads meta values', () => {
    store.setMeta('k', 'v1');
    store.setMeta('k', 'v2');
    expect(store.getMeta('k')).toBe('v2');
    expect(store.getMeta('missing')).toBeUndefined();
    closeAll();
  });
});
