import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/store/sqlite.js';
import { PlatformStore } from '../src/store/platform.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'platform-store-'));
const db = new SqliteAdapter(join(dir, 'p.db'));
const platform = new PlatformStore(db);
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migrations', () => {
  it('stamps user_version and is idempotent on reopen', () => {
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const p = join(dir, 'again.db');
    new SqliteAdapter(p).close();
    const again = new SqliteAdapter(p);
    expect(again.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    again.close();
  });
  it('upgrades a pre-versioning database in place', () => {
    const p = join(dir, 'legacy.db');
    const raw = new Database(p);
    raw.exec(`CREATE TABLE chat_threads(id TEXT PRIMARY KEY, title TEXT, agent_id TEXT, session_id TEXT, created_at TEXT, updated_at TEXT);
              CREATE TABLE chat_messages(mtid INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, role TEXT, author TEXT, content TEXT, run_id TEXT, created_at TEXT);
              INSERT INTO chat_threads VALUES('chat_old','old','a@1',NULL,'2020-01-01','2020-01-01');`);
    raw.close();
    const up = new SqliteAdapter(p);
    expect(up.getChatThread('chat_old')?.pinned).toBe(0);
    up.close();
  });
});

describe('settings', () => {
  it('returns defaults and clamps/validates updates', () => {
    expect(platform.getSettings().retention.days).toBe(7);
    const s = platform.updateSettings({ retention: { days: 30 }, approvals: { chatMode: 'bogus', timeoutSec: 1 }, evil: { x: 1 } });
    expect(s.retention.days).toBe(30);
    expect(s.approvals.chatMode).toBe('interactive');
    expect(s.approvals.timeoutSec).toBe(10);
    expect(platform.getSettings().retention.days).toBe(30);
    platform.updateSettings({ retention: { days: 7 } });
  });
});

describe('providers', () => {
  it('stores the key in the vault, never exposes it, first provider is default', () => {
    const p = platform.createProvider({ name: 'My OpenAI', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-secret', defaultModel: 'gpt-4o' });
    expect(p.baseUrl).toBe('https://api.openai.com/v1');
    expect(p.hasKey).toBe(true);
    expect(JSON.stringify(p)).not.toContain('sk-secret');
    expect(platform.getProviderSecret(p.id)).toBe('sk-secret');
    expect(platform.getDefaultProvider()?.id).toBe(p.id);
    expect(platform.deleteProvider(p.id)).toBe(true);
    expect(db.listCredentials().find((c) => c.name.startsWith('provider:'))).toBeUndefined();
  });
});

describe('projects', () => {
  it('registers a folder once, rejects non-directories', () => {
    const a = platform.openProject(dir);
    const b = platform.openProject(dir);
    expect(a.id).toBe(b.id);
    expect(() => platform.openProject(join(dir, 'nope'))).toThrow(/Not a directory/);
  });
});

describe('retention purge', () => {
  it('purges old unpinned data, rolls up metrics, keeps pinned and fresh data', () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const keepOld = db.createChatThread({ title: 'pinned', agentId: null, sessionId: null });
    const dropOld = db.createChatThread({ title: 'drop', agentId: null, sessionId: null });
    const fresh = db.createChatThread({ title: 'fresh', agentId: null, sessionId: null });
    db.addChatMessage(keepOld, { role: 'user', author: 'u', content: 'x' });
    db.addChatMessage(dropOld, { role: 'user', author: 'u', content: 'y' });
    db.addChatMessage(fresh, { role: 'user', author: 'u', content: 'z' });
    db.updateChatThread(keepOld, { pinned: true });
    db.raw.prepare(`UPDATE chat_threads SET created_at=?, updated_at=? WHERE id IN (?,?)`).run(old, old, keepOld, dropOld);
    db.raw.prepare(`UPDATE chat_messages SET created_at=? WHERE thread_id IN (?,?)`).run(old, keepOld, dropOld);

    const runId = db.createRun('a@1', 's', 't-purge', 'm', 'openai', 'task', 'h', { source: 'chat', threadId: dropOld });
    db.finishRun(runId, 'done');
    db.recordUsage(runId, { tokensIn: 10, tokensOut: 5, credits: 1 });
    mkdirSync(join(dir, 'audit', runId), { recursive: true });
    db.setRunAuditPath(runId, join(dir, 'audit', runId));
    db.raw.prepare(`UPDATE runs SET created_at=? WHERE id=?`).run(old, runId);
    db.appendEvent(runId, 1, 'run.start', '{}', true);

    const before = platform.rollupTotals().runs;
    const r = platform.purge({ days: 7 });
    expect(r.runs).toBe(1);
    expect(r.threads).toBe(1);
    expect(r.paths).toContain(join(dir, 'audit', runId));
    expect(db.getChatThread(dropOld)).toBeUndefined();
    expect(db.getChatThread(keepOld)).toBeDefined();
    expect(db.getChatMessages(keepOld)).toHaveLength(1);
    expect(db.getChatThread(fresh)).toBeDefined();
    expect(db.getRun(runId)).toBeUndefined();
    expect(db.getEvents(runId)).toHaveLength(0);
    expect(platform.rollupTotals().runs).toBe(before + 1);
    expect(platform.rollupTotals().tokensIn).toBeGreaterThanOrEqual(10);
  });
  it('days=0 keeps everything', () => {
    expect(platform.purge({ days: 0 }).runs).toBe(0);
  });
});
