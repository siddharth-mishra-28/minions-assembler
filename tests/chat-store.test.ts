import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/store/sqlite.js';

const dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
const db = new SqliteAdapter(join(dir, 'test.db'));
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('chat thread store (sqlite adapter)', () => {
  it('creates a 1:1 agent thread with generated chat_ id and empty transcript', () => {
    db.saveAgent('tester', '1.0.0', JSON.stringify({ schemaVersion: '1.0', metadata: { name: 'tester', version: '1.0.0' } }), 'h');
    const id = db.createChatThread({ title: 'Chat with tester@1.0.0', agentId: 'tester@1.0.0', sessionId: null });
    expect(id).toMatch(/^chat_[a-f0-9]{8}$/);
    const t = db.getChatThread(id);
    expect(t?.agent_id).toBe('tester@1.0.0');
    expect(db.getChatMessages(id)).toEqual([]);
  });

  it('persists messages in order, updates thread timestamp, and both survive thread refetch', () => {
    const id = db.createChatThread({ title: 't2', agentId: 'tester@1.0.0', sessionId: null });
    const u = db.addChatMessage(id, { role: 'user', author: 'user', content: 'hello' });
    const a = db.addChatMessage(id, { role: 'assistant', author: 'tester@1.0.0', content: 'hi!', runId: 'run_x' });
    expect(a).toBeGreaterThan(u);
    const msgs = db.getChatMessages(id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].run_id).toBe('run_x');
    expect(String((db.getChatThread(id) as { updated_at: string }).updated_at) >= String((db.getChatThread(id) as { created_at: string }).created_at)).toBe(true);
  });

  it('updateChatThread stores the persistent session id so turns share history', () => {
    const id = db.createChatThread({ title: 't3', agentId: 'tester@1.0.0', sessionId: null });
    expect(db.updateChatThread(id, { sessionId: 'chat_abc' })).toBe(true);
    expect((db.getChatThread(id) as { session_id: string }).session_id).toBe('chat_abc');
  });

  it('agent filter lists 1:1 threads; delete removes messages with the thread', () => {
    const id = db.createChatThread({ title: 'general', agentId: null, sessionId: null });
    db.addChatMessage(id, { role: 'user', author: 'user', content: '@tester ping' });
    const mine = db.listChatThreads({ agentId: 'tester@1.0.0' });
    expect(mine.every((t) => t.agent_id === 'tester@1.0.0')).toBe(true);
    expect(db.deleteChatThread(id)).toBe(true);
    expect(db.getChatThread(id)).toBeUndefined();
    expect(db.getChatMessages(id)).toEqual([]);
  });

  it('deleteChatThread returns false for unknown ids', () => {
    expect(db.deleteChatThread('chat_nope')).toBe(false);
  });
});
