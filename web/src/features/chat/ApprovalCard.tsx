import { useEffect, useState } from 'react';
import { ShieldAlert, Terminal } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { Button, toast } from '@/components/ui';
import type { PendingApproval } from './useChatStream';

export const summarizeArgs = (args: unknown): string => {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  const o = args as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'path', 'file', 'filePath', 'url', 'query', 'pattern']) if (typeof o[k] === 'string') return o[k] as string;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
};

export function ApprovalCard({ a, hasProject }: { a: PendingApproval; hasProject: boolean }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(Math.max(0, Math.round(a.timeoutSec - (Date.now() - a.requestedAt) / 1000)));
  useEffect(() => { const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(t); }, []);
  const decide = async (allow: boolean, scope: 'once' | 'chat' | 'project' = 'once') => {
    setBusy(true);
    try { await api(`/api/approvals/${a.approvalId}`, { method: 'POST', body: { allow, scope } }); }
    catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  return (
    <div className="fade-in rounded-xl border border-warn/40 bg-warn/5 p-3.5" role="alertdialog" aria-label="Approval required">
      <div className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className="size-4 text-warn" />Permission needed: <span className="font-mono text-xs">{a.tool}</span>
        <span className="ml-auto text-xs font-normal text-muted">auto-deny in {left}s</span></div>
      <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-xs"><Terminal className="mr-1.5 mb-0.5 inline size-3 text-muted" />{summarizeArgs(a.args)}</pre>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide(true, 'once')}>Allow once</Button>
        <Button size="sm" disabled={busy} onClick={() => decide(true, 'chat')}>Allow for this chat</Button>
        {hasProject && <Button size="sm" disabled={busy} onClick={() => decide(true, 'project')}>Allow for project</Button>}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => decide(false)}>Deny</Button>
      </div>
    </div>
  );
}
