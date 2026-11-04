import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../src/memory/sqlite-store.js';
import { recall } from '../src/memory/retrieve.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/memory/config.js';
import { mergeSystemMessageWithMemory, deriveRecallQuery, MEMORY_BLOCK_HEADER, renderMemoryBlock } from '../src/memory/context.js';
import type { MemoryConfig } from '../src/memory/types.js';

const dir = mkdtempSync(join(tmpdir(), 'memory-retrieve-'));
let store: SqliteMemoryStore;
let n = 0;

const cfg = (patch: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...JSON.parse(JSON.stringify(DEFAULT_MEMORY_CONFIG)) as MemoryConfig,
  ...patch,
});

beforeEach(() => { store = new SqliteMemoryStore(join(dir, `r${n++}.db`)); });
afterEach(() => { try { store.close(); } catch { /* noop */ } });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });

describe('recall', () => {
  it('returns nothing (and no block) for empty or unmatched queries', async () => {
    store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'fact:one', content: 'alpha' });
    const empty = await recall(store, cfg(), { query: '   ', datasets: ['platform'] });
    expect(empty.rendered).toBe('');
    expect(empty.nodes).toHaveLength(0);
    const miss = await recall(store, cfg(), { query: 'zzzznotpresent', datasets: ['platform'] });
    expect(miss.rendered).toBe('');
  });

  it('seeds from the FTS index and renders a bounded markdown block', async () => {
    store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'lesson:bash:abc', content: 'npm test fails before npm install', node_set: 'pitfalls' });
    const res = await recall(store, cfg(), { query: 'npm test fails', datasets: ['platform'], maxChars: 600 });
    expect(res.nodes.length).toBeGreaterThan(0);
    expect(res.rendered).toContain(MEMORY_BLOCK_HEADER.split('\n')[0]);
    expect(res.rendered).toContain('Known pitfalls');
    expect(res.rendered).toContain('npm test fails');
    expect(res.rendered.length).toBeLessThanOrEqual(600);
    expect(res.chars).toBe(res.rendered.length);
  });

  it('respects the kinds filter', async () => {
    store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'lesson:one', content: 'gamut issue' });
    store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'fact:one', content: 'gamut convention' });
    const lessons = await recall(store, cfg(), { query: 'gamut', datasets: ['platform'], kinds: ['Lesson'] });
    expect(lessons.nodes.every((r) => r.node.node_type === 'Lesson')).toBe(true);
    expect(lessons.nodes).toHaveLength(1);
    const facts = await recall(store, cfg(), { query: 'gamut', datasets: ['platform'], kinds: ['Fact'] });
    expect(facts.nodes).toHaveLength(1);
    expect(facts.nodes[0].node.node_type).toBe('Fact');
  });

  it('expands one hop through the graph and marks the origin', async () => {
    const file = store.upsertNode({ dataset: 'platform', node_type: 'File', name: 'src/zzzalpha.ts', content: 'zzzalpha module' });
    const lesson = store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'lesson:zzzbeta', content: 'zzzbeta pitfall' });
    store.upsertEdge({ dataset: 'platform', source_id: file.id, target_id: lesson.id, relation: 'caused', edge_text: 'zzzalpha caused zzzbeta' });

    const seedOnly = await recall(store, cfg(), { query: 'zzzalpha', datasets: ['platform'], hops: 0 });
    expect(seedOnly.nodes.map((r) => r.node.id)).toEqual([file.id]);

    const expanded = await recall(store, cfg(), { query: 'zzzalpha', datasets: ['platform'], hops: 1 });
    const ids = expanded.nodes.map((r) => r.node.id);
    expect(ids).toContain(file.id);
    expect(ids).toContain(lesson.id);
    expect(expanded.nodes.find((r) => r.node.id === file.id)?.via).toBe('lexical');
    expect(expanded.nodes.find((r) => r.node.id === lesson.id)?.via).toBe('graph');
  });

  it('lets past outcomes reorder recall only when feedbackInfluence is on', async () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Lesson', name: 'lesson:fb', content: 'feedback ranking sample' });
    const before = await recall(store, cfg(), { query: 'feedback ranking', datasets: ['platform'], feedbackInfluence: 0 });
    store.applyFeedback([node.id], 1, null);
    const neutral = await recall(store, cfg(), { query: 'feedback ranking', datasets: ['platform'], feedbackInfluence: 0 });
    const influenced = await recall(store, cfg(), { query: 'feedback ranking', datasets: ['platform'], feedbackInfluence: 1 });
    expect(influenced.nodes[0].score).toBeGreaterThan(neutral.nodes[0].score);
    expect(neutral.nodes[0].score).toBeCloseTo(before.nodes[0].score, 2);
  });

  it('separates datasets (agent memory never leaks into a platform-only recall)', async () => {
    store.upsertNode({ dataset: 'agent:a', node_type: 'Fact', name: 'fact:secret', content: 'quarantine marker' });
    const platformOnly = await recall(store, cfg(), { query: 'quarantine', datasets: ['platform'] });
    expect(platformOnly.nodes).toHaveLength(0);
    const both = await recall(store, cfg(), { query: 'quarantine', datasets: ['agent:a', 'platform'] });
    expect(both.nodes).toHaveLength(1);
  });

  it('counts retrieval hits on the nodes it returned', async () => {
    const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'fact:hit', content: 'hitcounter sample' });
    await recall(store, cfg(), { query: 'hitcounter', datasets: ['platform'] });
    expect(store.getNode(node.id)?.hits).toBe(1);
    expect(store.getNode(node.id)?.last_used_at).toBeTruthy();
  });
});

describe('rendering + persona merge', () => {
  it('returns an empty string when there is nothing to render', () => {
    expect(renderMemoryBlock([], [], { maxChars: 1000 })).toBe('');
  });

  it('merges into an agent without a system message as append', () => {
    const merged = mergeSystemMessageWithMemory(undefined, 'BLOCK');
    expect(merged).toEqual({ mode: 'append', content: 'BLOCK' });
  });

  it('appends to existing content and keeps replace semantics', () => {
    const append = mergeSystemMessageWithMemory({ mode: 'append', content: 'BASE' }, 'BLOCK');
    expect(append?.content).toBe('BASE\n\nBLOCK');
    expect(append?.mode).toBe('append');
    const replace = mergeSystemMessageWithMemory({ mode: 'replace', content: 'BASE' }, 'BLOCK');
    expect(replace?.content).toBe('BASE\n\nBLOCK');
    expect(replace?.mode).toBe('replace');
  });

  it('uses custom_instructions when the persona is section-based', () => {
    const merged = mergeSystemMessageWithMemory({ mode: 'customize', sections: { identity: { action: 'replace', content: 'I' } } }, 'BLOCK');
    const sections = merged?.sections as Record<string, { action: string; content?: string }>;
    expect(sections.custom_instructions.content).toBe('BLOCK');
    expect(sections.identity.content).toBe('I');
    const again = mergeSystemMessageWithMemory(merged, 'MORE');
    expect((again?.sections as Record<string, { content?: string }>).custom_instructions.content).toBe('BLOCK\n\nMORE');
  });

  it('is a no-op without a block', () => {
    expect(mergeSystemMessageWithMemory(undefined, '')).toBeUndefined();
    const sm = { mode: 'append', content: 'BASE' };
    expect(mergeSystemMessageWithMemory(sm, '   ')).toBe(sm);
  });

  it('derives a recall query from identity + task', () => {
    expect(deriveRecallQuery({ metadata: { name: 'fe-engineer', tags: ['ui'] } }, 'build a page')).toBe('fe-engineer ui build a page');
  });
});
