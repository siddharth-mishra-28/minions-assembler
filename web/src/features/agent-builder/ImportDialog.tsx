import { useRef, useState } from 'react';
import { FileUp, FolderSearch, FileText } from 'lucide-react';
import { Badge, Button, Field, Input, Modal, Spinner, Tabs, Textarea } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useProjects, useProviders } from '@/lib/queries';
import { useApp } from '@/lib/store';
import type { Provider } from '@/lib/types';
import { useInstructionFiles } from './hooks';
import { Callout, monoArea } from './ui-bits';
import { type Def } from './model';

type Tab = 'markdown' | 'json' | 'folder';

/** Imported .agent.md definitions hard-wire a demo provider and put the body in task.prompt; map them onto a configured provider and the persona. */
export function adaptImported(def: Def, providers: Provider[] | undefined, moveTask = true): Def {
  const d: Def = { ...def };
  const p = providers?.find((x) => x.isDefault) ?? providers?.[0];
  if (p) d.provider = { providerRef: p.id, model: p.defaultModel || def.provider?.model || '' };
  const body = def.task?.prompt;
  if (moveTask && body && !def.persona?.systemMessage?.content) {
    d.persona = { ...(def.persona ?? {}), useCopilotDefaultPrompt: true, systemMessage: { mode: 'append', content: body } };
    d.task = undefined;
  }
  return d;
}

export default function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (def: Def) => void }) {
  const providers = useProviders();
  const projects = useProjects();
  const projectId = useApp((s) => s.projectId);
  const [tab, setTab] = useState<Tab>('markdown');
  const [md, setMd] = useState('');
  const [json, setJson] = useState('');
  const [folder, setFolder] = useState('');
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const defaultFolder = projects.data?.find((p) => p.id === projectId)?.path ?? '';
  const dir = folder || defaultFolder;
  const files = useInstructionFiles(dir, scan || (!!defaultFolder && tab === 'folder'));

  const finish = (def: Def, adapt = true) => { onImported(adapt ? adaptImported(def, providers.data) : def); onClose(); };

  const run = async (fn: () => Promise<Def>) => {
    setBusy(true); setErr(null);
    try { finish(await fn()); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const importMarkdown = (markdown: string) => run(async () => (await api<{ definition: Def }>('/api/agents/import', { method: 'POST', body: { markdown, register: false } })).definition);
  const importPath = (path: string) => run(async () => (await api<{ definition: Def }>('/api/agents/import', { method: 'POST', body: { path, register: false } })).definition);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    if (/\.json$/i.test(f.name)) { setTab('json'); setJson(text); } else { setTab('markdown'); setMd(text); }
  };

  const importJson = () => {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      finish(parsed as Def, false);
    } catch (e) { setErr(`Invalid JSON: ${errMsg(e)}`); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import an agent" width="max-w-2xl"
      footer={tab === 'markdown' ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!md.trim()} onClick={() => importMarkdown(md)}>Import</Button></>
        : tab === 'json' ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!json.trim()} onClick={importJson}>Open in builder</Button></>
        : <Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Tabs<Tab> value={tab} onChange={(t) => { setTab(t); setErr(null); }} items={[{ id: 'markdown', label: '.agent.md' }, { id: 'json', label: 'JSON' }, { id: 'folder', label: 'From folder' }]} />
          <input ref={fileRef} type="file" accept=".md,.json,.markdown,text/markdown,application/json" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Button size="sm" onClick={() => fileRef.current?.click()}><FileUp className="size-3.5" />Upload file</Button>
        </div>
        <p className="text-xs text-muted">Imported agents open in the builder so you can review the provider, tools and permissions before publishing. Nothing is saved yet.</p>
        {tab === 'markdown' && (
          <Field label="Agent profile (Markdown with YAML front matter)" hint="Compatible with GitHub Copilot custom agent .agent.md files.">
            <Textarea rows={12} className={monoArea} value={md} onChange={(e) => setMd(e.target.value)} placeholder={'---\nname: reviewer\ndescription: Reviews code\ntools: [view, grep]\n---\nYou are a careful reviewer…'} />
          </Field>
        )}
        {tab === 'json' && (
          <Field label="Agent definition JSON"><Textarea rows={12} className={monoArea} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{ "schemaVersion": "1.0", "metadata": { "name": "…" }, … }' /></Field>
        )}
        {tab === 'folder' && (
          <div className="space-y-3">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setScan(true); }}>
              <Input aria-label="Folder to scan" className="font-mono text-xs" value={folder} onChange={(e) => { setFolder(e.target.value); setScan(false); }} placeholder={defaultFolder || 'Path to a project folder'} />
              <Button type="submit" disabled={!dir}><FolderSearch className="size-4" />Scan</Button>
            </form>
            {files.isFetching && <Spinner />}
            {files.isError && <Callout tone="danger">{errMsg(files.error)}</Callout>}
            {files.data?.length === 0 && <p className="text-sm text-muted">No instruction files or agent profiles found in this folder.</p>}
            <div className="space-y-1.5">
              {files.data?.map((f) => (
                <div key={f.path} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                  <FileText className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs" title={f.path}>{f.path}</div>
                    {f.preview && <div className="line-clamp-1 text-xs text-muted">{f.preview}</div>}
                  </div>
                  <Badge>{f.kind}</Badge>
                  {f.kind === 'agent-profile' && <Button size="sm" disabled={busy} onClick={() => importPath(f.path)}>Import</Button>}
                </div>
              ))}
            </div>
          </div>
        )}
        {err && <Callout tone="danger">{err}</Callout>}
      </div>
    </Modal>
  );
}
