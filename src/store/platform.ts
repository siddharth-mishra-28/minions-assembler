import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { SqliteAdapter } from './sqlite.js';

export type ApprovalMode = 'interactive' | 'autopilot' | 'strict';
export type RetentionScope = 'everything' | 'chats';

export interface AppSettings {
  retention: { days: number; scope: RetentionScope; keepPinned: boolean };
  approvals: { chatMode: ApprovalMode; timeoutSec: number };
  defaults: { providerId: string | null; model: string | null; systemPrompt: string };
  audit: { level: 'minimal' | 'standard' | 'full' };
  onboarding: { completed: boolean };
}

export const DEFAULT_SETTINGS: AppSettings = {
  retention: { days: 7, scope: 'everything', keepPinned: true },
  approvals: { chatMode: 'interactive', timeoutSec: 300 },
  defaults: { providerId: null, model: null, systemPrompt: '' },
  audit: { level: 'standard' },
  onboarding: { completed: false },
};

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  defaultModel: string | null;
  credentialName: string | null;
  wireApi: string | null;
  azureApiVersion: string | null;
  isDefault: boolean;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  settings: Record<string, unknown>;
}

export interface ApprovalRow {
  id: string;
  threadId: string | null;
  runId: string | null;
  tool: string;
  args: unknown;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  scope: string | null;
  decidedBy: string | null;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface PurgeResult {
  cutoff: string;
  runs: number;
  threads: number;
  messages: number;
  approvals: number;
  paths: string[];
}

const mergeDeep = <T extends object>(base: T, patch: unknown): T => {
  if (!patch || typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object') out[k] = mergeDeep(cur as object, v);
    else if (v !== undefined && (typeof v === typeof cur || cur === null)) out[k] = v;
  }
  return out as T;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider';

/** Settings, providers, projects, approvals, rollups and the retention sweep. Shares the adapter's connection. */
export class PlatformStore {
  constructor(private readonly store: SqliteAdapter) {}
  private get db() { return this.store.raw; }

  // ---------- settings ----------
  getSettings(): AppSettings {
    const rows = this.db.prepare(`SELECT key,value_json FROM settings`).all() as { key: string; value_json: string }[];
    let out: AppSettings = structuredClone(DEFAULT_SETTINGS);
    for (const r of rows) {
      try { out = mergeDeep(out, { [r.key]: JSON.parse(r.value_json) }); } catch { /* ignore corrupt row */ }
    }
    return out;
  }
  /** Shallow-per-section merge; unknown sections/keys are ignored; values are validated. */
  updateSettings(patch: unknown): AppSettings {
    const merged = mergeDeep(this.getSettings(), patch);
    merged.retention.days = Math.min(3650, Math.max(0, Math.floor(Number(merged.retention.days) || 0)));
    if (!['everything', 'chats'].includes(merged.retention.scope)) merged.retention.scope = 'everything';
    if (!['interactive', 'autopilot', 'strict'].includes(merged.approvals.chatMode)) merged.approvals.chatMode = 'interactive';
    merged.approvals.timeoutSec = Math.min(3600, Math.max(10, Math.floor(Number(merged.approvals.timeoutSec) || 300)));
    if (!['minimal', 'standard', 'full'].includes(merged.audit.level)) merged.audit.level = 'standard';
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) stmt.run(k, JSON.stringify(merged[k]), now);
    })();
    return merged;
  }

  // ---------- providers ----------
  private mapProvider(r: Record<string, unknown>): ProviderRow {
    return {
      id: r.id as string,
      name: r.name as string,
      type: r.type as string,
      baseUrl: r.base_url as string,
      defaultModel: (r.default_model as string | null) ?? null,
      credentialName: (r.credential_name as string | null) ?? null,
      wireApi: (r.wire_api as string | null) ?? null,
      azureApiVersion: (r.azure_api_version as string | null) ?? null,
      isDefault: !!r.is_default,
      hasKey: !!r.credential_name && this.store.getCredentialSecret(r.credential_name as string) !== undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }
  listProviders(): ProviderRow[] {
    return (this.db.prepare(`SELECT * FROM providers ORDER BY is_default DESC, name`).all() as Record<string, unknown>[]).map((r) => this.mapProvider(r));
  }
  getProvider(id: string): ProviderRow | undefined {
    const r = this.db.prepare(`SELECT * FROM providers WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapProvider(r) : undefined;
  }
  getDefaultProvider(): ProviderRow | undefined {
    const wanted = this.getSettings().defaults.providerId;
    const r = (wanted ? this.db.prepare(`SELECT * FROM providers WHERE id=?`).get(wanted) : undefined)
      ?? this.db.prepare(`SELECT * FROM providers WHERE is_default=1 LIMIT 1`).get()
      ?? this.db.prepare(`SELECT * FROM providers ORDER BY created_at LIMIT 1`).get();
    return r ? this.mapProvider(r as Record<string, unknown>) : undefined;
  }
  /** Plaintext key (server-side only — never serialised to HTTP responses). */
  getProviderSecret(id: string): string | undefined {
    const p = this.getProvider(id);
    return p?.credentialName ? this.store.getCredentialSecret(p.credentialName) : undefined;
  }
  createProvider(input: { name: string; type?: string; baseUrl: string; defaultModel?: string | null; apiKey?: string; wireApi?: string | null; azureApiVersion?: string | null; makeDefault?: boolean }): ProviderRow {
    const id = `${slug(input.name)}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    let credentialName: string | null = null;
    if (input.apiKey?.trim()) {
      credentialName = `provider:${id}`;
      this.store.saveCredential(credentialName, input.apiKey.trim());
    }
    const first = (this.db.prepare(`SELECT COUNT(*) AS n FROM providers`).get() as { n: number }).n === 0;
    this.db.prepare(`INSERT INTO providers(id,name,type,base_url,default_model,credential_name,wire_api,azure_api_version,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)`)
      .run(id, input.name.trim(), input.type ?? 'openai', input.baseUrl.trim().replace(/\/+$/, ''), input.defaultModel ?? null, credentialName, input.wireApi ?? null, input.azureApiVersion ?? null, now, now);
    if (input.makeDefault || first) this.setDefaultProvider(id);
    return this.getProvider(id)!;
  }
  updateProvider(id: string, patch: { name?: string; type?: string; baseUrl?: string; defaultModel?: string | null; apiKey?: string; wireApi?: string | null; azureApiVersion?: string | null }): ProviderRow | undefined {
    const cur = this.getProvider(id);
    if (!cur) return undefined;
    let credentialName = cur.credentialName;
    if (patch.apiKey?.trim()) {
      credentialName = credentialName ?? `provider:${id}`;
      this.store.saveCredential(credentialName, patch.apiKey.trim());
    }
    this.db.prepare(`UPDATE providers SET name=?,type=?,base_url=?,default_model=?,credential_name=?,wire_api=?,azure_api_version=?,updated_at=? WHERE id=?`).run(
      patch.name?.trim() || cur.name,
      patch.type ?? cur.type,
      (patch.baseUrl ?? cur.baseUrl).trim().replace(/\/+$/, ''),
      patch.defaultModel !== undefined ? patch.defaultModel : cur.defaultModel,
      credentialName,
      patch.wireApi !== undefined ? patch.wireApi : cur.wireApi,
      patch.azureApiVersion !== undefined ? patch.azureApiVersion : cur.azureApiVersion,
      new Date().toISOString(), id);
    return this.getProvider(id);
  }
  setDefaultProvider(id: string): boolean {
    if (!this.getProvider(id)) return false;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE providers SET is_default=0`).run();
      this.db.prepare(`UPDATE providers SET is_default=1 WHERE id=?`).run(id);
    })();
    this.updateSettings({ defaults: { providerId: id } });
    return true;
  }
  deleteProvider(id: string): boolean {
    const p = this.getProvider(id);
    if (!p) return false;
    if (p.credentialName) this.store.deleteCredential(p.credentialName);
    const r = this.db.prepare(`DELETE FROM providers WHERE id=?`).run(id).changes > 0;
    if (r && this.getSettings().defaults.providerId === id) {
      const next = this.listProviders()[0];
      this.updateSettings({ defaults: { providerId: next?.id ?? null } });
      if (next) this.setDefaultProvider(next.id);
    }
    return r;
  }

  // ---------- projects ----------
  private mapProject(r: Record<string, unknown>): ProjectRow {
    let settings: Record<string, unknown> = {};
    try { settings = r.settings_json ? JSON.parse(r.settings_json as string) : {}; } catch { /* ignore */ }
    return { id: r.id as string, name: r.name as string, path: r.path as string, createdAt: r.created_at as string, lastOpenedAt: r.last_opened_at as string, settings };
  }
  listProjects(): ProjectRow[] {
    return (this.db.prepare(`SELECT * FROM projects ORDER BY last_opened_at DESC`).all() as Record<string, unknown>[]).map((r) => this.mapProject(r));
  }
  getProject(id: string): ProjectRow | undefined {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapProject(r) : undefined;
  }
  /** Register (or re-open) a folder as a project. Throws if the path is not an existing directory. */
  openProject(path: string, name?: string): ProjectRow {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM projects WHERE path=?`).get(abs) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE projects SET last_opened_at=?, name=COALESCE(?,name) WHERE id=?`).run(now, name?.trim() || null, existing.id);
      return this.getProject(existing.id)!;
    }
    const id = `proj_${randomUUID().slice(0, 8)}`;
    this.db.prepare(`INSERT INTO projects(id,name,path,settings_json,created_at,last_opened_at) VALUES(?,?,?,?,?,?)`).run(id, name?.trim() || basename(abs) || abs, abs, '{}', now, now);
    return this.getProject(id)!;
  }
  updateProject(id: string, patch: { name?: string; settings?: Record<string, unknown> }): ProjectRow | undefined {
    const cur = this.getProject(id);
    if (!cur) return undefined;
    this.db.prepare(`UPDATE projects SET name=?, settings_json=? WHERE id=?`).run(patch.name?.trim() || cur.name, JSON.stringify(patch.settings ?? cur.settings), id);
    return this.getProject(id);
  }
  /** Removes the project registration only; chats keep their (now orphaned) history until retention purges it. */
  deleteProject(id: string): boolean {
    this.db.prepare(`UPDATE chat_threads SET project_id=NULL WHERE project_id=?`).run(id);
    return this.db.prepare(`DELETE FROM projects WHERE id=?`).run(id).changes > 0;
  }

  // ---------- approvals ----------
  private mapApproval(r: Record<string, unknown>): ApprovalRow {
    let args: unknown = null;
    try { args = r.args_json ? JSON.parse(r.args_json as string) : null; } catch { /* ignore */ }
    return {
      id: r.id as string, threadId: (r.thread_id as string | null) ?? null, runId: (r.run_id as string | null) ?? null,
      tool: r.tool as string, args, status: r.status as ApprovalRow['status'], scope: (r.scope as string | null) ?? null,
      decidedBy: (r.decided_by as string | null) ?? null, reason: (r.reason as string | null) ?? null,
      requestedAt: r.requested_at as string, decidedAt: (r.decided_at as string | null) ?? null,
    };
  }
  createApproval(input: { threadId?: string | null; runId?: string | null; tool: string; args: unknown }): ApprovalRow {
    const id = `apr_${randomUUID().slice(0, 10)}`;
    this.db.prepare(`INSERT INTO approvals(id,thread_id,run_id,tool,args_json,status,requested_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(id, input.threadId ?? null, input.runId ?? null, input.tool, JSON.stringify(input.args ?? null).slice(0, 20000), new Date().toISOString());
    return this.getApproval(id)!;
  }
  getApproval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapApproval(r) : undefined;
  }
  resolveApproval(id: string, status: 'approved' | 'denied' | 'expired', info: { scope?: string; decidedBy?: string; reason?: string } = {}): boolean {
    return this.db.prepare(`UPDATE approvals SET status=?, scope=?, decided_by=?, reason=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(status, info.scope ?? null, info.decidedBy ?? null, info.reason ?? null, new Date().toISOString(), id).changes > 0;
  }
  listApprovals(filter: { threadId?: string; status?: string; limit?: number } = {}): ApprovalRow[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.threadId) { where.push('thread_id=?'); vals.push(filter.threadId); }
    if (filter.status) { where.push('status=?'); vals.push(filter.status); }
    const sql = `SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT ${Math.min(500, filter.limit ?? 100)}`;
    return (this.db.prepare(sql).all(...vals) as Record<string, unknown>[]).map((r) => this.mapApproval(r));
  }
  /** Anything still pending after a restart can never be answered — mark it expired. */
  expireStaleApprovals(): number {
    return this.db.prepare(`UPDATE approvals SET status='expired', decided_at=? WHERE status='pending'`).run(new Date().toISOString()).changes;
  }

  // ---------- metrics rollups ----------
  rollupTotals(): { runs: number; succeeded: number; failed: number; tokensIn: number; tokensOut: number; credits: number } {
    const r = this.db.prepare(`SELECT COALESCE(SUM(runs),0) runs, COALESCE(SUM(succeeded),0) succeeded, COALESCE(SUM(failed),0) failed, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(credits),0) credits FROM metrics_daily`).get() as Record<string, number>;
    return { runs: r.runs, succeeded: r.succeeded, failed: r.failed, tokensIn: r.tokens_in, tokensOut: r.tokens_out, credits: r.credits };
  }
  dailyMetrics(days = 30): { day: string; runs: number; succeeded: number; failed: number; tokensIn: number; tokensOut: number; credits: number }[] {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = this.db.prepare(`
      SELECT day, SUM(runs) runs, SUM(succeeded) succeeded, SUM(failed) failed, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(credits) credits FROM (
        SELECT day, runs, succeeded, failed, tokens_in, tokens_out, credits FROM metrics_daily
        UNION ALL
        SELECT substr(r.created_at,1,10), 1, r.status='done', r.status='failed', COALESCE(u.tokens_in,0), COALESCE(u.tokens_out,0), COALESCE(u.credits,0)
          FROM runs r LEFT JOIN usage u ON u.run_id=r.id)
      WHERE day >= ? GROUP BY day ORDER BY day`).all(cutoff) as Record<string, number | string>[];
    return rows.map((r) => ({ day: r.day as string, runs: Number(r.runs), succeeded: Number(r.succeeded), failed: Number(r.failed), tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), credits: Number(r.credits) }));
  }

  // ---------- retention ----------
  /**
   * Delete data older than `days` (0 = keep forever). Totals are rolled into metrics_daily first so
   * dashboards survive the purge. Returns filesystem paths the caller should remove.
   */
  purge(opts?: { days?: number; scope?: RetentionScope; keepPinned?: boolean; now?: number }): PurgeResult {
    const s = this.getSettings().retention;
    const days = opts?.days ?? s.days;
    const scope = opts?.scope ?? s.scope;
    const keepPinned = opts?.keepPinned ?? s.keepPinned;
    const cutoff = new Date((opts?.now ?? Date.now()) - days * 86400000).toISOString();
    const result: PurgeResult = { cutoff, runs: 0, threads: 0, messages: 0, approvals: 0, paths: [] };
    if (days <= 0) return result;

    const db = this.db;
    db.transaction(() => {
      const pinnedFilter = keepPinned ? `AND (r.thread_id IS NULL OR r.thread_id NOT IN (SELECT id FROM chat_threads WHERE pinned=1))` : '';
      const scopeFilter = scope === 'chats' ? `AND r.source='chat'` : '';
      const runRows = db.prepare(`SELECT r.id, r.status, r.audit_path, substr(r.created_at,1,10) AS day, u.tokens_in, u.tokens_out, u.credits, t.path AS transcript
        FROM runs r LEFT JOIN usage u ON u.run_id=r.id LEFT JOIN transcripts t ON t.run_id=r.id
        WHERE r.created_at < ? AND r.status != 'running' ${pinnedFilter} ${scopeFilter}`).all(cutoff) as { id: string; status: string; audit_path: string | null; day: string; tokens_in: number | null; tokens_out: number | null; credits: number | null; transcript: string | null }[];

      const roll = db.prepare(`INSERT INTO metrics_daily(day,runs,succeeded,failed,tokens_in,tokens_out,credits) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET runs=runs+excluded.runs, succeeded=succeeded+excluded.succeeded, failed=failed+excluded.failed, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out, credits=credits+excluded.credits`);
      const delEvents = db.prepare(`DELETE FROM events WHERE run_id=?`);
      const delUsage = db.prepare(`DELETE FROM usage WHERE run_id=?`);
      const delTr = db.prepare(`DELETE FROM transcripts WHERE run_id=?`);
      const delSess = db.prepare(`DELETE FROM sessions WHERE run_id=?`);
      const delRun = db.prepare(`DELETE FROM runs WHERE id=?`);
      for (const r of runRows) {
        roll.run(r.day, 1, r.status === 'done' ? 1 : 0, r.status === 'failed' ? 1 : 0, r.tokens_in ?? 0, r.tokens_out ?? 0, r.credits ?? 0);
        delEvents.run(r.id); delUsage.run(r.id); delTr.run(r.id); delSess.run(r.id); delRun.run(r.id);
        if (r.audit_path) result.paths.push(r.audit_path);
        if (r.transcript) result.paths.push(r.transcript);
        result.runs++;
      }

      const pinnedThread = keepPinned ? 'AND pinned=0' : '';
      result.messages = db.prepare(`DELETE FROM chat_messages WHERE created_at < ? AND thread_id IN (SELECT id FROM chat_threads WHERE 1=1 ${pinnedThread})`).run(cutoff).changes;
      const doomed = db.prepare(`SELECT id FROM chat_threads WHERE (updated_at < ? OR NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id=chat_threads.id)) AND created_at < ? ${pinnedThread}`).all(cutoff, cutoff) as { id: string }[];
      for (const t of doomed) {
        result.messages += db.prepare(`DELETE FROM chat_messages WHERE thread_id=?`).run(t.id).changes;
        db.prepare(`DELETE FROM approvals WHERE thread_id=?`).run(t.id);
        db.prepare(`DELETE FROM chat_threads WHERE id=?`).run(t.id);
        result.threads++;
      }
      result.approvals = db.prepare(`DELETE FROM approvals WHERE requested_at < ? AND status != 'pending'`).run(cutoff).changes;
    })();

    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    return result;
  }
}
