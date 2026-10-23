import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Approval, Bootstrap, ChatAgent, ChatMessage, Project, Provider, Thread, AppSettings } from './types';

export const qk = {
  bootstrap: ['bootstrap'] as const,
  providers: ['providers'] as const,
  projects: ['projects'] as const,
  agents: (projectId?: string | null) => ['chat-agents', projectId ?? null] as const,
  threads: (f?: unknown) => ['threads', f ?? null] as const,
  thread: (id: string) => ['thread', id] as const,
  settings: ['settings'] as const,
};

export const useBootstrap = () => useQuery({ queryKey: qk.bootstrap, queryFn: () => api<Bootstrap>('/api/bootstrap'), staleTime: 10_000 });
export const useProviders = () => useQuery({ queryKey: qk.providers, queryFn: () => api<{ providers: Provider[] }>('/api/providers').then((r) => r.providers) });
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api<{ projects: Project[] }>('/api/projects').then((r) => r.projects) });
export const useChatAgents = (projectId?: string | null) =>
  useQuery({ queryKey: qk.agents(projectId), queryFn: () => api<{ agents: ChatAgent[] }>(`/api/chat/agents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => r.agents) });
export const useThreads = (filter: { projectId?: string | null; q?: string; archived?: boolean } = {}) =>
  useQuery({
    queryKey: qk.threads(filter),
    queryFn: () => {
      const p = new URLSearchParams();
      if (filter.projectId) p.set('projectId', filter.projectId);
      if (filter.q) p.set('q', filter.q);
      if (filter.archived) p.set('archived', 'true');
      return api<{ threads: Thread[] }>(`/api/chat/threads?${p}`).then((r) => r.threads);
    },
  });
export const useThread = (id: string | undefined) =>
  useQuery({
    queryKey: qk.thread(id ?? ''),
    enabled: !!id,
    queryFn: () => api<Thread & { messages: ChatMessage[]; pendingApprovals: Approval[]; busy: boolean }>(`/api/chat/threads/${id}`),
  });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => api<AppSettings>('/api/settings') });

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: (readonly unknown[])[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

export function useApiMutation<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { invalidate?: (readonly unknown[])[]; onSuccess?: (r: TRes, v: TVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => { opts.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k })); opts.onSuccess?.(r, v); },
  });
}
