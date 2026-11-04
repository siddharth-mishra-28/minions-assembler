import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteAdapter, SCHEMA_SQL } from '../src/store/sqlite.js';
import { MEMORY_SCHEMA_SQL } from '../src/memory/schema.js';

const dir = mkdtempSync(join(tmpdir(), 'schema-evolution-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('SQLite bootstrap schema', () => {
  it('is additive only — no DROP statements and no workflow leftovers run at startup', () => {
    expect(SCHEMA_SQL).not.toMatch(/DROP/i);
    expect(SCHEMA_SQL).not.toMatch(/workflow/i);
    // The memory bootstrap follows the same policy (forget() deletes rows, never DDL).
    expect(MEMORY_SCHEMA_SQL).not.toMatch(/DROP/i);
  });

  it('records a definition snapshot on runs and keeps it out of run rows', () => {
    const db = new SqliteAdapter(join(dir, 'snap.db'));
    try {
      const id = db.createRun('a@1.0.0', 'sess_s1', 'tr_s1', 'm', 'openai', 'task', 'hash1', { definitionJson: '{"schemaVersion":"1.0"}' });
      expect(db.getRunDefinition(id)).toBe('{"schemaVersion":"1.0"}');
      const row = db.getRun(id) as Record<string, unknown>;
      expect(row.definition_hash).toBe('hash1');
      // Projection: the (large, sensitive) snapshot never leaks through run rows.
      expect(row).not.toHaveProperty('definition_json');
      expect(db.listRuns()).not.toHaveProperty('definition_json');
      // Snapshot is optional (legacy callers) — absent means undefined, not crash.
      const id2 = db.createRun('a@1.0.0', 'sess_s2', 'tr_s2', 'm', 'openai', 'task', 'hash2');
      expect(db.getRunDefinition(id2)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('ensureColumn (additive migration)', () => {
  it('upgrades a legacy runs table missing definition_json', () => {
    const path = join(dir, 'legacy-runs.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, trace_id TEXT UNIQUE, status TEXT, model TEXT, provider_type TEXT, task_prompt TEXT, definition_hash TEXT, created_at TEXT, finished_at TEXT, error TEXT);`);
    raw.close();
    const db = new SqliteAdapter(path);
    try {
      const id = db.createRun('a@1.0.0', 'sess_l1', 'tr_l1', 'm', 'openai', 'task', 'h', { definitionJson: '{"x":1}' });
      expect(db.getRunDefinition(id)).toBe('{"x":1}');
    } finally {
      db.close(); 
    }
  });

  it('upgrades a legacy agents table missing status and stays idempotent across reopens', () => {
    const path = join(dir, 'legacy-agents.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT, version TEXT, definition_json TEXT, definition_hash TEXT, created_at TEXT);`);
    raw.close();
    for (let i = 0; i < 2; i++) {
      const db = new SqliteAdapter(path);
      try {
        const id = db.saveAgent('legacy', '1.0.0', '{}', 'h');
        expect(db.getAgent(id)?.status).toBe('published');
        expect(db.listAgents('all')).toHaveLength(1);
      } finally {
        db.close();
      }
    }
  });
});
