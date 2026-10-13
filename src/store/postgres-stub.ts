import type { DbAdapter } from './adapter.js';

/** v1 stub: implements the same interface so the swap is mechanical later. */
export class PostgresAdapter implements DbAdapter {
  constructor(_connString?: string) {
    throw new Error('PostgresAdapter is a v1 stub (SQLite-first scope). Implement against DbAdapter using the same SQL with $ placeholders.');
  }
  saveAgent(): string { throw new Error('Not implemented'); }
  getAgent(): undefined { throw new Error('Not implemented'); }
  listAgents(): [] { throw new Error('Not implemented'); }
  createRun(): string { throw new Error('Not implemented'); }
  appendEvent(): void { throw new Error('Not implemented'); }
  finishRun(): void { throw new Error('Not implemented'); }
  recordUsage(): void { throw new Error('Not implemented'); }
  getRun(): undefined { throw new Error('Not implemented'); }
  listRuns(): [] { throw new Error('Not implemented'); }
  getEvents(): [] { throw new Error('Not implemented'); }
  saveMcpServer(): string { throw new Error('Not implemented'); }
  getMcpServer(): undefined { throw new Error('Not implemented'); }
  listMcpServers(): [] { throw new Error('Not implemented'); }
  updateMcpServerTools(): void { throw new Error('Not implemented'); }
  deleteMcpServer(): boolean { throw new Error('Not implemented'); }
  upsertSession(): void { throw new Error('Not implemented'); }
  getSession(): undefined { throw new Error('Not implemented'); }
  listSessions(): [] { throw new Error('Not implemented'); }
  close(): void { /* noop */ }
}
