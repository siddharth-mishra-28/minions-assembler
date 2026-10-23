import type Database from 'better-sqlite3';

type Db = Database.Database;

const hasColumn = (db: Db, table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

const addColumn = (db: Db, table: string, col: string, decl: string): void => {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
};

/**
 * Ordered, append-only migrations keyed by PRAGMA user_version. Each step is idempotent so
 * databases created before versioning existed (user_version 0 with tables already present)
 * upgrade cleanly. Never edit a shipped step — add a new one.
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // 1 — platform tables: settings, providers, projects, approvals, daily metric rollups
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS providers(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL, default_model TEXT, credential_name TEXT,
        wire_api TEXT, azure_api_version TEXT, is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        settings_json TEXT, created_at TEXT, last_opened_at TEXT);
      CREATE TABLE IF NOT EXISTS approvals(
        id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, tool TEXT, args_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending', scope TEXT, decided_by TEXT, reason TEXT,
        requested_at TEXT, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS metrics_daily(
        day TEXT PRIMARY KEY, runs INTEGER DEFAULT 0, succeeded INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, credits REAL DEFAULT 0,
        chat_messages INTEGER DEFAULT 0);
    `);
  },
  // 2 — link chats/runs to projects, add pin/archive/model override and audit path
  (db) => {
    addColumn(db, 'chat_threads', 'project_id', 'TEXT');
    addColumn(db, 'chat_threads', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'chat_threads', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'chat_threads', 'model_override', 'TEXT');
    addColumn(db, 'chat_threads', 'approval_mode', 'TEXT');
    addColumn(db, 'chat_messages', 'meta_json', 'TEXT');
    addColumn(db, 'runs', 'source', "TEXT DEFAULT 'run'");
    addColumn(db, 'runs', 'thread_id', 'TEXT');
    addColumn(db, 'runs', 'project_id', 'TEXT');
    addColumn(db, 'runs', 'audit_path', 'TEXT');
  },
  // 3 — indexes for retention sweeps and history queries
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_msgs_thread ON chat_messages(thread_id, mtid);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON chat_threads(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, requested_at);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function runMigrations(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
