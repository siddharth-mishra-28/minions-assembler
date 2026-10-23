import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, FileJson, FlaskConical, Rocket, Save, Upload } from 'lucide-react';
import { Badge, Button, EmptyState, Select, Spinner, Tabs, cn, toast } from '@/components/ui';
import { ApiError, api, errMsg } from '@/lib/api';
import { useProviders } from '@/lib/queries';
import { BuilderContext, type BuilderCtx } from '@/features/agent-builder/context';
import { useAgentRows } from '@/features/agent-builder/hooks';
import { agentIdOf, emptyDefinition, normalize, parseIssues, setIn, SECTION_META, type Def, type Issue, type SectionId } from '@/features/agent-builder/model';
import IdentitySection from '@/features/agent-builder/IdentitySection';
import ProviderSection from '@/features/agent-builder/ProviderSection';
import PersonaSection from '@/features/agent-builder/PersonaSection';
import ToolsSection from '@/features/agent-builder/ToolsSection';
import KnowledgeSection from '@/features/agent-builder/KnowledgeSection';
import PermissionsSection from '@/features/agent-builder/PermissionsSection';
import AdvancedSection from '@/features/agent-builder/AdvancedSection';
import ReviewSection, { type Published, type Validation } from '@/features/agent-builder/ReviewSection';
import JsonEditor from '@/features/agent-builder/JsonEditor';
import { adaptImported } from '@/features/agent-builder/ImportDialog';

type ViewMode = 'guided' | 'json';

const loadAgent = async (id: string): Promise<{ def: Def; status?: string }> => {
  const r = await api<{ definition: Def | string; status?: string }>(`/api/agents/${encodeURIComponent(id)}`);
  return { def: typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition, status: r.status };
};

