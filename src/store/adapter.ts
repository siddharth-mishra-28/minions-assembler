import type { RunStatus } from '../types.js';

export interface DbAdapter {
  saveAgent(name: string, version: string, definitionJson: string, hash: string): string;
  getAgent(id: string): { id: string; name: string; version: string; definition_json: string } | undefined;
  listAgents(): { id: string; name: string; version: string; created_at: string }[];
  createRun(agentId: string, sessionId: string, traceId: string, model: string, providerType: string, taskPrompt: string, definitionHash: string): string;
  appendEvent(runId: string, seq: number, type: string, payloadJson: string, persisted: boolean): void;
  finishRun(runId: string, status: RunStatus, error?: string): void;
  recordUsage(runId: string, usage: { tokensIn?: number; tokensOut?: number; credits?: number; durationMs?: number; endpoint?: string; requestId?: string }): void;
  getRun(runId: string): Record<string, unknown> | undefined;
  listRuns(agentId?: string): Record<string, unknown>[];
  getEvents(runId: string, afterSeq?: number): { seq: number; type: string; payload_json: string; persisted: number; at: string }[];
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
  close(): void;
}
