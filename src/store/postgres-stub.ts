import type { DbAdapter } from './adapter.js';

/** v1 stub: implements the same interface so the swap is mechanical later. */
export class PostgresAdapter implements DbAdapter {
  constructor(_connString?: string) {
    throw new Error('PostgresAdapter is a v1 stub (SQLite-first scope). Implement against DbAdapter using the same SQL with $ placeholders.');
  }
  saveAgent(): string { throw new Error('Not implemented'); }
  getAgent(): undefined { throw new Error('Not implemented'); }
  listAgents(): [] { throw new Error('Not implemented'); }
  updateAgentDefinition(): boolean { throw new Error('Not implemented'); }
  deleteAgent(): boolean { throw new Error('Not implemented'); }
  agentActivity(): { activeRuns: number; activeSessions: number; totalRuns: number; totalSessions: number } { throw new Error('Not implemented'); }
  setRunAuditPath(): void { throw new Error('Not implemented'); }
  createRun(): string { throw new Error('Not implemented'); }
  appendEvent(): void { throw new Error('Not implemented'); }
  finishRun(): void { throw new Error('Not implemented'); }
  recordUsage(): void { throw new Error('Not implemented'); }
  getRun(): undefined { throw new Error('Not implemented'); }
  listRuns(): [] { throw new Error('Not implemented'); }
  getRunDefinition(): undefined { throw new Error('Not implemented'); }
  getEvents(): [] { throw new Error('Not implemented'); }
  runsTimeline(): [] { throw new Error('Not implemented'); }
  runsByModel(): [] { throw new Error('Not implemented'); }
  requestTotals(): { requests: number; responses: number; succeeded: number; failed: number } { throw new Error('Not implemented'); }
  usageSummary(): { tokensIn: number | null; tokensOut: number | null; credits: number | null; avgDurationMs: number | null; rows: number } { throw new Error('Not implemented'); }
  saveMcpServer(): string { throw new Error('Not implemented'); }
  getMcpServer(): undefined { throw new Error('Not implemented'); }
  listMcpServers(): [] { throw new Error('Not implemented'); }
  updateMcpServerTools(): void { throw new Error('Not implemented'); }
  deleteMcpServer(): boolean { throw new Error('Not implemented'); }
  upsertSession(): void { throw new Error('Not implemented'); }
  getSession(): undefined { throw new Error('Not implemented'); }
  listSessions(): [] { throw new Error('Not implemented'); }
  saveCredential(): void { throw new Error('Not implemented'); }
  getCredentialSecret(): undefined { throw new Error('Not implemented'); }
  listCredentials(): [] { throw new Error('Not implemented'); }
  deleteCredential(): boolean { throw new Error('Not implemented'); }
  createChatThread(): string { throw new Error('Not implemented'); }
  getChatThread(): undefined { throw new Error('Not implemented'); }
  listChatThreads(): [] { throw new Error('Not implemented'); }
  updateChatThread(): boolean { throw new Error('Not implemented'); }
  deleteChatThread(): boolean { throw new Error('Not implemented'); }
  addChatMessage(): number { throw new Error('Not implemented'); }
  getChatMessages(): [] { throw new Error('Not implemented'); }
  close(): void { /* noop */ }
}
