import { Wand2 } from 'lucide-react';
import { Field, Input, Textarea, cn } from '@/components/ui';
import { useBuilder, useField } from './context';
import { Callout, ChipInput, Group, SectionCard, SectionTitle } from './ui-bits';
import { PRESETS_COLORS } from './colors';
import { TEMPLATES, presetValue, slugify, type Def } from './model';

export default function IdentitySection() {
  const { setDef, def, isEdit } = useBuilder();
  const name = useField<string>('metadata.name', '');
  const version = useField<string>('metadata.version', '');
  const desc = useField<string>('metadata.description', '');
  const color = useField<string>('metadata.color', '');
  const tags = useField<string[]>('metadata.tags', []);
  const nameSlug = slugify(name.value);
  const hasPersona = !!def.persona?.systemMessage?.content;

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setDef((d: Def) => ({
      ...d,
      metadata: { ...d.metadata, name: d.metadata?.name || t.name, description: t.description },
      persona: { ...d.persona, useCopilotDefaultPrompt: true, systemMessage: { mode: 'append', content: t.persona } },
      tools: { ...d.tools, builtins: presetValue(t.tools) },
    }));
  };

  return (
    <div className="space-y-5">
      <SectionTitle title="Identity" description="Give your agent a name people will recognise in the chat agent picker." />
      {!isEdit && (
        <SectionCard title="Start from a template" description="Optional. Fills in a persona, description and sensible tool permissions you can edit afterwards.">
          <div className="grid gap-2 sm:grid-cols-2">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => applyTemplate(t.id)}
                className="group rounded-lg border border-border p-3 text-left transition-colors hover:border-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">
                <div className="flex items-center gap-1.5 text-sm font-medium"><Wand2 className="size-3.5 text-accent" />{t.title}</div>
                <p className="mt-1 text-xs text-muted">{t.description}</p>
              </button>
            ))}
          </div>
          {hasPersona && <p className="text-xs text-muted">Applying a template replaces your current persona text and permissions.</p>}
        </SectionCard>
      )}
      <SectionCard title="Basics">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Name *" error={name.error} hint={name.value && nameSlug !== name.value ? `Tip: lowercase-with-dashes keeps ids tidy, e.g. ${nameSlug || 'my-agent'}` : 'Shown in the agent picker. Together with the version it forms the agent id.'}>
            <Input value={name.value} onChange={(e) => name.set(e.target.value)} placeholder="code-reviewer" autoFocus={!isEdit} />
          </Field>
          <Field label="Version *" error={version.error} hint="Semantic version, e.g. 1.0.0">
            <Input value={version.value} onChange={(e) => version.set(e.target.value)} placeholder="1.0.0" />
          </Field>
        </div>
        <Field label="Description" hint="One or two sentences explaining what this agent is good at." error={desc.error}>
          <Textarea rows={2} value={desc.value} onChange={(e) => desc.set(e.target.value)} placeholder="Reviews pull requests for bugs, security issues and missing tests." />
        </Field>
        {isEdit && <Callout tone="info">The agent id is <code>name@version</code>. Changing the name or version publishes a <b>new</b> agent and leaves this one untouched.</Callout>}
      </SectionCard>
      <SectionCard title="Appearance & discovery">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Chat color</div>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Chat color">
            <button type="button" role="radio" aria-checked={!color.value} onClick={() => color.set(undefined)}
              className={cn('h-7 rounded-md border px-2 text-xs', !color.value ? 'border-accent text-fg ring-1 ring-accent' : 'border-border text-muted hover:text-fg')}>Auto</button>
            {PRESETS_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color.value?.toLowerCase() === c} aria-label={c} onClick={() => color.set(c)}
                style={{ backgroundColor: c }}
                className={cn('size-7 rounded-full border-2 transition-transform hover:scale-110', color.value?.toLowerCase() === c ? 'border-fg' : 'border-transparent')} />
            ))}
            <Input className="w-28" aria-label="Custom hex color" value={color.value ?? ''} onChange={(e) => color.set(e.target.value)} placeholder="#6366f1" />
          </div>
          {color.error && <p className="mt-1 text-xs text-danger">Use a 6-digit hex color like #6366f1</p>}
          <p className="mt-1 text-xs text-muted">Tints this agent&apos;s messages in chat. Leave on Auto for a deterministic color.</p>
        </div>
        <Group label="Tags" hint="Press Enter to add. Helps you find agents later.">
          <ChipInput label="Tags" value={tags.value ?? []} onChange={(v) => tags.set(v)} placeholder="review, typescript" />
        </Group>
      </SectionCard>
    </div>
  );
}
