import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Input, Select, Textarea, Toggle } from '@/components/ui';
import { useBuilder, useField } from './context';
import { Callout, ChipInput, Group, SectionCard, SectionTitle, monoArea } from './ui-bits';
import { type Def } from './model';

type Sub = { name: string; prompt: string; displayName?: string; description?: string; model?: string; infer?: boolean; tools?: string[] | null; skills?: string[]; reasoningEffort?: string };

const num = (v: string): number | undefined => (v === '' ? undefined : Number(v));

export default function AdvancedSection() {
  const { def, set } = useBuilder();
  const subs = (def.agents ?? []) as Sub[];
  const rt = (def.runtime ?? {}) as Def;
  const fleet = useField<boolean>('fleet.enabled', false);
  const defaultAgent = useField<string>('defaultAgent', '');
  const dirs = useField<string[]>('skills.directories', []);
  const disabledSkills = useField<string[]>('skills.disabled', []);
  const maxWorkers = useField<number>('fleet.maxConcurrentWorkers');
  const fleetPrompt = useField<string>('fleet.prompt', '');
  const customTools = (def.tools?.custom ?? []) as unknown[];

  return (
    <div className="space-y-5">
      <SectionTitle title="Sub-agents, skills & runtime" description="Optional power features. Most agents can skip this step." />
      <SectionCard title="Sub-agents" description="Specialists the main agent can delegate to."
        right={<Button size="sm" type="button" onClick={() => set('agents', [...subs, { name: '', prompt: '' }])}><Plus className="size-3.5" />Add sub-agent</Button>}>
        {subs.length === 0 && <p className="text-xs text-muted">No sub-agents defined.</p>}
        {subs.map((s, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-start gap-2">
              <div className="grid flex-1 gap-3 sm:grid-cols-3">
                <Field label="Name *"><Input value={s.name} onChange={(e) => set(`agents.${i}.name`, e.target.value)} placeholder="tester" /></Field>
                <Field label="Display name"><Input value={s.displayName ?? ''} onChange={(e) => set(`agents.${i}.displayName`, e.target.value)} /></Field>
                <Field label="Model (optional)"><Input value={s.model ?? ''} onChange={(e) => set(`agents.${i}.model`, e.target.value)} /></Field>
              </div>
              <IconButton label="Remove sub-agent" type="button" className="mt-5" onClick={() => set('agents', subs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
            <Field label="Description"><Input value={s.description ?? ''} onChange={(e) => set(`agents.${i}.description`, e.target.value)} placeholder="When should the main agent call this one?" /></Field>
            <Field label="Prompt *"><Textarea rows={4} className={monoArea} value={s.prompt} onChange={(e) => set(`agents.${i}.prompt`, e.target.value)} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Group label="Tool allowlist" hint="Empty = all tools."><ChipInput label={`Sub-agent ${i + 1} tools`} value={s.tools ?? []} onChange={(v) => set(`agents.${i}.tools`, v)} placeholder="view, grep" /></Group>
              <Group label="Skills"><ChipInput label={`Sub-agent ${i + 1} skills`} value={s.skills ?? []} onChange={(v) => set(`agents.${i}.skills`, v)} /></Group>
            </div>
            <Toggle checked={s.infer !== false} onChange={(v) => set(`agents.${i}.infer`, v ? undefined : false)} label="Allow automatic delegation" description="The main agent may pick this sub-agent on its own." />
          </div>
        ))}
        {subs.length > 0 && (
          <Field label="Default sub-agent" error={defaultAgent.error} hint="Runs first instead of the main agent.">
            <Select className="w-60" value={defaultAgent.value} onChange={(e) => defaultAgent.set(e.target.value || undefined)}>
              <option value="">None</option>{subs.filter((s) => s.name).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </Select>
          </Field>
        )}
      </SectionCard>

      <SectionCard title="Skills">
        <Group label="Skill directories" hint="Folders containing SKILL.md files."><ChipInput label="Skill directories" value={dirs.value ?? []} onChange={(v) => dirs.set(v)} placeholder=".github/skills" /></Group>
        <Group label="Disabled skills"><ChipInput label="Disabled skills" value={disabledSkills.value ?? []} onChange={(v) => disabledSkills.set(v)} /></Group>
      </SectionCard>

      <SectionCard title="Fleet mode" description="Run several sub-agents in parallel on one task.">
        <Toggle checked={!!fleet.value} onChange={(v) => fleet.set(v ? true : undefined)} label="Enable fleet orchestration" />
        {fleet.value && (
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Fleet prompt"><Textarea rows={3} value={fleetPrompt.value} onChange={(e) => fleetPrompt.set(e.target.value)} /></Field>
            <Field label="Max workers (1–50)" error={maxWorkers.error}><Input type="number" min={1} max={50} value={maxWorkers.value ?? ''} onChange={(e) => maxWorkers.set(num(e.target.value))} placeholder="5" /></Field>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Runtime limits & behavior">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Turn timeout (ms)" hint="1,000 – 21,600,000"><Input type="number" value={rt.turnTimeoutMs ?? ''} onChange={(e) => set('runtime.turnTimeoutMs', num(e.target.value))} placeholder="2700000" /></Field>
          <Field label="Idle timeout (s)"><Input type="number" value={rt.idleTimeoutSecs ?? ''} onChange={(e) => set('runtime.idleTimeoutSecs', num(e.target.value))} /></Field>
          <Field label="Max AI credits"><Input type="number" value={rt.maxAiCredits ?? ''} onChange={(e) => set('runtime.maxAiCredits', num(e.target.value))} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Log level"><Select value={rt.logLevel ?? ''} onChange={(e) => set('runtime.logLevel', e.target.value || undefined)}><option value="">default</option><option>error</option><option>warning</option><option>info</option><option>debug</option></Select></Field>
        </div>
        <Toggle checked={rt.streaming !== false} onChange={(v) => set('runtime.streaming', v ? undefined : false)} label="Stream responses" description="Show tokens as they are generated." />
        <Toggle checked={!!rt.autopilot} onChange={(v) => set('runtime.autopilot', v ? true : undefined)} label="Autopilot" description="Let the agent continue on its own until the task is complete." />
        <Toggle checked={rt.toolSearch?.enabled === false} onChange={(v) => set('runtime.toolSearch.enabled', v ? false : undefined)} label="Preload tools (disable deferred tool search)" />
      </SectionCard>
      {customTools.length > 0 && <Callout tone="info">This agent has {customTools.length} custom tool definition(s). They are preserved and editable in the JSON tab.</Callout>}
    </div>
  );
}
