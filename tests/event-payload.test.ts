import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, clampEventPayload, EVENT_PAYLOAD_LIMIT } from '../src/store/sqlite.js';

const dir = mkdtempSync(join(tmpdir(), 'event-payload-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('persisted audit event payloads', () => {
  it('leaves small payloads untouched', () => {
    const raw = JSON.stringify({ tool: 'write', content: 'small' });
    expect(clampEventPayload(raw)).toBe(raw);
  });

  it('keeps oversized payloads parseable and self-describing', () => {
    const raw = JSON.stringify({ tool: 'write', content: 'x'.repeat(EVENT_PAYLOAD_LIMIT * 2) });
    const clamped = clampEventPayload(raw);
    expect(clamped.length).toBeLessThanOrEqual(EVENT_PAYLOAD_LIMIT);
    const parsed = JSON.parse(clamped) as { truncated: boolean; bytes: number; preview: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBe(raw.length);
    expect(parsed.preview.startsWith('{"tool":"write"')).toBe(true);
  });

  it('stores a huge tool result without corrupting the run event chain', () => {
    const db = new SqliteAdapter(join(dir, 'events.db'));
    try {
      const runId = db.createRun('a@1.0.0', 's', 'tr_x', 'm', 'openai', 'task', 'hash');
      const huge = JSON.stringify({ data: { result: { content: 'y'.repeat(60000) } } });
      db.appendEvent(runId, 1, 'tool.result', huge, true);
      db.appendEvent(runId, 2, 'run.complete', JSON.stringify({ chars: 3 }), true);
      const events = db.getEvents(runId, 0) as { seq: number; payload_json: string }[];
      expect(events).toHaveLength(2);
      for (const ev of events) expect(() => JSON.parse(ev.payload_json)).not.toThrow();
      expect((JSON.parse(events[0].payload_json) as { truncated?: boolean }).truncated).toBe(true);
      expect(JSON.parse(events[1].payload_json)).toEqual({ chars: 3 });
    } finally {
      db.close();
    }
  });
});
