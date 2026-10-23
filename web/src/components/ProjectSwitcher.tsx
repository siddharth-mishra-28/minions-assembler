import { useState } from 'react';
import { Check, ChevronsUpDown, FolderOpen, FolderPlus, X } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { useApiMutation, useProjects, qk } from '@/lib/queries';
import { useApp } from '@/lib/store';
import type { Project } from '@/lib/types';
import { FolderPicker } from './FolderPicker';
import { IconButton, cn, toast } from './ui';

export function ProjectSwitcher() {
  const { data: projects = [] } = useProjects();
  const { projectId, setProjectId } = useApp();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const current = projects.find((p) => p.id === projectId);
  const add = useApiMutation((path: string) => api<Project>('/api/projects', { method: 'POST', body: { path } }), {
    invalidate: [qk.projects, qk.bootstrap],
    onSuccess: (p) => { setProjectId(p.id); setPicker(false); toast.ok(`Opened ${p.name}`); },
  });
  const remove = useApiMutation((id: string) => api(`/api/projects/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.projects, qk.bootstrap],
    onSuccess: (_r, id) => { if (id === projectId) setProjectId(null); },
  });
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-left text-sm hover:border-accent/50">
        <FolderOpen className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{current?.name ?? 'No project'}</span>
          <span className="block truncate text-[11px] text-muted">{current?.path ?? 'Chat without a folder'}</span></span>
        <ChevronsUpDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="fade-in absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl">
            <button onClick={() => { setProjectId(null); setOpen(false); }} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2', !projectId && 'text-accent')}>
              <span className="flex-1">No project</span>{!projectId && <Check className="size-3.5" />}
            </button>
            {projects.map((p) => (
              <div key={p.id} className="group flex items-center rounded-md hover:bg-surface-2">
                <button onClick={() => { setProjectId(p.id); setOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
                  <span className="min-w-0 flex-1"><span className="block truncate">{p.name}</span><span className="block truncate text-[11px] text-muted">{p.path}</span></span>
                  {p.id === projectId && <Check className="size-3.5 text-accent" />}
                </button>
                <IconButton label="Remove from list" className="invisible size-6 group-hover:visible" onClick={() => remove.mutate(p.id)}><X className="size-3" /></IconButton>
              </div>
            ))}
            <div className="my-1 border-t border-border" />
            <button onClick={() => { setOpen(false); setPicker(true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-accent hover:bg-surface-2">
              <FolderPlus className="size-4" />Open folder…
            </button>
          </div>
        </>
      )}
      <FolderPicker open={picker} onClose={() => setPicker(false)} busy={add.isPending} onPick={(p) => add.mutate(p, { onError: (e) => toast.error(errMsg(e)) })} />
    </div>
  );
}
