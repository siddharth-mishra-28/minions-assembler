import type { RunStatus } from '../core/types.js';

export interface DbAdapter {
  saveAgent(name: string, version: string, definitionJson: string, hash: string, status?: string): string;
  getAgent(id: string): { id: string; name: string; version: string; definition_json: string; definition_hash?: string | null; status?: string } | undefined;
  listAgents(status?: string): { id: string; name: string; version: string; created_at: string; status?: string }[];
  /** Replace an agent's definition in place (id stays `name@version`). Returns false if unknown. */
  updateAgentDefinition(id: string, definitionJson: string, hash: string): boolean;
  /** Hard-delete an agent row. Returns false if unknown. */
  deleteAgent(id: string): boolean;
  /** Counts used by delete-safety checks. */
  agentActivity(agentId: string): { activeRuns: number; activeSessions: number; totalRuns: number; totalSessions: number };
  /**
   * Extra run metadata: `definitionJson` is the sealed, portable definition snapshot
   * (env refs intact) that the run executes; `source` distinguishes chat runs from
   * headless/CLI runs and keeps chat threads linked to their runs.
   */
  createRun(agentId: string, sessionId: string, traceId: string, model: string, providerType: string, taskPrompt: string, definitionHash: string, extra?: { source?: string; threadId?: string; projectId?: string; definitionJson?: string | null }): string;
  setRunAuditPath(runId: string, path: string): void;
  appendEvent(runId: string, seq: number, type: string, payloadJson: string, persisted: boolean): void;
  finishRun(runId: string, status: RunStatus, error?: string): void;
  recordUsage(runId: string, usage: { tokensIn?: number; tokensOut?: number; credits?: number; durationMs?: number; endpoint?: string; requestId?: string }): void;
  getRun(runId: string): Record<string, unknown> | undefined;
  listRuns(agentId?: string): Record<string, unknown>[];
  /** The definition snapshot recorded at run start, or undefined for pre-snapshot runs. */
  getRunDefinition(runId: string): string | undefined;
  getEvents(runId: string, afterSeq?: number): { seq: number; type: string; payload_json: string; persisted: number; at: string }[];
  /** Hourly run/request buckets for dashboard charts (last N hours, oldest first). */
  runsTimeline(hours?: number): { hour: string; requests: number; succeeded: number; failed: number; running: number }[];
  /** Per-model effectiveness rollup (request counts, success rate, avg duration, tokens). */
  runsByModel(): { model: string; requests: number; succeeded: number; failed: number; avgDurationMs: number | null; tokensIn: number | null; tokensOut: number | null }[];
  /** Cumulative request/response counters (for thousands-scale headline numbers). */
  requestTotals(): { requests: number; responses: number; succeeded: number; failed: number };
  /** Aggregate usage over all finished runs (dashboard headline). */
  usageSummary(): { tokensIn: number | null; tokensOut: number | null; credits: number | null; avgDurationMs: number | null; rows: number };
  // MCP server registry
  saveMcpServer(input: { name: string; config_json: string; description?: string; tools_json?: string }): string;
  getMcpServer(name: string): { name: string; config_json: string; description: string | null; tools_json: string | null; created_at: string } | undefined;
  listMcpServers(): { name: string; description: string | null; tools_json: string | null; created_at: string }[];
  updateMcpServerTools(name: string, toolsJson: string): void;
  deleteMcpServer(name: string): boolean;
  // Session registry (SDK session lifecycle, auditable)
  upsertSession(input: { sessionId: string; runId?: string; agentId?: string; traceId?: string; status?: string; summary?: string }): void;
  getSession(sessionId: string): Record<string, unknown> | undefined;
  listSessions(): Record<string, unknown>[];
  // Encrypted provider credentials (AES-256-GCM at rest; secrets never returned by list)
  saveCredential(name: string, secret: string): void;
  getCredentialSecret(name: string): string | undefined;
  listCredentials(): { name: string; created_at: string; updated_at: string }[];
  deleteCredential(name: string): boolean;
  // Chat (persistent multi-turn agent conversations)
  createChatThread(input: { title: string; agentId: string | null; sessionId: string | null; projectId?: string | null; modelOverride?: string | null }): string;
  getChatThread(id: string): Record<string, unknown> | undefined;
  listChatThreads(filter?: { agentId?: string; projectId?: string; includeArchived?: boolean; q?: string }): Record<string, unknown>[];
  updateChatThread(id: string, fields: { title?: string; sessionId?: string | null; updated_at?: string; agentId?: string | null; projectId?: string | null; pinned?: boolean; archived?: boolean; modelOverride?: string | null; approvalMode?: string | null }): boolean;
  deleteChatThread(id: string): boolean;
  addChatMessage(threadId: string, m: { role: string; author: string; content: string; runId?: string | null; meta?: Record<string, unknown> | null }): number;
  getChatMessages(threadId: string): Record<string, unknown>[];  close(): void;
}
