import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateMemory } from './schema.js';
import { clip, expandTerms } from './text.js';
import type {
  EpisodeQuery, EdgeQuery, LexicalHit, MemoryStats, MemoryStore, NodeQuery, UpsertEdgeInput, UpsertNodeInput,
} from './store.js';
import type {
  MemoryDataset, MemoryEdge, MemoryEpisode, MemoryFeedback, MemoryNode, MemoryNodeType,
} from './types.js';

const nowIso = (): string => new Date().toISOString();
const NODE_BODY_MAX = 8000;
const EDGE_BODY_MAX = 1000;

/**
 * SQLite implementation of the memory port.
 *
 * Opens its OWN connection to the same database file the app already uses
 * (WAL is already enabled there; busy_timeout absorbs the brief overlap between
 * a memory write and a run-row write). Keeping a separate connection avoids
 * byte-stitching memory into the 40-method DbAdapter and its Postgres stub —
 * the port is the seam a future Cognee backend plugs into.
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;

  constructor(path = './data/minion.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    migrateMemory(this.db);
  }

  // ---------------- nodes ----------------

  upsertNode(input: UpsertNodeInput): MemoryNode {
    const now = nowIso();
    const content = input.content ?? null;
    const terms = input.terms ?? expandTerms(input.name, content, input.source_path);
    const importance = clamp01(input.importance ?? 0.5);
    const existing = this.findNode(input.dataset, input.node_type, input.name);
    if (existing) {
      this.db.prepare(`UPDATE mem_nodes SET content=?, terms=?, node_set=?, properties_json=?, importance=?,
          source_run_id=COALESCE(?, source_run_id), source_path=COALESCE(?, source_path), updated_at=? WHERE id=?`)
        .run(content, terms, input.node_set ?? existing.node_set ?? null, input.properties_json ?? existing.properties_json ?? null,
          importance, input.source_run_id ?? null, input.source_path ?? null, now, existing.id);
      this.syncNodeFts(existing.id);
      return this.getNode(existing.id)!;
    }
    const id = `mem_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`INSERT INTO mem_nodes(id,dataset,node_type,name,content,terms,node_set,properties_json,
        importance,weight,hits,wins,losses,source_run_id,source_path,created_at,updated_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?,?,0,0,0,0,?,?,?,?,NULL)`)
      .run(id, input.dataset, input.node_type, input.name, content, terms, input.node_set ?? null,
        input.properties_json ?? null, importance, input.source_run_id ?? null, input.source_path ?? null, now, now);
    this.syncNodeFts(id);
    return this.getNode(id)!;
  }

  getNode(id: string): MemoryNode | undefined {
    return this.db.prepare('SELECT * FROM mem_nodes WHERE id=?').get(id) as MemoryNode | undefined;
  }

  findNode(dataset: string, nodeType: string, name: string): MemoryNode | undefined {
    return this.db.prepare('SELECT * FROM mem_nodes WHERE dataset=? AND node_type=? AND name=?')
      .get(dataset, nodeType, name) as MemoryNode | undefined;
  }

  listNodes(q: NodeQuery): MemoryNode[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.dataset) { where.push('dataset=?'); vals.push(q.dataset); }
    if (q.datasets?.length) { where.push(`dataset IN (${placeholders(q.datasets.length)})`); vals.push(...q.datasets); }
    if (q.node_type) {
      const types = Array.isArray(q.node_type) ? q.node_type : [q.node_type];
      if (types.length) { where.push(`node_type IN (${placeholders(types.length)})`); vals.push(...types); }
    }
    if (q.node_set) { where.push('node_set=?'); vals.push(q.node_set); }
    if (q.nameContains) { where.push('name LIKE ?'); vals.push(`%${q.nameContains}%`); }
    const order = q.orderBy === 'weight'
      ? 'ORDER BY weight DESC, updated_at DESC'
      : q.orderBy === 'name'
        ? 'ORDER BY name ASC'
        : 'ORDER BY COALESCE(last_used_at, updated_at) DESC';
    const limit = clampInt(q.limit ?? 100, 1, 2000);
    const sql = `SELECT * FROM mem_nodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ${limit}`;
    return this.db.prepare(sql).all(...vals as unknown[]) as MemoryNode[];
  }

  deleteNode(id: string): boolean {
    const edgeIds = (this.db.prepare('SELECT id FROM mem_edges WHERE source_id=? OR target_id=?').all(id, id) as { id: string }[]).map((e) => e.id);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mem_nodes WHERE id=?').run(id);
      this.db.prepare('DELETE FROM mem_nodes_fts WHERE id=?').run(id);
      this.db.prepare('DELETE FROM mem_edges WHERE source_id=? OR target_id=?').run(id, id);
      for (const eid of edgeIds) this.db.prepare('DELETE FROM mem_edges_fts WHERE id=?').run(eid);
      this.db.prepare('DELETE FROM mem_vectors WHERE node_id=?').run(id);
    });
    const before = this.db.prepare('SELECT COUNT(*) AS c FROM mem_nodes WHERE id=?').get(id) as { c: number };
    tx();
    return before.c > 0;
  }

  deleteDataset(dataset: string): number {
    const edgeIds = (this.db.prepare('SELECT id FROM mem_edges WHERE dataset=?').all(dataset) as { id: string }[]).map((e) => e.id);
    const nodeCount = (this.db.prepare('SELECT COUNT(*) AS c FROM mem_nodes WHERE dataset=?').get(dataset) as { c: number }).c;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mem_nodes WHERE dataset=?').run(dataset);
      this.db.prepare('DELETE FROM mem_nodes_fts WHERE dataset=?').run(dataset);
      this.db.prepare('DELETE FROM mem_edges WHERE dataset=?').run(dataset);
      this.db.prepare('DELETE FROM mem_edges_fts WHERE dataset=?').run(dataset);
      this.db.prepare('DELETE FROM mem_vectors WHERE dataset=?').run(dataset);
      if (dataset !== 'platform') this.db.prepare('DELETE FROM mem_datasets WHERE id=?').run(dataset);
    });
    tx();
    return nodeCount + edgeIds.length;
  }

  touchNodes(ids: string[]): void {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const now = nowIso();
    const stmt = this.db.prepare('UPDATE mem_nodes SET hits=hits+1, last_used_at=? WHERE id=?');
    const tx = this.db.transaction(() => { for (const id of unique) stmt.run(now, id); });
    tx();
  }

  // ---------------- edges ----------------

  upsertEdge(input: UpsertEdgeInput): MemoryEdge {
    const now = nowIso();
    const weight = Number.isFinite(input.weight) ? Number(input.weight) : 1.0;
    const existing = this.db.prepare('SELECT * FROM mem_edges WHERE dataset=? AND source_id=? AND relation=? AND target_id=?')
      .get(input.dataset, input.source_id, input.relation, input.target_id) as MemoryEdge | undefined;
    if (existing) {
      this.db.prepare(`UPDATE mem_edges SET edge_text=COALESCE(?, edge_text), weight=?, weights_json=COALESCE(?, weights_json),
          properties_json=COALESCE(?, properties_json), updated_at=? WHERE id=?`)
        .run(input.edge_text ?? null, weight, input.weights_json ?? null, input.properties_json ?? null, now, existing.id);
      this.syncEdgeFts(existing.id);
      return this.db.prepare('SELECT * FROM mem_edges WHERE id=?').get(existing.id) as MemoryEdge;
    }
    const id = `med_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`INSERT INTO mem_edges(id,dataset,source_id,target_id,relation,edge_text,weight,weights_json,properties_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.dataset, input.source_id, input.target_id, input.relation, input.edge_text ?? null, weight,
        input.weights_json ?? null, input.properties_json ?? null, now, now);
    this.syncEdgeFts(id);
    return this.db.prepare('SELECT * FROM mem_edges WHERE id=?').get(id) as MemoryEdge;
  }

  listEdges(q: EdgeQuery): MemoryEdge[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.dataset) { where.push('dataset=?'); vals.push(q.dataset); }
    if (q.datasets?.length) { where.push(`dataset IN (${placeholders(q.datasets.length)})`); vals.push(...q.datasets); }
    if (q.relations?.length) { where.push(`relation IN (${placeholders(q.relations.length)})`); vals.push(...q.relations); }
    const limit = clampInt(q.limit ?? 200, 1, 5000);
    return this.db.prepare(`SELECT * FROM mem_edges ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY weight DESC LIMIT ${limit}`)
      .all(...vals as unknown[]) as MemoryEdge[];
  }

  edgesAround(ids: string[], dataset: string, relations?: string[]): MemoryEdge[] {
    if (!ids.length) return [];
    const unique = [...new Set(ids)].slice(0, 200);
    const ph = placeholders(unique.length);
    const rel = relations?.length ? ` AND relation IN (${placeholders(relations.length)})` : '';
    const vals: unknown[] = [dataset, ...unique, ...unique, ...(relations ?? [])];
    return this.db.prepare(`SELECT * FROM mem_edges WHERE dataset=? AND (source_id IN (${ph}) OR target_id IN (${ph}))${rel} ORDER BY weight DESC`)
      .all(...vals) as MemoryEdge[];
  }

  deleteEdge(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mem_edges WHERE id=?').run(id);
      this.db.prepare('DELETE FROM mem_edges_fts WHERE id=?').run(id);
    });
    const before = this.db.prepare('SELECT COUNT(*) AS c FROM mem_edges WHERE id=?').get(id) as { c: number };
    tx();
    return before.c > 0;
  }

  // ---------------- lexical search ----------------

  searchNodes(match: string, opts: { datasets: string[]; kinds?: MemoryNodeType[]; limit?: number }): LexicalHit[] {
    if (!opts.datasets.length) return [];
    const limit = clampInt(opts.limit ?? 30, 1, 500);
    const kindSql = opts.kinds?.length ? ` AND n.node_type IN (${placeholders(opts.kinds.length)})` : '';
    const vals: unknown[] = [match, ...opts.datasets, ...(opts.kinds ?? [])];
    // Column order must match the DDL: id, dataset, node_type, terms, body.
    const sql = `SELECT n.*, bm25(mem_nodes_fts, 0, 0, 0, 3.0, 1.0) AS rank
      FROM mem_nodes_fts JOIN mem_nodes n ON n.id = mem_nodes_fts.id
      WHERE mem_nodes_fts MATCH ? AND mem_nodes_fts.dataset IN (${placeholders(opts.datasets.length)})${kindSql}
      ORDER BY rank LIMIT ${limit}`;
    try {
      const rows = this.db.prepare(sql).all(...vals) as (MemoryNode & { rank: number })[];
      return rows.map((r) => ({ node: stripRank(r), rank: Number(r.rank) }));
    } catch { return []; } // malformed MATCH never breaks a run
  }

  searchEdges(match: string, opts: { datasets: string[]; limit?: number }): { edge: MemoryEdge; rank: number }[] {
    if (!opts.datasets.length) return [];
    const limit = clampInt(opts.limit ?? 30, 1, 500);
    const sql = `SELECT e.*, bm25(mem_edges_fts, 0, 0, 0, 0, 2.0, 1.0) AS rank
      FROM mem_edges_fts JOIN mem_edges e ON e.id = mem_edges_fts.id
      WHERE mem_edges_fts MATCH ? AND mem_edges_fts.dataset IN (${placeholders(opts.datasets.length)})
      ORDER BY rank LIMIT ${limit}`;
    try {
      const rows = this.db.prepare(sql).all(match, ...opts.datasets) as (MemoryEdge & { rank: number })[];
      return rows.map((r) => ({ edge: stripRankMemEdge(r), rank: Number(r.rank) }));
    } catch { return []; }
  }

  // ---------------- episodes ----------------

  insertEpisode(input: Omit<MemoryEpisode, 'id' | 'created_at'> & { id?: string }): MemoryEpisode {
    const id = input.id ?? `ep_${randomUUID().slice(0, 12)}`;
    const created = nowIso();
    this.db.prepare(`INSERT INTO mem_episodes(id,run_id,agent_id,session_id,thread_id,task,outcome,error,summary,
        memory_injected_json,tool_failures_json,files_touched_json,commands_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.run_id ?? null, input.agent_id ?? null, input.session_id ?? null, input.thread_id ?? null,
        input.task?.slice(0, 4000) ?? null, input.outcome, input.error?.slice(0, 4000) ?? null,
        input.summary?.slice(0, 2000) ?? null, input.memory_injected_json ?? null, input.tool_failures_json ?? null,
        input.files_touched_json ?? null, input.commands_json ?? null, created);
    return this.db.prepare('SELECT * FROM mem_episodes WHERE id=?').get(id) as MemoryEpisode;
  }

  listEpisodes(q: EpisodeQuery = {}): MemoryEpisode[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.runId) { where.push('run_id=?'); vals.push(q.runId); }
    if (q.agentId) { where.push('agent_id=?'); vals.push(q.agentId); }
    if (q.threadId) { where.push('thread_id=?'); vals.push(q.threadId); }
    const limit = clampInt(q.limit ?? 50, 1, 1000);
    return this.db.prepare(`SELECT * FROM mem_episodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...vals as unknown[]) as MemoryEpisode[];
  }

  // ---------------- feedback ----------------

  addFeedback(input: { runId?: string | null; nodeId?: string | null; edgeId?: string | null; signal: number; source?: string }): MemoryFeedback {
    const id = `fb_${randomUUID().slice(0, 12)}`;
    const signal = clampSignal(input.signal);
    this.db.prepare('INSERT INTO mem_feedback(id,run_id,node_id,edge_id,signal,source,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, input.runId ?? null, input.nodeId ?? null, input.edgeId ?? null, signal, input.source ?? 'run-outcome', nowIso());
    return this.db.prepare('SELECT * FROM mem_feedback WHERE id=?').get(id) as MemoryFeedback;
  }

  applyFeedback(nodeIds: string[], signal: number, runId?: string | null, source = 'run-outcome'): number {
    const unique = [...new Set(nodeIds)].filter(Boolean);
    if (!unique.length) return 0;
    const s = clampSignal(signal);
    const now = nowIso();
    const get = this.db.prepare('SELECT weight FROM mem_nodes WHERE id=?');
    const upd = this.db.prepare('UPDATE mem_nodes SET weight=?, wins=wins+?, losses=losses+? WHERE id=?');
    const ins = this.db.prepare('INSERT INTO mem_feedback(id,run_id,node_id,edge_id,signal,source,created_at) VALUES(?,?,?,?,?,?,?)');
    const tx = this.db.transaction(() => {
      for (const id of unique) {
        const row = get.get(id) as { weight: number } | undefined;
        if (!row) continue;
        // EMA: a single outcome nudges, it never dominates. Ranking signal only.
        const next = Math.max(-1, Math.min(1, 0.7 * Number(row.weight ?? 0) + 0.3 * s));
        upd.run(next, s > 0 ? 1 : 0, s < 0 ? 1 : 0, id);
        ins.run(`fb_${randomUUID().slice(0, 12)}`, runId ?? null, id, null, s, source, now);
      }
    });
    tx();
    return unique.length;
  }

  decayWeights(olderThanIso: string, factor: number): number {
    const f = Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 0.98;
    const r = this.db.prepare(`UPDATE mem_nodes SET weight = weight * ?
        WHERE weight <> 0 AND COALESCE(last_used_at, updated_at) < ?`).run(f, olderThanIso);
    return r.changes;
  }

  listFeedback(q: { runId?: string; nodeId?: string; limit?: number }): MemoryFeedback[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.runId) { where.push('run_id=?'); vals.push(q.runId); }
    if (q.nodeId) { where.push('node_id=?'); vals.push(q.nodeId); }
    const limit = clampInt(q.limit ?? 200, 1, 2000);
    return this.db.prepare(`SELECT * FROM mem_feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...vals as unknown[]) as MemoryFeedback[];
  }

  // ---------------- datasets + meta ----------------

  upsertDataset(id: string, kind: 'platform' | 'agent', label?: string): void {
    const now = nowIso();
    this.db.prepare(`INSERT INTO mem_datasets(id,kind,label,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET label=COALESCE(excluded.label, mem_datasets.label), updated_at=excluded.updated_at`)
      .run(id, kind, label ?? null, now, now);
  }

  listDatasets(): MemoryDataset[] {
    return this.db.prepare('SELECT * FROM mem_datasets ORDER BY id').all() as MemoryDataset[];
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM mem_meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO mem_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, value, nowIso());
  }

  // ---------------- vectors ----------------

  putVector(nodeId: string, dataset: string, model: string, vec: Float32Array): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare(`INSERT INTO mem_vectors(node_id,dataset,model,dim,vec,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(node_id,model) DO UPDATE SET dataset=excluded.dataset, dim=excluded.dim, vec=excluded.vec, created_at=excluded.created_at`)
      .run(nodeId, dataset, model, vec.length, buf, nowIso());
  }

  getVectors(dataset: string, model: string, limit = 20000): { node_id: string; vec: Float32Array }[] {
    const rows = this.db.prepare('SELECT node_id, vec FROM mem_vectors WHERE dataset=? AND model=? LIMIT ?')
      .all(dataset, model, clampInt(limit, 1, 100000)) as { node_id: string; vec: Buffer }[];
    return rows.map((r) => ({
      node_id: r.node_id,
      // Copy out of the Buffer's shared pool before reinterpreting the bytes.
      vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)),
    }));
  }

  // ---------------- stats ----------------

  stats(dataset?: string): MemoryStats {
    const scope = dataset ? 'WHERE dataset=?' : '';
    const args = dataset ? [dataset] : [];
    const one = (sql: string): number => (this.db.prepare(sql).get(...args as unknown[]) as { c: number }).c;
    const byType: Record<string, number> = {};
    for (const row of this.db.prepare(`SELECT node_type, COUNT(*) AS c FROM mem_nodes ${scope} GROUP BY node_type`).all(...args as unknown[]) as { node_type: string; c: number }[]) {
      byType[row.node_type] = row.c;
    }
    return {
      nodes: one(`SELECT COUNT(*) AS c FROM mem_nodes ${scope}`),
      edges: one(`SELECT COUNT(*) AS c FROM mem_edges ${scope}`),
      episodes: dataset ? 0 : (this.db.prepare('SELECT COUNT(*) AS c FROM mem_episodes').get() as { c: number }).c,
      datasets: dataset ? 1 : (this.db.prepare('SELECT COUNT(*) AS c FROM mem_datasets').get() as { c: number }).c,
      lessons: one(`SELECT COUNT(*) AS c FROM mem_nodes ${scope ? `${scope} AND` : 'WHERE'} node_type='Lesson'`),
      files: one(`SELECT COUNT(*) AS c FROM mem_nodes ${scope ? `${scope} AND` : 'WHERE'} node_type='File'`),
      vectors: one(`SELECT COUNT(*) AS c FROM mem_vectors ${dataset ? 'WHERE dataset=?' : ''}`),
      byType,
    };
  }

  close(): void {
    this.db.close();
  }

  // ---------------- internals ----------------

  private syncNodeFts(id: string): void {
    const row = this.db.prepare('SELECT dataset,node_type,name,terms,content FROM mem_nodes WHERE id=?').get(id) as
      { dataset: string; node_type: string; name: string; terms: string | null; content: string | null } | undefined;
    if (!row) return;
    this.db.prepare('DELETE FROM mem_nodes_fts WHERE id=?').run(id);
    this.db.prepare('INSERT INTO mem_nodes_fts(id,dataset,node_type,terms,body) VALUES(?,?,?,?,?)')
      .run(id, row.dataset, row.node_type, row.terms ?? expandTerms(row.name, row.content),
        clip(row.content ?? '', NODE_BODY_MAX));
  }

  private syncEdgeFts(id: string): void {
    const row = this.db.prepare('SELECT dataset,source_id,target_id,relation,edge_text FROM mem_edges WHERE id=?').get(id) as
      { dataset: string; source_id: string; target_id: string; relation: string; edge_text: string | null } | undefined;
    if (!row) return;
    this.db.prepare('DELETE FROM mem_edges_fts WHERE id=?').run(id);
    this.db.prepare('INSERT INTO mem_edges_fts(id,dataset,source_id,target_id,terms,body) VALUES(?,?,?,?,?,?)')
      .run(id, row.dataset, row.source_id, row.target_id, expandTerms(row.relation, row.edge_text),
        clip(row.edge_text ?? '', EDGE_BODY_MAX));
  }
}

/** Convenience: open a store at a path and register the standard datasets. */
export function openMemoryStore(path = './data/minion.db'): SqliteMemoryStore {
  const store = new SqliteMemoryStore(path);
  store.upsertDataset('platform', 'platform', 'Platform shared memory');
  return store;
}

function placeholders(n: number): string { return Array.from({ length: n }, () => '?').join(','); }
function clamp01(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }
function clampSignal(n: number): number { return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0; }
function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}
function stripRank<T extends { rank?: number }>(row: T): Omit<T, 'rank'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rank, ...rest } = row;
  return rest;
}
function stripRankMemEdge<T extends { rank?: number }>(row: T): Omit<T, 'rank'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rank, ...rest } = row;
  return rest;
}
