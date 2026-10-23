import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BuiltinTool { name: string; group: string; description?: string }
export interface McpServer { name: string; description?: string; tools_json?: string; created_at?: string }
export interface InstructionFile { path: string; kind: string; bytes: number; preview?: string }
export interface AgentRow { id: string; name: string; version: string; created_at?: string; status?: string }

export const useBuiltinTools = () =>
  useQuery({ queryKey: ['builtin-tools'], staleTime: 300_000, queryFn: () => api<{ tools: BuiltinTool[] }>('/api/builtin-tools').then((r) => r.tools) });

export const useMcpServers = () =>
  useQuery({ queryKey: ['mcp-servers'], queryFn: () => api<{ servers: McpServer[] }>('/api/mcp').then((r) => r.servers) });

export const useProviderModels = (providerId: string | undefined) =>
  useQuery({
    queryKey: ['provider-models', providerId],
    enabled: !!providerId,
    staleTime: 60_000,
    retry: false,
    queryFn: () => api<{ models: (string | { id: string })[] }>(`/api/providers/${encodeURIComponent(providerId!)}/models`)
      .then((r) => r.models.map((m) => (typeof m === 'string' ? m : m.id))),
  });

export const useInstructionFiles = (workdir: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['instruction-files', workdir],
    enabled: enabled && !!workdir,
    retry: false,
    queryFn: () => api<{ files: InstructionFile[] }>(`/api/workspace/instruction-files?workdir=${encodeURIComponent(workdir!)}`).then((r) => r.files),
  });

export const useAgentRows = (kind: 'published' | 'drafts') =>
  useQuery({
    queryKey: ['agent-rows', kind],
    queryFn: () => kind === 'drafts'
      ? api<{ drafts: AgentRow[] }>('/api/agents/drafts').then((r) => r.drafts)
      : api<{ agents: AgentRow[] }>('/api/agents').then((r) => r.agents),
  });
