import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Folder, GitBranch, HardDrive, Home } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { Button, Input, Modal, Spinner, cn } from './ui';

interface Browse { path: string; parent: string | null; home: string; isGitRepo?: boolean; roots?: string[]; entries: { name: string; path: string }[] }

export function FolderPicker({ open, onClose, onPick, busy }: { open: boolean; onClose: () => void; onPick: (path: string) => void; busy?: boolean }) {
  const [path, setPath] = useState<string>('');
  const [typed, setTyped] = useState('');
  const q = useQuery({
    queryKey: ['fs', path],
    enabled: open,
    retry: false,
    queryFn: () => api<Browse>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  });
  const cur = q.data?.path ?? '';
  const go = (p: string) => { setPath(p); setTyped(p); };
  return (
    <Modal open={open} onClose={onClose} title="Open project folder" width="max-w-xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!cur} loading={busy} onClick={() => onPick(cur)}>Open this folder</Button>
      </>}>
      <div className="space-y-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setPath(typed.trim()); }}>
          <Input value={typed || cur} onChange={(e) => setTyped(e.target.value)} placeholder="Paste a folder path and press Enter" className="font-mono text-xs" aria-label="Folder path" />
          <Button type="submit">Go</Button>
        </form>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => go('')}><HardDrive className="size-3.5" />Drives</Button>
          {q.data?.home && <Button size="sm" variant="ghost" onClick={() => go(q.data!.home)}><Home className="size-3.5" />Home</Button>}
          {q.data?.parent ? <Button size="sm" variant="ghost" onClick={() => go(q.data!.parent!)}><ArrowUp className="size-3.5" />Up</Button> : q.data?.path ? <Button size="sm" variant="ghost" onClick={() => go('')}><ArrowUp className="size-3.5" />Up</Button> : null}
          {q.data?.isGitRepo && <span className="ml-auto inline-flex items-center gap-1 text-xs text-ok"><GitBranch className="size-3.5" />Git repository</span>}
        </div>
        <div className="h-72 overflow-y-auto rounded-lg border border-border">
          {q.isLoading || !q.data && !q.error ? <div className="flex h-full items-center justify-center"><Spinner /></div>
            : q.error ? <div className="p-4 text-sm text-danger">{errMsg(q.error)}</div>
            : q.data!.entries.length === 0 ? <div className="p-4 text-sm text-muted">No sub-folders.</div>
            : q.data!.entries.map((e) => (
              <button key={e.path} onClick={() => go(e.path)} className={cn('flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2')}>
                <Folder className="size-4 text-accent" /><span className="truncate">{e.name}</span>
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}
