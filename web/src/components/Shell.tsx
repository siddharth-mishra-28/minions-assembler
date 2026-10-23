import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BookOpen, Command, Gauge, History, LayoutDashboard, Moon, PlayCircle, PlugZap, ScrollText, Settings, Sun, Users } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useBootstrap } from '@/lib/queries';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ThreadList } from './ThreadList';
import { CommandPalette } from './CommandPalette';
import { Toaster, cn } from './ui';

const section = 'px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted';
function Item({ to, icon: Icon, label, end }: { to: string; icon: typeof Gauge; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn('mx-2 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm', isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
      <Icon className="size-4" />{label}
    </NavLink>
  );
}

export function Shell() {
  const { theme, toggleTheme, setPaletteOpen } = useApp();
  const { data: boot } = useBootstrap();
  const nav = useNavigate();
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <button onClick={() => nav('/chat')} className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-base text-accent-fg">M</span>Minions
          </button>
          <button onClick={() => setPaletteOpen(true)} className="ml-auto flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-fg" aria-label="Command palette">
            <Command className="size-3" />K
          </button>
        </div>
        <div className="px-3 pb-2"><ProjectSwitcher /></div>

        <div className={section}>Chat</div>
        <ThreadList />

        <div className="border-t border-border pb-1">
          <div className={section}>Execution</div>
          <Item to="/agents" icon={Users} label="Agents" />
          <Item to="/runs" icon={History} label="Runs" />
          <Item to="/runs/new" icon={PlayCircle} label="New run" />
          <div className={section}>Operations</div>
          <Item to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
          <Item to="/mcp" icon={PlugZap} label="MCP registry" />
          <Item to="/audit" icon={ScrollText} label="Audit & logs" />
          <Item to="/docs" icon={BookOpen} label="API docs" />
        </div>
        <div className="flex items-center gap-1 border-t border-border px-2 py-2">
          <NavLink to="/settings" className={({ isActive }) => cn('flex flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm', isActive ? 'bg-surface-2' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
            <Settings className="size-4" />Settings
          </NavLink>
          <span className="text-[10px] text-muted">v{boot?.version}</span>
          <button onClick={toggleTheme} aria-label="Toggle theme" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden"><Outlet /></main>
      <CommandPalette />
      <Toaster />
    </div>
  );
}
