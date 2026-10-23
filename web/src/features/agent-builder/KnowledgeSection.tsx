import { useState } from 'react';
import { FileText, FolderOpen, Plus, ScanSearch, Trash2 } from 'lucide-react';
import { Badge, Button, Field, IconButton, Input, Spinner, Textarea, Toggle } from '@/components/ui';
import { errMsg } from '@/lib/api';
import { useProjects } from '@/lib/queries';
import { useApp } from '@/lib/store';
import { useBuilder, useField } from './context';
import DirPicker from './DirPicker';
import { useInstructionFiles } from './hooks';
import { Callout, ChipInput, Group, SectionCard, SectionTitle, monoArea } from './ui-bits';

export default function KnowledgeSection() {
  const { def, set } = useBuilder();
  const projects = useProjects();
  const projectId = useApp((s) => s.projectId);
  const project = projects.data?.find((p) => p.id === projectId);
  const [picking, setPicking] = useState<'workdir' | 'extra' | null>(null);
  const [scan, setScan] = useState(false);
  const workdir = useField<string>('knowledge.workingDirectory', '');
  const extra = useField<string[]>('knowledge.additionalDirectories', []);
  const global = (def.instructions?.global ?? []) as string[];
  const scoped = (def.instructions?.scoped ?? []) as { applyTo: string; body: string }[];
  const mdPaths = (def.instructions?.agentsMdPaths ?? []) as string[];
  const files = useInstructionFiles(workdir.value, scan);

  return (
    <div className="space-y-5">
      <SectionTitle title="Knowledge & instructions" description="Point the agent at a folder and give it project guidance. All optional." />
      <SectionCard title="Working folder" description="Chat and run sessions start in the active project. Set a folder only to pin this agent to a fixed location.">
        <Field label="Working directory" error={workdir.error} hint={project ? `When empty, the agent uses the current project (${project.path}).` : 'When empty, the agent uses the current project or a private scratch folder.'}>
          <div className="flex gap-2">
            <Input className="font-mono text-xs" value={workdir.value} onChange={(e) => workdir.set(e.target.value)} placeholder="C:\\work\\my-repo" />
            <Button type="button" onClick={() => setPicking('workdir')}><FolderOpen className="size-4" />Browse</Button>
          </div>
        </Field>
        <Group label="Additional directories" hint="Extra folders the agent may read and write.">
          <ChipInput label="Additional directories" value={extra.value ?? []} onChange={(v) => extra.set(v)} placeholder="Add a folder path" />
          <Button size="sm" type="button" onClick={() => setPicking('extra')}><Plus className="size-3.5" />Browse…</Button>
        </Group>
        <Toggle checked={!!def.knowledge?.sessionStore} onChange={(v) => set('knowledge.sessionStore', v ? true : undefined)} label="Cross-session store" description="Let the agent remember things across sessions." />
      </SectionCard>

      <SectionCard title="Project instruction files" description="AGENTS.md, CLAUDE.md, copilot-instructions.md and agent profiles found in the working folder."
        right={<Button size="sm" type="button" onClick={() => setScan(true)} disabled={!workdir.value}><ScanSearch className="size-3.5" />Scan folder</Button>}>
        {!workdir.value && <p className="text-xs text-muted">Set a working directory above to scan for instruction files.</p>}
        {scan && files.isLoading && <Spinner />}
        {files.isError && <Callout tone="danger">{errMsg(files.error)}</Callout>}
        {files.data?.length === 0 && <p className="text-xs text-muted">No instruction files found.</p>}
        <div className="space-y-1.5">
          {files.data?.map((f) => {
            const on = mdPaths.includes(f.path);
            return (
              <label key={f.path} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5 hover:bg-surface-2">
                <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={on}
                  onChange={(e) => set('instructions.agentsMdPaths', e.target.checked ? [...mdPaths, f.path] : mdPaths.filter((p) => p !== f.path))} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><FileText className="size-3.5 text-muted" /><span className="truncate font-mono text-xs">{f.path}</span><Badge>{f.kind}</Badge></span>
                  {f.preview && <span className="mt-1 line-clamp-2 block text-xs text-muted">{f.preview}</span>}
                </span>
              </label>
            );
          })}
        </div>
        <Group label="Included instruction file paths" hint="These files are injected into the agent's context.">
          <ChipInput label="Instruction file paths" value={mdPaths} onChange={(v) => set('instructions.agentsMdPaths', v)} placeholder="AGENTS.md" />
        </Group>
        <Toggle checked={!!def.instructions?.refreshDiscoveryCache} onChange={(v) => set('instructions.refreshDiscoveryCache', v ? true : undefined)} label="Refresh instruction discovery cache" description="Re-scan for instruction files on every session." />
      </SectionCard>

      <SectionCard title="Custom instructions" description="Extra guidance added to every session."
        right={<Button size="sm" type="button" onClick={() => set('instructions.global', [...global, ''])}><Plus className="size-3.5" />Add</Button>}>
        {global.length === 0 && <p className="text-xs text-muted">No global instructions. Use Add to write rules that always apply.</p>}
        {global.map((g, i) => (
          <div key={i} className="flex items-start gap-2">
            <Textarea rows={3} aria-label={`Global instruction ${i + 1}`} className={monoArea} value={g} onChange={(e) => set(`instructions.global.${i}`, e.target.value)} placeholder="Always write unit tests for new functions." />
            <IconButton label="Remove instruction" type="button" onClick={() => set('instructions.global', global.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <div className="text-xs font-medium text-muted">Scoped instructions (by file pattern)</div>
          <Button size="sm" type="button" onClick={() => set('instructions.scoped', [...scoped, { applyTo: '', body: '' }])}><Plus className="size-3.5" />Add</Button>
        </div>
        {scoped.map((s, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Input aria-label="Applies to" value={s.applyTo} onChange={(e) => set(`instructions.scoped.${i}.applyTo`, e.target.value)} placeholder="**/*.ts" className="font-mono text-xs" />
              <IconButton label="Remove scoped instruction" type="button" onClick={() => set('instructions.scoped', scoped.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
            <Textarea rows={3} aria-label="Scoped instruction body" className={monoArea} value={s.body} onChange={(e) => set(`instructions.scoped.${i}.body`, e.target.value)} placeholder="Use strict TypeScript; avoid any." />
          </div>
        ))}
      </SectionCard>

      <DirPicker open={picking !== null} onClose={() => setPicking(null)} title={picking === 'extra' ? 'Add an additional folder' : 'Choose the working directory'} start={workdir.value || project?.path}
        onPick={(p) => picking === 'extra' ? extra.set([...(extra.value ?? []), p]) : workdir.set(p)} />
    </div>
  );
}
