import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Gauge, History, MessageSquarePlus, Moon, PlayCircle, PlugZap, ScrollText, Settings, Users } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useThreads } from '@/lib/queries';
import { cn } from './ui';

interface Cmd { id: string; label: string; hint?: string; icon: typeof Gauge; run: () => void }

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, toggleTheme } = useApp();
  const nav = useNavigate();
  const { data: threads = [] } = useThreads();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(!useApp.getState().paletteOpen); }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setPaletteOpen]);
  useEffect(() => { if (paletteOpen) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [paletteOpen]);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => nav(to);
    return [
      { id: 'new', label: 'New chat', icon: MessageSquarePlus, run: go('/chat') },
      { id: 'agents', label: 'Agents', hint: 'Execution', icon: Users, run: go('/agents') },
      { id: 'new-agent', label: 'Create agent', hint: 'Execution', icon: Users, run: go('/agents/new') },
      { id: 'runs', label: 'Runs', hint: 'Execution', icon: History, run: go('/runs') },
      { id: 'new-run', label: 'New run', hint: 'Execution', icon: PlayCircle, run: go('/runs/new') },
      { id: 'dash', label: 'Dashboard', hint: 'Operations', icon: Gauge, run: go('/dashboard') },
      { id: 'mcp', label: 'MCP registry', hint: 'Operations', icon: PlugZap, run: go('/mcp') },
      { id: 'audit', label: 'Audit & logs', hint: 'Operations', icon: ScrollText, run: go('/audit') },
      { id: 'docs', label: 'API docs', hint: 'Operations', icon: BookOpen, run: go('/docs') },
      { id: 'settings', label: 'Settings', icon: Settings, run: go('/settings') },
      { id: 'theme', label: 'Toggle light / dark theme', icon: Moon, run: toggleTheme },
      ...threads.slice(0, 30).map((t) => ({ id: `t-${t.id}`, label: t.title, hint: 'Chat', icon: MessageSquarePlus, run: go(`/chat/${t.id}`) })),
    ];
  }, [nav, threads, toggleTheme]);
  const shown = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  if (!paletteOpen) return null;
  const exec = (c?: Cmd) => { if (!c) return; setPaletteOpen(false); c.run(); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" role="dialog" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/50" onClick={() => setPaletteOpen(false)} />
      <div className="fade-in relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="Type a command or search chats…" aria-label="Command"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') exec(shown[sel]);
          }}
          className="h-12 w-full border-b border-border bg-transparent px-4 text-sm focus:outline-none" />
        <div className="max-h-80 overflow-y-auto p-1">
          {shown.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">No results</div>}
          {shown.map((c, i) => (
            <button key={c.id} onMouseEnter={() => setSel(i)} onClick={() => exec(c)} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm', i === sel && 'bg-surface-2')}>
              <c.icon className="size-4 text-muted" /><span className="flex-1 truncate">{c.label}</span>{c.hint && <span className="text-xs text-muted">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
