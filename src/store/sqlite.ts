import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DbAdapter } from './adapter.js';
import type { RunStatus } from '../types.js';

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
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, version TEXT, definition_json TEXT, definition_hash TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, trace_id TEXT UNIQUE, status TEXT, model TEXT, provider_type TEXT, task_prompt TEXT, definition_hash TEXT, created_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, type TEXT, payload_json TEXT, persisted INTEGER, at TEXT);
      CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY, tokens_in INTEGER, tokens_out INTEGER, credits REAL, duration_ms INTEGER, endpoint TEXT, request_id TEXT);      CREATE TABLE IF NOT EXISTS transcripts(run_id TEXT PRIMARY KEY, path TEXT, sha256 TEXT);
      CREATE TABLE IF NOT EXISTS mcp_servers(name TEXT PRIMARY KEY, config_json TEXT, description TEXT, tools_json TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT, trace_id TEXT, status TEXT, summary TEXT, created_at TEXT, updated_at TEXT);`);
  }
  saveAgent(name: string, version: string, definitionJson: string, hash: string): string {
    const id = `${name}@${version}`;
    this.db.prepare(`INSERT INTO agents(id,name,version,definition_json,definition_hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json, definition_hash=excluded.definition_hash`).run(id, name, version, definitionJson, hash, new Date().toISOString());
    return id;
  }
  getAgent(id: string) {
    return this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as { id: string; name: string; version: string; definition_json: string } | undefined;
  }
  listAgents() {
    return this.db.prepare(`SELECT id,name,version,created_at FROM agents ORDER BY created_at DESC`).all() as { id: string; name: string; version: string; created_at: string }[];
  }
  createRun(agentId: string, sessionId: string, traceId: string, model: string, providerType: string, taskPrompt: string, definitionHash: string): string {
    const id = `run_${randomUUID().slice(0, 8)}`;
    this.db.prepare(`INSERT INTO runs(id,agent_id,session_id,trace_id,status,model,provider_type,task_prompt,definition_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, agentId, sessionId, traceId, 'running', model, providerType, taskPrompt.slice(0, 4000), definitionHash, new Date().toISOString());
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
  close() { this.db.close(); }
}
