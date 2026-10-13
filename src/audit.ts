import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubSecrets } from './loader.js';

export interface AuditEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  persisted: boolean;
  at: string;
}

export function newTraceId(): string {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class AuditLog {
  private seq = 0;
  constructor(private runDir: string) {
    mkdirSync(runDir, { recursive: true });
  }
  append(type: string, payload: Record<string, unknown>, persisted = true): AuditEvent {
    const ev: AuditEvent = {
      seq: ++this.seq,
      type,
      payload: scrubSecrets(payload) as Record<string, unknown>,
      persisted,
      at: new Date().toISOString(),
    };
    appendFileSync(join(this.runDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    return ev;
  }
}
