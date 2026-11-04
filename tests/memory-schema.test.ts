import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MEMORY_SCHEMA_SQL } from '../src/memory/schema.js';
import { SqliteMemoryStore } from '../src/memory/sqlite-store.js';

const dir = mkdtempSync(join(tmpdir(), 'memory-schema-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });

describe('memory DDL', () => {
  it('is additive only — no DROP and no workflow leftovers', () => {
    expect(MEMORY_SCHEMA_SQL).not.toMatch(/DROP/i);
    expect(MEMORY_SCHEMA_SQL).not.toMatch(/workflow/i);
  });

  it('creates every memory object, including FTS5 tables', () => {
    const path = join(dir, 'tables.db');
    const store = new SqliteMemoryStore(path);
    store.close();
    const raw = new Database(path);
    try {
      const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name);
      for (const expected of ['mem_nodes', 'mem_edges', 'mem_episodes', 'mem_feedback', 'mem_vectors', 'mem_meta', 'mem_datasets', 'mem_nodes_fts', 'mem_edges_fts']) {
        expect(names).toContain(expected);
      }
      // FTS5 is really usable (not a plain table fallback).
      raw.exec("INSERT INTO mem_nodes_fts(id,dataset,node_type,terms,body) VALUES('x','platform','Fact','alpha beta','alpha')");
      expect((raw.prepare("SELECT count(*) AS c FROM mem_nodes_fts WHERE mem_nodes_fts MATCH 'alpha'").get() as { c: number }).c).toBe(1);
    } finally {
      raw.close();
    }
  });

  it('is idempotent across reopens', () => {
    const path = join(dir, 'reopen.db');
    for (let i = 0; i < 3; i++) {
      const store = new SqliteMemoryStore(path);
      try {
        const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'k', content: `v${i}` });
        expect(store.getNode(node.id)?.content).toBe(`v${i}`);
      } finally { store.close(); }
    }
  });

  it('adds node_set to an older mem_nodes table without losing rows', () => {
    const path = join(dir, 'legacy.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE mem_nodes(
      id TEXT PRIMARY KEY, dataset TEXT NOT NULL, node_type TEXT NOT NULL, name TEXT NOT NULL,
      content TEXT, terms TEXT, properties_json TEXT, importance REAL, weight REAL, hits INTEGER,
      wins INTEGER, losses INTEGER, source_run_id TEXT, source_path TEXT,
      created_at TEXT, updated_at TEXT, last_used_at TEXT, UNIQUE(dataset,node_type,name));`);
    raw.prepare(`INSERT INTO mem_nodes(id,dataset,node_type,name,content,terms,importance,weight,hits,wins,losses,created_at,updated_at)
      VALUES('old','platform','Fact','legacy','kept','legacy',0.5,0,0,0,0,'2026-01-01','2026-01-01')`).run();
    raw.close();

    const store = new SqliteMemoryStore(path);
    try {
      expect(store.getNode('old')?.content).toBe('kept');
      const node = store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'new', content: 'x', node_set: 'conventions' });
      expect(node.node_set).toBe('conventions');
    } finally { store.close(); }
  });

  it('boots on top of an existing agent database without touching app tables', () => {
    const path = join(dir, 'app.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT, version TEXT, definition_json TEXT, definition_hash TEXT, created_at TEXT, status TEXT DEFAULT 'published');
      INSERT INTO agents(id,name,version,definition_json,definition_hash,created_at) VALUES('a@1.0.0','a','1.0.0','{}','h','2026-01-01');`);
    raw.close();
    const store = new SqliteMemoryStore(path);
    try {
      store.upsertNode({ dataset: 'platform', node_type: 'Fact', name: 'k', content: 'v' });
    } finally { store.close(); }
    const check = new Database(path);
    try {
      expect((check.prepare('SELECT count(*) AS c FROM agents').get() as { c: number }).c).toBe(1);
      expect((check.prepare('SELECT count(*) AS c FROM mem_nodes').get() as { c: number }).c).toBe(1);
    } finally { check.close(); }
  });
});