export default function AgentBuilder() {
  const { id: editId } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const from = search.get('from');
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const drafts = useAgentRows('drafts');
  const fileRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const stateDef = (location.state as { definition?: Def } | null)?.definition;
  const [def, setDefState] = useState<Def>(() => stateDef ?? emptyDefinition());
  const [ready, setReady] = useState(!editId && !from);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [origId, setOrigId] = useState<string | null>(editId ?? null);
  const [origStatus, setOrigStatus] = useState<string | undefined>();
  // Imported/duplicated definitions are unsaved from the start, so their baseline never matches.
  const [baseline, setBaseline] = useState(() => (stateDef ? '' : JSON.stringify(emptyDefinition())));
  const [view, setView] = useState<ViewMode>('guided');
  const [section, setSection] = useState<SectionId>('identity');
  const [visited, setVisited] = useState<Set<SectionId>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [validation, setValidation] = useState<Validation>({ status: 'idle', issues: [], warnings: [] });
  const [publishing, setPublishing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [published, setPublished] = useState<Published | null>(null);

  /* ---------- load (edit / duplicate) ---------- */
  useEffect(() => {
    const src = editId ?? from;
    if (!src) return;
    let alive = true;
    setReady(false); setLoadError(null);
    loadAgent(src).then(({ def: d, status }) => {
      if (!alive) return;
      const next = editId ? d : { ...d, metadata: { ...d.metadata, name: `${d.metadata?.name ?? 'agent'}-copy` } };
      setDefState(next);
      setBaseline(editId ? JSON.stringify(next) : '');
      setOrigId(editId ?? null);
      setOrigStatus(editId ? status : undefined);
      setReady(true);
    }).catch((e) => { if (alive) setLoadError(errMsg(e)); });
    return () => { alive = false; };
  }, [editId, from]);

  const setDef = useCallback((fn: (d: Def) => Def) => { setDefState(fn); setPublished(null); }, []);
  const set = useCallback((path: string, value: unknown) => setDef((d) => setIn(d, path, value)), [setDef]);
  const normalized = useMemo(() => normalize(def), [def]);
  const normKey = JSON.stringify(normalized);
  const dirty = JSON.stringify(def) !== baseline;

  /* preselect the default provider on a fresh agent */
  useEffect(() => {
    const list = providers.data;
    if (!list?.length || editId || from || stateDef) return;
    if (def.provider?.providerRef !== '' || def.provider?.model) return;
    const p = list.find((x) => x.isDefault) ?? list[0];
    const next = { ...def, provider: { providerRef: p.id, model: p.defaultModel ?? '' } };
    if (!dirty) setBaseline(JSON.stringify(next));
    setDefState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data]);

  /* ---------- live validation ---------- */
  const seq = useRef(0);
  const runValidate = useCallback(async (body: Def): Promise<Validation> => {
    try {
      const r = await api<{ valid: boolean; warnings?: string[] }>('/api/agents/validate', { method: 'POST', body: { definition: body } });
      return { status: 'valid', issues: [], warnings: r.warnings ?? [] };
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return { status: 'invalid', issues: parseIssues(e.message), warnings: [] };
      const issue: Issue = { path: '/', message: errMsg(e), section: 'review' };
      return { status: 'invalid', issues: [issue], warnings: [] };
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const my = ++seq.current;
    setValidation((v) => ({ ...v, status: 'checking' }));
    const t = setTimeout(async () => {
      const r = await runValidate(JSON.parse(normKey));
      if (my === seq.current) setValidation(r);
    }, 500);
    return () => clearTimeout(t);
  }, [normKey, ready, runValidate]);

  /* ---------- unsaved-changes guard (BrowserRouter has no blocker API) ---------- */
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('target') || !(a.getAttribute('href') ?? '').startsWith('/')) return;
      if (!window.confirm('You have unsaved changes. Leave without saving?')) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', before);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('click', click, true); };
  }, [dirty]);

  /* ---------- navigation ---------- */
  const goto = (s: SectionId) => {
    setVisited((v) => new Set(v).add(section));
    setSection(s);
    setView('guided');
    contentRef.current?.scrollTo({ top: 0 });
  };
  const idx = SECTION_META.findIndex((s) => s.id === section);
  const issuesBySection = useMemo(() => {
    const m = new Map<SectionId, number>();
    for (const i of validation.issues) m.set(i.section, (m.get(i.section) ?? 0) + 1);
    return m;
  }, [validation.issues]);

  /* ---------- persistence ---------- */
  const invalidateAgents = () => {
    for (const k of ['agent-rows', 'agents-list', 'agent-detail', 'chat-agents']) qc.invalidateQueries({ queryKey: [k] });
  };

  const afterSave = (id: string, status: 'published' | 'draft', note?: string) => {
    setBaseline(JSON.stringify(def));
    setOrigId(id);
    setOrigStatus(status);
    setPublished({ id, draft: status === 'draft', note });
    invalidateAgents();
    toast.ok(status === 'draft' ? `Draft “${id}” saved` : `Published “${id}”`);
    setSection('review'); setView('guided');
  };

  const isUpdate = !!origId && origStatus === 'published' && origId === agentIdOf(normalized);
  const canDraft = !origId || origStatus === 'draft' || origId !== agentIdOf(normalized);

  const publish = async () => {
    setAttempted(true);
    setPublishing(true);
    try {
      const body = JSON.parse(normKey) as Def;
      const check = await runValidate(body);
      setValidation(check);
      if (check.status === 'invalid') {
        toast.error('Fix the highlighted problems before publishing.');
        setSection(check.issues.length === 1 ? check.issues[0].section : 'review'); setView('guided');
        return;
      }
      const newId = agentIdOf(body);
      let note: string | undefined;
      if (isUpdate) {
        await api(`/api/agents/${encodeURIComponent(origId!)}`, { method: 'PUT', body: { definition: body } });
      } else {
        await api('/api/agents', { method: 'POST', body: { definition: body } });
        if (origId && origId !== newId && origStatus === 'published') note = `Saved as a new agent. “${origId}” was left unchanged.`;
      }
      afterSave(newId, 'published', note);
    } catch (e) {
      const m = errMsg(e);
      if (e instanceof ApiError && e.status === 400) { setValidation({ status: 'invalid', issues: parseIssues(m), warnings: [] }); setSection('review'); }
      toast.error(m);
    } finally { setPublishing(false); }
  };

  const saveDraft = async () => {
    setDrafting(true);
    try {
      const r = await api<{ id: string }>('/api/agents/draft', { method: 'POST', body: { definition: JSON.parse(normKey) } });
      afterSave(r.id, 'draft', 'Drafts are not available in chat or runs until published.');
    } catch (e) { toast.error(errMsg(e)); } finally { setDrafting(false); }
  };

  /* ---------- templates / upload / drafts ---------- */
  const replaceDef = (d: Def, msg: string) => { setDefState(d); setPublished(null); setAttempted(false); toast.ok(msg); };

  const loadExample = async () => {
    if (dirty && !window.confirm('Replace the current form with the example template?')) return;
    try {
      const d = await api<Def>('/api/templates/default');
      replaceDef(adaptImported(d, providers.data, false), 'Example template loaded');
    } catch (e) { toast.error(errMsg(e)); }
  };

  const onUpload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      const r = await api<{ definition?: Def }>('/api/templates/upload', { method: 'POST', body: parsed }).catch(() => null);
      replaceDef(r?.definition ?? parsed, `Loaded ${f.name}`);
    } catch (e) { toast.error(`Could not read JSON: ${errMsg(e)}`); }
  };

  const openDraft = (draftId: string) => {
    if (!draftId) return;
    if (dirty && !window.confirm('Discard unsaved changes and open this draft?')) return;
    setBaseline(JSON.stringify(def));
    navigate(`/agents/${encodeURIComponent(draftId)}/edit`);
  };

  /* ---------- render ---------- */
  const ctx: BuilderCtx = { def, setDef, set, issues: validation.issues, isEdit: !!origId, showErrors: attempted || visited.has(section) || section === 'review' };

  if (loadError) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState icon={<CircleAlert className="size-5" />} title="Could not load this agent" description={loadError}
          action={<Button onClick={() => navigate('/agents')}><ArrowLeft className="size-4" />Back to agents</Button>} />
      </div>
    );
  }
  if (!ready) return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;

  const status = validation.status;
  const title = origId ? `Edit ${origId}` : from ? 'Duplicate agent' : 'New agent';
  const publishLabel = isUpdate ? 'Save changes' : 'Publish';
  const body = {
    identity: <IdentitySection />, provider: <ProviderSection />, persona: <PersonaSection />, tools: <ToolsSection />,
    knowledge: <KnowledgeSection />, permissions: <PermissionsSection />, advanced: <AdvancedSection />,
    review: <ReviewSection def={def} normalized={normalized} validation={validation} onGoto={goto} onPublish={publish} onDraft={canDraft ? saveDraft : undefined}
      publishing={publishing} drafting={drafting} published={published} publishLabel={isUpdate ? 'Save changes' : 'Publish agent'} />,
  }[section];

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate('/agents')} aria-label="Back to agents"><ArrowLeft className="size-4" />Agents</Button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight">{title}{dirty && <span className="ml-2 align-middle text-xs font-normal text-warn">● unsaved</span>}</h1>
              <p className="truncate text-xs text-muted">Published agents appear in the chat agent picker.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs<ViewMode> value={view} onChange={setView} items={[{ id: 'guided', label: 'Guided' }, { id: 'json', label: 'JSON' }]} />
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void onUpload(e.target.files?.[0]); e.target.value = ''; }} />
            <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="size-3.5" />Upload JSON</Button>
            <Button size="sm" onClick={loadExample}><FlaskConical className="size-3.5" />Example</Button>
            {(drafts.data?.length ?? 0) > 0 && (
              <Select aria-label="Open a draft" className="h-7 w-36 text-xs" value="" onChange={(e) => openDraft(e.target.value)}>
                <option value="">Drafts ({drafts.data!.length})</option>
                {drafts.data!.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
              </Select>
            )}
            <span className="hidden items-center text-xs sm:inline-flex" aria-live="polite">
              {status === 'checking' ? <Spinner /> : status === 'valid' ? <Badge tone="ok"><CircleCheck className="size-3" />Valid</Badge> : status === 'invalid' ? <Badge tone="danger">{validation.issues.length} issue{validation.issues.length === 1 ? '' : 's'}</Badge> : null}
            </span>
            {canDraft && <Button size="sm" onClick={saveDraft} loading={drafting}><Save className="size-3.5" />Save draft</Button>}
            <Button size="sm" variant="primary" onClick={publish} loading={publishing}><Rocket className="size-3.5" />{publishLabel}</Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {view === 'guided' && (
            <nav aria-label="Builder sections" className="shrink-0 overflow-x-auto border-b border-border p-2 md:w-60 md:overflow-y-auto md:border-b-0 md:border-r md:p-3">
              <ol className="flex gap-1 md:flex-col">
                {SECTION_META.map((s, i) => {
                  const count = issuesBySection.get(s.id) ?? 0;
                  const show = attempted || visited.has(s.id);
                  const bad = show && count > 0;
                  const good = show && status === 'valid' && s.id !== 'review';
                  const active = s.id === section;
                  return (
                    <li key={s.id} className="shrink-0">
                      <button type="button" aria-current={active ? 'step' : undefined} onClick={() => goto(s.id)}
                        className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent', active ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', bad ? 'bg-danger/15 text-danger' : good ? 'bg-ok/15 text-ok' : active ? 'bg-accent text-accent-fg' : 'bg-surface-2')}>
                          {bad ? '!' : good ? <CircleCheck className="size-3.5" /> : i + 1}
                        </span>
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{s.label}</span><span className="hidden truncate text-[11px] text-muted md:block">{s.hint}</span></span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
          <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6">
              {view === 'json' ? (
                <>
                  <div className="mb-4 flex items-center gap-2 text-base font-semibold"><FileJson className="size-5 text-accent" />Raw definition</div>
                  <JsonEditor def={def} onChange={(d) => { setDefState(d); setPublished(null); }} />
                  {validation.issues.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs text-danger" aria-label="Validation issues">
                      {validation.issues.map((i, k) => <li key={k}>{i.path || '/'} — {i.message}</li>)}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  {body}
                  <div className="mt-8 flex items-center justify-between border-t border-border pt-4">
                    <Button disabled={idx === 0} onClick={() => goto(SECTION_META[idx - 1].id)}><ArrowLeft className="size-4" />Back</Button>
                    {idx < SECTION_META.length - 1 && <Button variant="primary" onClick={() => goto(SECTION_META[idx + 1].id)}>Next: {SECTION_META[idx + 1].label}<ArrowRight className="size-4" /></Button>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BuilderContext.Provider>
  );
}
