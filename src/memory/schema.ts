import type Database from 'better-sqlite3';

/**
 * Memory DDL. Additive only — `CREATE ... IF NOT EXISTS` plus column-add
 * migrations. Nothing here ever drops a table or column (the project-wide
 * bootstrap policy): `forget` deletes rows through the store, never DDL.
 *
 * The schema mirrors Cognee's building blocks (see ./types.ts):
 *   mem_nodes    — DataPoints (identity: dataset + node_type + name)
 *   mem_edges    — typed edges with weight / weights / properties / edge_text
 *   mem_episodes — 'add' layer: raw run evidence that later becomes lessons
 *   mem_feedback — ±1 outcome signals per node (ranking only)
 *   mem_vectors  — dormant until an embedding provider is configured
 *   mem_datasets, mem_meta
 *   mem_nodes_fts / mem_edges_fts — lexical channel (FTS5, BM25)
 */
export const MEMORY_SCHEMA_VERSION = 1;

/** Prefix for the platform-wide defaults row in mem_meta. */
export const MEMORY_DEFAULTS_KEY = 'platform.memory.defaults';

export const MEMORY_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS mem_datasets(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_nodes(
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        node_type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT,
        terms TEXT,
        node_set TEXT,
        properties_json TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        weight REAL NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        source_run_id TEXT,
        source_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE(dataset, node_type, name));
      CREATE INDEX IF NOT EXISTS idx_mem_nodes_dataset ON mem_nodes(dataset, node_type);
      CREATE INDEX IF NOT EXISTS idx_mem_nodes_used ON mem_nodes(dataset, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_nodes_weight ON mem_nodes(dataset, weight DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_nodes_path ON mem_nodes(dataset, source_path);
      CREATE INDEX IF NOT EXISTS idx_mem_nodes_name ON mem_nodes(name);
      CREATE TABLE IF NOT EXISTS mem_edges(
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        edge_text TEXT,
        weight REAL NOT NULL DEFAULT 1.0,
        weights_json TEXT,
        properties_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(dataset, source_id, relation, target_id));
      CREATE INDEX IF NOT EXISTS idx_mem_edges_src ON mem_edges(dataset, source_id, relation);
      CREATE INDEX IF NOT EXISTS idx_mem_edges_dst ON mem_edges(dataset, target_id, relation);
      CREATE TABLE IF NOT EXISTS mem_episodes(
        id TEXT PRIMARY KEY,
        run_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        thread_id TEXT,
        task TEXT,
        outcome TEXT NOT NULL,
        error TEXT,
        summary TEXT,
        memory_injected_json TEXT,
        tool_failures_json TEXT,
        files_touched_json TEXT,
        commands_json TEXT,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mem_episodes_run ON mem_episodes(run_id);
      CREATE INDEX IF NOT EXISTS idx_mem_episodes_agent ON mem_episodes(agent_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mem_feedback(
        id TEXT PRIMARY KEY,
        run_id TEXT,
        node_id TEXT,
        edge_id TEXT,
        signal REAL NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mem_feedback_node ON mem_feedback(node_id);
      CREATE INDEX IF NOT EXISTS idx_mem_feedback_run ON mem_feedback(run_id);
      CREATE TABLE IF NOT EXISTS mem_vectors(
        node_id TEXT NOT NULL,
        dataset TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(node_id, model));
      CREATE INDEX IF NOT EXISTS idx_mem_vectors_dataset ON mem_vectors(dataset, model);
      CREATE TABLE IF NOT EXISTS mem_meta(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_nodes_fts USING fts5(
        id UNINDEXED, dataset UNINDEXED, node_type UNINDEXED, terms, body,
        tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_edges_fts USING fts5(
        id UNINDEXED, dataset UNINDEXED, source_id UNINDEXED, target_id UNINDEXED, terms, body,
        tokenize = 'unicode61 remove_diacritics 2');
`;

/**
 * Idempotent bootstrap + forward migration. Called by SqliteMemoryStore's
 * constructor; safe to run repeatedly and on any agent DB.
 */
export function migrateMemory(db: Database.Database): void {
  db.exec(MEMORY_SCHEMA_SQL);
  ensureMemoryColumn(db, 'mem_vectors', 'dim', 'INTEGER NOT NULL DEFAULT 0');
  ensureMemoryColumn(db, 'mem_nodes', 'node_set', 'TEXT');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO mem_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run('schema.version', String(MEMORY_SCHEMA_VERSION), now);
}

/** Additive-only column migration for memory tables (same policy as DbAdapter.ensureColumn). */
function ensureMemoryColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
