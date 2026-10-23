import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DbAdapter } from './adapter.js';
import type { RunStatus } from '../core/types.js';
import { encryptSecret, decryptSecret } from '../core/crypto.js';
import { runMigrations } from './migrations.js';

export class SqliteAdapter implements DbAdapter {
  private db: Database.Database;
  constructor(path = './data/minion.db') {
    // Install-time bootstrap: the db always lives inside a folder (data/ by default);
    // create it for whatever path the caller passes.
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Durability + concurrency: WAL lets readers (UI polling, /api/logs) proceed while a run writes.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, version TEXT, definition_json TEXT, definition_hash TEXT, created_at TEXT, status TEXT DEFAULT 'published');
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, trace_id TEXT UNIQUE, status TEXT, model TEXT, provider_type TEXT, task_prompt TEXT, definition_hash TEXT, created_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, type TEXT, payload_json TEXT, persisted INTEGER, at TEXT);
      CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY, tokens_in INTEGER, tokens_out INTEGER, credits REAL, duration_ms INTEGER, endpoint TEXT, request_id TEXT);      CREATE TABLE IF NOT EXISTS transcripts(run_id TEXT PRIMARY KEY, path TEXT, sha256 TEXT);
      CREATE TABLE IF NOT EXISTS mcp_servers(name TEXT PRIMARY KEY, config_json TEXT, description TEXT, tools_json TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT, trace_id TEXT, status TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS credentials(name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS chat_threads(id TEXT PRIMARY KEY, title TEXT, agent_id TEXT, session_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS chat_messages(mtid INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, role TEXT, author TEXT, content TEXT, run_id TEXT, created_at TEXT);`);
    // Migration: workflows were removed — drop their tables/column from older DBs.
    this.db.exec(`
      DROP TABLE IF EXISTS workflow_steps;
      DROP TABLE IF EXISTS workflow_events;
      DROP TABLE IF EXISTS workflow_runs;
      DROP TABLE IF EXISTS workflows;
    `);
    const chatCols = this.db.prepare(`PRAGMA table_info(chat_threads)`).all() as { name: string }[];
    if (chatCols.some((c) => c.name === 'workflow_id')) {
      this.db.exec(`ALTER TABLE chat_threads DROP COLUMN workflow_id`);
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'published'");
    } catch { /* column already exists */ }
    runMigrations(this.db);
  }
  /** Raw handle for sibling stores (PlatformStore) that share this connection. */
  get raw(): Database.Database { return this.db; }
  saveAgent(name: string, version: string, definitionJson: string, hash: string, status = 'published'): string {
    const id = `${name}@${version}`;
    this.db.prepare(`INSERT INTO agents(id,name,version,definition_json,definition_hash,created_at,status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json, definition_hash=excluded.definition_hash, status=excluded.status`).run(id, name, version, definitionJson, hash, new Date().toISOString(), status);
    return id;
  }
  getAgent(id: string) {
    return this.db.prepare(`SELECT id,name,version,definition_json,definition_hash,created_at,COALESCE(status, 'published') as status FROM agents WHERE id=?`).get(id) as { id: string; name: string; version: string; definition_json: string; status?: string } | undefined;
  }
  listAgents(status = 'published') {
    if (status === 'all') {
      return this.db.prepare(`SELECT id,name,version,created_at,COALESCE(status, 'published') as status FROM agents ORDER BY created_at DESC`).all() as { id: string; name: string; version: string; created_at: string; status?: string }[];
    }
    return this.db.prepare(`SELECT id,name,version,created_at,COALESCE(status, 'published') as status FROM agents WHERE status = ? OR (status IS NULL AND ? = 'published') ORDER BY created_at DESC`).all(status, status) as { id: string; name: string; version: string; created_at: string; status?: string }[];
  }
  updateAgentDefinition(id: string, definitionJson: string, hash: string): boolean {
    const r = this.db.prepare(`UPDATE agents SET definition_json=?, definition_hash=? WHERE id=?`).run(definitionJson, hash, id);
    return r.changes > 0;
  }
  deleteAgent(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM agents WHERE id=?`).run(id);
    return r.changes > 0;
  }
  agentActivity(agentId: string) {
    const runs = this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS active FROM runs WHERE agent_id=?`).get(agentId) as { total: number; active: number | null };
    const sessions = this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IS NULL OR status IN ('created','running','open','active') THEN 1 ELSE 0 END) AS active FROM sessions WHERE agent_id=?`).get(agentId) as { total: number; active: number | null };
    return {
      activeRuns: runs.active ?? 0,
      activeSessions: sessions.active ?? 0,
      totalRuns: runs.total ?? 0,
      totalSessions: sessions.total ?? 0,
    };
  }
  createRun(agentId: string, sessionId: string, traceId: string, model: string, providerType: string, taskPrompt: string, definitionHash: string, extra?: { source?: string; threadId?: string; projectId?: string }): string {
    const id = `run_${randomUUID().slice(0, 8)}`;
    this.db.prepare(`INSERT INTO runs(id,agent_id,session_id,trace_id,status,model,provider_type,task_prompt,definition_hash,created_at,source,thread_id,project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, agentId, sessionId, traceId, 'running', model, providerType, taskPrompt.slice(0, 4000), definitionHash, new Date().toISOString(), extra?.source ?? 'run', extra?.threadId ?? null, extra?.projectId ?? null);
    return id;
  }
  appendEvent(runId: string, seq: number, type: string, payloadJson: string, persisted: boolean) {
    this.db.prepare(`INSERT INTO events(run_id,seq,type,payload_json,persisted,at) VALUES(?,?,?,?,?,?)`).run(runId, seq, type, payloadJson.slice(0, 20000), persisted ? 1 : 0, new Date().toISOString());
  }
  finishRun(runId: string, status: RunStatus, error?: string) {
    this.db.prepare(`UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?`).run(status, new Date().toISOString(), error ?? null, runId);
  }
  recordUsage(runId: string, u: { tokensIn?: number; tokensOut?: number; credits?: number; durationMs?: number; endpoint?: string; requestId?: string }) {
    this.db.prepare(`INSERT INTO usage(run_id,tokens_in,tokens_out,credits,duration_ms,endpoint,request_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out, credits=excluded.credits`).run(runId, u.tokensIn ?? null, u.tokensOut ?? null, u.credits ?? null, u.durationMs ?? null, u.endpoint ?? null, u.requestId ?? null);
  }
  getRun(runId: string) {
    return this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(runId) as Record<string, unknown> | undefined;
  }
  listRuns(agentId?: string) {
    return (agentId
      ? this.db.prepare(`SELECT * FROM runs WHERE agent_id=? ORDER BY created_at DESC LIMIT 100`).all(agentId)
      : this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 100`).all()) as Record<string, unknown>[];
  }
  getEvents(runId: string, afterSeq = 0) {
    return this.db.prepare(`SELECT seq,type,payload_json,persisted,at FROM events WHERE run_id=? AND seq>? ORDER BY seq`).all(runId, afterSeq) as { seq: number; type: string; payload_json: string; persisted: number; at: string }[];
  }
  /** Hourly buckets of run activity for the dashboard charts. SQLite string ISO timestamps sort lexicographically. */
  runsTimeline(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT substr(created_at, 1, 13) AS hour,
             COUNT(*) AS requests,
             SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
      FROM runs WHERE created_at >= ?
      GROUP BY hour ORDER BY hour`).all(cutoff) as { hour: string; requests: number; succeeded: number; failed: number; running: number }[];
    // Fill gaps so the chart x-axis is continuous.
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const out: { hour: string; requests: number; succeeded: number; failed: number; running: number }[] = [];
    const start = new Date(Math.floor((Date.now() - hours * 3600 * 1000) / 3600000) * 3600000);
    for (let i = 0; i <= hours; i++) {
      const h = new Date(start.getTime() + i * 3600000).toISOString().slice(0, 13);
      out.push(byHour.get(h) ?? { hour: h, requests: 0, succeeded: 0, failed: 0, running: 0 });
    }
    return out;
  }
  runsByModel() {
    return this.db.prepare(`
      SELECT COALESCE(NULLIF(model,''),'(unknown)') AS model,
             COUNT(*) AS requests,
             SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
             AVG(CASE WHEN finished_at IS NOT NULL THEN (julianday(finished_at)-julianday(created_at))*86400000 END) AS avgDurationMs,
             (SELECT SUM(u.tokens_in) FROM usage u JOIN runs r2 ON r2.id=u.run_id WHERE r2.model=runs.model) AS tokensIn,
             (SELECT SUM(u.tokens_out) FROM usage u JOIN runs r3 ON r3.id=u.run_id WHERE r3.model=runs.model) AS tokensOut
      FROM runs GROUP BY model ORDER BY requests DESC`).all() as { model: string; requests: number; succeeded: number; failed: number; avgDurationMs: number | null; tokensIn: number | null; tokensOut: number | null }[];
  }
  requestTotals() {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN status IN ('done','failed','aborted') THEN 1 ELSE 0 END) AS responses,
             SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM runs`).get() as { requests: number; responses: number | null; succeeded: number | null; failed: number | null };
    return { requests: r.requests ?? 0, responses: r.responses ?? 0, succeeded: r.succeeded ?? 0, failed: r.failed ?? 0 };
  }
  saveTranscript(runId: string, path: string, sha256: string) {
    this.db.prepare(`INSERT INTO transcripts(run_id,path,sha256) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET path=excluded.path, sha256=excluded.sha256`).run(runId, path, sha256);
  }
  saveMcpServer(input: { name: string; config_json: string; description?: string; tools_json?: string }): string {
    this.db.prepare(`INSERT INTO mcp_servers(name,config_json,description,tools_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET config_json=excluded.config_json, description=excluded.description, tools_json=COALESCE(excluded.tools_json, mcp_servers.tools_json)`).run(input.name, input.config_json, input.description ?? null, input.tools_json ?? null, new Date().toISOString());
    return input.name;
  }
  getMcpServer(name: string) {
    return this.db.prepare(`SELECT name,config_json,description,tools_json,created_at FROM mcp_servers WHERE name=?`).get(name) as { name: string; config_json: string; description: string | null; tools_json: string | null; created_at: string } | undefined;
  }
  listMcpServers() {
    return this.db.prepare(`SELECT name,description,tools_json,created_at FROM mcp_servers ORDER BY created_at DESC`).all() as { name: string; description: string | null; tools_json: string | null; created_at: string }[];
  }
  updateMcpServerTools(name: string, toolsJson: string) {
    this.db.prepare(`UPDATE mcp_servers SET tools_json=? WHERE name=?`).run(toolsJson, name);
  }
  deleteMcpServer(name: string): boolean {
    const r = this.db.prepare(`DELETE FROM mcp_servers WHERE name=?`).run(name);
    return r.changes > 0;
  }
  upsertSession(input: { sessionId: string; runId?: string; agentId?: string; traceId?: string; status?: string; summary?: string }): void {
    this.db.prepare(`INSERT INTO sessions(session_id,run_id,agent_id,trace_id,status,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET run_id=COALESCE(excluded.run_id, sessions.run_id), status=COALESCE(excluded.status, sessions.status), summary=COALESCE(excluded.summary, sessions.summary), updated_at=excluded.updated_at`)
      .run(input.sessionId, input.runId ?? null, input.agentId ?? null, input.traceId ?? null, input.status ?? 'created', input.summary ?? null, new Date().toISOString(), new Date().toISOString());
  }
  getSession(sessionId: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id=?`).get(sessionId) as Record<string, unknown> | undefined;
  }
  listSessions() {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200`).all() as Record<string, unknown>[];
  }
  /** Dashboard rollup: token/credit/duration totals across all usage rows. */
  usageSummary(): { tokensIn: number | null; tokensOut: number | null; credits: number | null; avgDurationMs: number | null; rows: number } {
    const r = this.db.prepare(`SELECT
      SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(credits) AS credits,
      AVG(duration_ms) AS avg_duration_ms, COUNT(*) AS rows
      FROM usage WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL OR credits IS NOT NULL OR duration_ms IS NOT NULL`).get() as { tokens_in: number | null; tokens_out: number | null; credits: number | null; avg_duration_ms: number | null; rows: number };
    return { tokensIn: r.tokens_in, tokensOut: r.tokens_out, credits: r.credits, avgDurationMs: r.avg_duration_ms, rows: r.rows ?? 0 };
  }
  saveCredential(name: string, secret: string): void {
    const enc = encryptSecret(secret);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO credentials(name,ciphertext,iv,tag,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, updated_at=excluded.updated_at`)
      .run(name, enc.ciphertext, enc.iv, enc.tag, now, now);
  }
  getCredentialSecret(name: string): string | undefined {
    const row = this.db.prepare(`SELECT ciphertext,iv,tag FROM credentials WHERE name=?`).get(name) as { ciphertext: string; iv: string; tag: string } | undefined;
    if (!row) return undefined;
    return decryptSecret(row);
  }
  listCredentials() {
    // Names + timestamps only — secrets never leave this module in list form.
    return this.db.prepare(`SELECT name,created_at,updated_at FROM credentials ORDER BY name`).all() as { name: string; created_at: string; updated_at: string }[];
  }
  deleteCredential(name: string): boolean {
    const r = this.db.prepare(`DELETE FROM credentials WHERE name=?`).run(name);
    return r.changes > 0;
  }
  // ---------- chat ----------
  createChatThread(input: { title: string; agentId: string | null; sessionId: string | null; projectId?: string | null; modelOverride?: string | null }): string {
    const id = `chat_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO chat_threads(id,title,agent_id,session_id,created_at,updated_at,project_id,model_override) VALUES(?,?,?,?,?,?,?,?)`).run(id, input.title.slice(0, 200), input.agentId, input.sessionId, now, now, input.projectId ?? null, input.modelOverride ?? null);
    return id;
  }
  getChatThread(id: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM chat_threads WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  }
  listChatThreads(filter?: { agentId?: string; projectId?: string; includeArchived?: boolean; q?: string }): Record<string, unknown>[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter?.agentId) { where.push('t.agent_id=?'); vals.push(filter.agentId); }
    if (filter?.projectId) { where.push('t.project_id=?'); vals.push(filter.projectId); }
    if (!filter?.includeArchived) where.push('t.archived=0');
    if (filter?.q) {
      where.push('(t.title LIKE ? OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.content LIKE ?))');
      const like = `%${filter.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      vals.push(like, like);
    }
    const sql = `SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id=t.id) AS message_count FROM chat_threads t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 500`;
    return this.db.prepare(sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")).all(...vals) as Record<string, unknown>[];
  }
  updateChatThread(id: string, fields: { title?: string; sessionId?: string | null; updated_at?: string; agentId?: string | null; projectId?: string | null; pinned?: boolean; archived?: boolean; modelOverride?: string | null; approvalMode?: string | null }): boolean {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.title !== undefined) { sets.push('title=?'); vals.push(fields.title.slice(0, 200)); }
    if (fields.sessionId !== undefined) { sets.push('session_id=?'); vals.push(fields.sessionId); }
    if (fields.updated_at !== undefined) { sets.push('updated_at=?'); vals.push(fields.updated_at); }
    if (fields.agentId !== undefined) { sets.push('agent_id=?'); vals.push(fields.agentId); }
    if (fields.projectId !== undefined) { sets.push('project_id=?'); vals.push(fields.projectId); }
    if (fields.pinned !== undefined) { sets.push('pinned=?'); vals.push(fields.pinned ? 1 : 0); }
    if (fields.archived !== undefined) { sets.push('archived=?'); vals.push(fields.archived ? 1 : 0); }
    if (fields.modelOverride !== undefined) { sets.push('model_override=?'); vals.push(fields.modelOverride); }
    if (fields.approvalMode !== undefined) { sets.push('approval_mode=?'); vals.push(fields.approvalMode); }
    if (!sets.length) return false;
    vals.push(id);
    return this.db.prepare(`UPDATE chat_threads SET ${sets.join(', ')} WHERE id=?`).run(...vals as unknown[]).changes > 0;
  }
  deleteChatThread(id: string): boolean {
    this.db.prepare(`DELETE FROM chat_messages WHERE thread_id=?`).run(id);
    this.db.prepare(`DELETE FROM approvals WHERE thread_id=?`).run(id);
    return this.db.prepare(`DELETE FROM chat_threads WHERE id=?`).run(id).changes > 0;
  }
  addChatMessage(threadId: string, m: { role: string; author: string; content: string; runId?: string | null; meta?: Record<string, unknown> | null }): number {
    const now = new Date().toISOString();
    const r = this.db.prepare(`INSERT INTO chat_messages(thread_id,role,author,content,run_id,created_at,meta_json) VALUES(?,?,?,?,?,?,?)`).run(threadId, m.role, m.author, m.content.slice(0, 100000), m.runId ?? null, now, m.meta ? JSON.stringify(m.meta) : null);
    this.db.prepare(`UPDATE chat_threads SET updated_at=? WHERE id=?`).run(now, threadId);
    return Number(r.lastInsertRowid);
  }
  getChatMessages(threadId: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT mtid,role,author,content,run_id,created_at,meta_json FROM chat_messages WHERE thread_id=? ORDER BY mtid`).all(threadId) as Record<string, unknown>[];
  }
  setRunAuditPath(runId: string, path: string): void {
    this.db.prepare(`UPDATE runs SET audit_path=? WHERE id=?`).run(path, runId);
  }  close() { this.db.close(); }
}
