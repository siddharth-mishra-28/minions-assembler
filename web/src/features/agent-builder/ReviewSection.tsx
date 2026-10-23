import { Link } from 'react-router-dom';
import { CircleAlert, CircleCheck, MessageSquare, Play, Rocket, Save, TriangleAlert } from 'lucide-react';
import { Badge, Button, Spinner } from '@/components/ui';
import { Callout, SectionCard, SectionTitle } from './ui-bits';
import { SECTION_META, type Def, type Issue, type SectionId } from './model';
import { providerMode } from './ProviderSection';
import { useProviders } from '@/lib/queries';

export interface Validation {
  status: 'idle' | 'checking' | 'valid' | 'invalid';
  issues: Issue[];
  warnings: string[];
}

export interface Published { id: string; draft?: boolean; note?: string }

interface Props {
  def: Def;
  normalized: Def;
  validation: Validation;
  onGoto: (s: SectionId) => void;
  onPublish: () => void;
  onDraft?: () => void;
  publishing: boolean;
  drafting: boolean;
  published: Published | null;
  publishLabel: string;
}

export default function ReviewSection({ normalized, validation, onGoto, onPublish, onDraft, publishing, drafting, published, publishLabel }: Props) {
  const providers = useProviders();
  const n = normalized;
  const mode = providerMode(n.provider);
  const prov = mode === 'ref' ? (providers.data?.find((p) => p.id === n.provider?.providerRef || p.name === n.provider?.providerRef)?.name ?? n.provider?.providerRef ?? '—') : `${n.provider?.type ?? ''} · ${n.provider?.baseUrl ?? ''}`;
  const bySection = (s: SectionId) => validation.issues.filter((i) => i.section === s);
  const invalid = validation.status === 'invalid';
  const mcp = (n.mcp?.use ?? []) as unknown[];

  const rows: [string, string][] = [
    ['Agent id', `${n.metadata?.name ?? '—'}@${n.metadata?.version ?? '—'}`],
    ['Provider', prov],
    ['Model', n.provider?.model ?? '—'],
    ['System prompt', n.persona?.systemMessage?.content ? `${n.persona.systemMessage.mode ?? 'append'} · ${n.persona.systemMessage.content.length} chars` : 'Copilot default'],
    ['Default task', n.task?.prompt ? 'Set (for headless runs)' : 'None — chat agent'],
    ['Built-in tools', n.tools?.builtins?.all === false ? 'Selected only' : 'All'],
    ['MCP servers', mcp.length ? String(mcp.length) : 'None'],
    ['Working directory', n.knowledge?.workingDirectory ?? 'Current project'],
    ['Sub-agents', String(n.agents?.length ?? 0)],
  ];

  return (
    <div className="space-y-5">
      <SectionTitle title="Review & publish" description="Check the summary, fix anything flagged, then publish to make the agent available in chat and runs." />

      {published && (
        <div className="rounded-xl border border-ok/40 bg-ok/10 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-ok"><CircleCheck className="size-5" />{published.draft ? 'Draft saved' : 'Agent published'}: <code>{published.id}</code></div>
          {published.note && <p className="mt-1 text-xs text-muted">{published.note}</p>}
          {!published.draft && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link to={`/chat?agent=${encodeURIComponent(published.id)}`}><Button variant="primary"><MessageSquare className="size-4" />Chat with this agent</Button></Link>
              <Link to={`/runs/new?agent=${encodeURIComponent(published.id)}`}><Button><Play className="size-4" />Run it</Button></Link>
              <Link to="/agents"><Button variant="ghost">Back to agents</Button></Link>
            </div>
          )}
        </div>
      )}

      <SectionCard title="Validation" right={validation.status === 'checking' ? <Spinner /> : validation.status === 'valid' ? <Badge tone="ok">Valid</Badge> : invalid ? <Badge tone="danger">{validation.issues.length} issue{validation.issues.length === 1 ? '' : 's'}</Badge> : null}>
        {invalid && (
          <Callout tone="danger">
            <div className="mb-1.5 flex items-center gap-1.5 font-semibold"><CircleAlert className="size-4" />Fix these before publishing</div>
            <ul className="space-y-1">
              {validation.issues.map((i, k) => (
                <li key={k}><button type="button" className="text-left underline decoration-dotted" onClick={() => onGoto(i.section)}>
                  <b>{SECTION_META.find((s) => s.id === i.section)?.label}</b> · {i.path.replace(/^\//, '').replace(/\//g, '.') || 'definition'} — {i.message}</button></li>
              ))}
            </ul>
          </Callout>
        )}
        {validation.status === 'valid' && <Callout tone="ok">The definition passes schema validation.</Callout>}
        {validation.warnings.length > 0 && (
          <Callout tone="warn"><div className="mb-1 flex items-center gap-1.5 font-semibold"><TriangleAlert className="size-4" />Warnings</div><ul className="list-disc space-y-0.5 pl-4">{validation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Callout>
        )}
        <div className="grid gap-1.5 sm:grid-cols-2">
          {SECTION_META.filter((s) => s.id !== 'review').map((s) => {
            const c = bySection(s.id).length;
            return (
              <button key={s.id} type="button" onClick={() => onGoto(s.id)} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2">
                <span>{s.label}</span>
                {c ? <Badge tone="danger">{c} issue{c > 1 ? 's' : ''}</Badge> : validation.status === 'valid' ? <CircleCheck className="size-4 text-ok" /> : <span className="text-xs text-muted">—</span>}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Summary">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (<div key={k} className="min-w-0"><dt className="text-xs text-muted">{k}</dt><dd className="truncate" title={v}>{v}</dd></div>))}
        </dl>
      </SectionCard>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onPublish} loading={publishing} disabled={validation.status === 'checking'}><Rocket className="size-4" />{publishLabel}</Button>
        {onDraft && <Button onClick={onDraft} loading={drafting}><Save className="size-4" />Save as draft</Button>}
      </div>
    </div>
  );
}
