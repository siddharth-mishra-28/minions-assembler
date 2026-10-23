import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArchiveRestore, Bot, Download, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useThreads } from '@/lib/queries';
import { useApp } from '@/lib/store';
import type { Thread } from '@/lib/types';
import { Spinner, cn, toast } from './ui';

const bucket = (iso: string): string => {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days < 1 ? 'Today' : days < 2 ? 'Yesterday' : days < 8 ? 'Previous 7 days' : 'Older';
};

export function ThreadList() {
  const { projectId } = useApp();
  const nav = useNavigate();
  const { threadId } = useParams();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { data: threads = [], isLoading } = useThreads({ projectId, q: q || undefined, archived: showArchived });
  const patch = useApiMutation(({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/api/chat/threads/${id}`, { method: 'PATCH', body }), { invalidate: [['threads']] });
  const del = useApiMutation((id: string) => api(`/api/chat/threads/${id}`, { method: 'DELETE' }), {
    invalidate: [['threads']], onSuccess: (_r, id) => { if (id === threadId) nav('/chat'); toast.ok('Chat deleted'); },
  });

  const groups = useMemo(() => {
    const pinned = threads.filter((t) => t.pinned);
    const rest = threads.filter((t) => !t.pinned);
    const out: { label: string; items: Thread[] }[] = [];
    if (pinned.length) out.push({ label: 'Pinned', items: pinned });
    for (const t of rest) {
      const b = bucket(t.updated_at);
      let g = out.find((x) => x.label === b);
      if (!g) { g = { label: b, items: [] }; out.push(g); }
      g.items.push(t);
    }
    return out;
  }, [threads]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pb-2">
        <button onClick={() => nav('/chat')} className="flex w-full items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90">
          <MessageSquarePlus className="size-4" />New chat
        </button>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats"
            className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2 text-xs placeholder:text-muted focus:border-accent focus:outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && <div className="flex justify-center py-4"><Spinner /></div>}
        {!isLoading && threads.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted">{q ? 'No chats match.' : 'No chats yet. Start one above.'}</p>}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.label}</div>
            {g.items.map((t) => (
              <div key={t.id} className="group relative">
                {renaming === t.id ? (
                  <input autoFocus defaultValue={t.title} aria-label="Rename chat"
                    onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== t.title) patch.mutate({ id: t.id, body: { title: v } }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }}
                    className="my-0.5 h-8 w-full rounded-md border border-accent bg-surface px-2 text-sm focus:outline-none" />
                ) : (
                  <NavLink to={`/chat/${t.id}`} className={({ isActive }) => cn('flex items-center gap-2 rounded-md px-2 py-1.5 pr-8 text-sm', isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
                    {t.busy ? <Spinner className="size-3" /> : t.pinned ? <Pin className="size-3 text-accent" /> : <Bot className="size-3 opacity-60" />}
                    <span className="truncate">{t.title}</span>
                  </NavLink>
                )}
                <button aria-label="Chat actions" onClick={() => setMenu(menu === t.id ? null : t.id)} className="invisible absolute right-1 top-1.5 rounded p-1 text-muted hover:bg-border group-hover:visible">
                  <MoreHorizontal className="size-3.5" />
                </button>
                {menu === t.id && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                    <div className="fade-in absolute right-1 top-8 z-40 w-44 rounded-lg border border-border bg-surface p-1 text-sm shadow-xl">
                      {[
                        { icon: Pencil, label: 'Rename', run: () => setRenaming(t.id) },
                        { icon: t.pinned ? PinOff : Pin, label: t.pinned ? 'Unpin' : 'Pin', run: () => patch.mutate({ id: t.id, body: { pinned: !t.pinned } }) },
                        { icon: t.archived ? ArchiveRestore : Archive, label: t.archived ? 'Restore' : 'Archive', run: () => patch.mutate({ id: t.id, body: { archived: !t.archived } }) },
                        { icon: Download, label: 'Export Markdown', run: () => window.open(`/api/chat/threads/${t.id}/export?format=md`) },
                        { icon: Trash2, label: 'Delete', run: () => del.mutate(t.id), danger: true },
                      ].map((a) => (
                        <button key={a.label} onClick={() => { setMenu(null); a.run(); }} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2', a.danger && 'text-danger')}>
                          <a.icon className="size-3.5" />{a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        <button onClick={() => setShowArchived((v) => !v)} className="mt-1 w-full px-2 py-1 text-left text-[11px] text-muted hover:text-fg">
          {showArchived ? '← Back to active chats' : 'Show archived'}
        </button>
      </div>
    </div>
  );
}

