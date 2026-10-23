import { useNavigate } from 'react-router-dom';
import { ShieldCheck, FolderOpen, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import { ProviderForm } from '@/features/providers/ProviderForm';
import { Button, Card } from '@/components/ui';

export default function Onboarding() {
  const nav = useNavigate();
  const done = useApiMutation(() => api('/api/settings', { method: 'PATCH', body: { onboarding: { completed: true } } }), { invalidate: [qk.bootstrap, qk.settings] });
  return (
    <div className="flex min-h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent text-xl font-bold text-accent-fg">M</span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to Minions</h1>
          <p className="mt-1 text-sm text-muted">Connect a model provider to start chatting with the Copilot agent in any project folder.</p>
        </div>
        <Card className="p-6"><ProviderForm firstRun submitLabel="Save and continue" onSaved={() => { done.mutate(undefined); nav('/chat'); }} /></Card>
        <div className="grid grid-cols-3 gap-3 text-xs text-muted">
          {[{ i: FolderOpen, t: 'Open any folder as a project' }, { i: Users, t: 'Create custom agents for chat' }, { i: ShieldCheck, t: 'Approve tools, audit everything' }].map((x) => (
            <div key={x.t} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"><x.i className="size-4 text-accent" />{x.t}</div>
          ))}
        </div>
        <div className="text-center"><Button variant="ghost" size="sm" onClick={() => done.mutate(undefined)}>Skip for now</Button></div>
      </div>
    </div>
  );
}
