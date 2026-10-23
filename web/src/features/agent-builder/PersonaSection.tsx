import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { Button, Field, Modal, Select, Spinner, Textarea, Toggle } from '@/components/ui';
import { api, errMsg } from '@/lib/api';
import { useBuilder, useField } from './context';
import AiAssist from './AiAssist';
import { Callout, RadioCards, SectionCard, SectionTitle, monoArea } from './ui-bits';
import { SECTION_ACTIONS } from './model';

type Mode = 'append' | 'customize' | 'replace';

interface DefaultPrompt { sections: Record<string, { description?: string }>; capture?: { ok: boolean; text?: string; error?: string }; note?: string }

const useDefaultPrompt = (workdir: string | undefined, capture: boolean, enabled: boolean) =>
  useQuery({
    queryKey: ['default-prompt', workdir ?? '', capture],
    enabled,
    staleTime: 120_000,
    retry: false,
    queryFn: () => api<DefaultPrompt>(`/api/persona/default-system-prompt?capture=${capture ? 1 : 0}${workdir ? `&workdir=${encodeURIComponent(workdir)}` : ''}`),
  });

export default function PersonaSection() {
  const { def, set } = useBuilder();
  const [viewing, setViewing] = useState(false);
  const mode = (def.persona?.systemMessage?.mode ?? 'append') as Mode;
  const content = useField<string>('persona.systemMessage.content', '');
  const ack = useField<boolean>('persona.systemMessage.acknowledgeReplaceRisks', false);
  const task = useField<string>('task.prompt', '');
  const delivery = useField<string>('task.deliveryMode', 'enqueue');

  const setMode = (m: Mode) => {
    set('persona.systemMessage.mode', m);
    set('persona.useCopilotDefaultPrompt', m !== 'replace');
  };

  return (
    <div className="space-y-5">
      <SectionTitle title="Persona & task" description="Tell the agent who it is and how it should work." />
      <SectionCard title="System prompt" description="Defines the agent's role, tone and rules. Most agents only need a few paragraphs.">
        <RadioCards<Mode> label="System prompt mode" value={mode} onChange={setMode} options={[
          { value: 'append', title: 'Add to Copilot defaults', badge: 'Recommended', desc: 'Keeps the built-in Copilot prompt (tools, safety) and appends your instructions.' },
          { value: 'customize', title: 'Customize sections', desc: 'Override individual sections of the default prompt, e.g. tone or guidelines.' },
          { value: 'replace', title: 'Replace entirely', desc: 'Write the whole prompt yourself. Drops built-in guardrails.' },
        ]} />
        {mode === 'replace' && (
          <Callout tone="warn">
            Replacing the default prompt removes Copilot&apos;s tool instructions and safety guardrails. Make sure your prompt covers them.
            <div className="mt-2"><Toggle checked={!!ack.value} onChange={(v) => ack.set(v)} label="I understand the risks of replacing the system prompt" /></div>
            {ack.error && <p className="mt-1 text-danger">{ack.error}</p>}
          </Callout>
        )}
        <Field label={mode === 'replace' ? 'Full system prompt *' : mode === 'customize' ? 'Extra instructions (optional)' : 'Instructions'} error={content.error}
          hint="Markdown supported. Describe the role, what good output looks like, and anything the agent must never do.">
          <Textarea rows={10} className={monoArea} value={content.value} onChange={(e) => content.set(e.target.value)}
            placeholder={'You are a senior engineer who…\n\n## Rules\n- …'} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AiAssist field="persona.systemMessage" content={content.value} onResult={(t) => content.set(t)} label={content.value ? 'Improve with AI' : 'Draft with AI'} />
          <Button size="sm" variant="ghost" type="button" onClick={() => setViewing(true)}><Eye className="size-3.5" />View Copilot default prompt</Button>
        </div>
        {mode === 'customize' && <SectionOverrides />}
      </SectionCard>

      <SectionCard title="Default task for headless runs — optional"
        description="Chat agents don't need this. It is only the prompt used when the agent is started from Run without typing a task.">
        <Field label="Task prompt" hint="Leave empty for a pure chat agent." error={task.error}>
          <Textarea rows={4} value={task.value} onChange={(e) => task.set(e.target.value)} placeholder="Review the open changes and list any bugs." />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AiAssist field="task.prompt" content={task.value} onResult={(t) => task.set(t)} />
          <Field label="Delivery mode" className="w-48">
            <Select value={delivery.value} onChange={(e) => delivery.set(e.target.value)}>
              <option value="enqueue">enqueue (after current work)</option><option value="immediate">immediate</option>
            </Select>
          </Field>
        </div>
      </SectionCard>
      <DefaultPromptModal open={viewing} onClose={() => setViewing(false)} workdir={def.knowledge?.workingDirectory} />
    </div>
  );
}

function SectionOverrides() {
  const { def, set } = useBuilder();
  const dp = useDefaultPrompt(def.knowledge?.workingDirectory, false, true);
  const sections = (def.persona?.systemMessage?.sections ?? {}) as Record<string, { action: string; content?: string }>;
  const ids = Object.keys(dp.data?.sections ?? {});
  const update = (id: string, v: { action: string; content?: string } | undefined) => {
    const next: Record<string, unknown> = { ...sections };
    if (v) next[id] = v; else delete next[id];
    set('persona.systemMessage.sections', Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted">Section overrides</div>
      {dp.isLoading && <Spinner />}
      {dp.isError && <Callout tone="warn">Could not load the section list: {errMsg(dp.error)}</Callout>}
      <div className="divide-y divide-border rounded-lg border border-border">
        {ids.map((id) => {
          const cur = sections[id];
          return (
            <div key={id} className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-medium">{id}</div>
                  <div className="truncate text-xs text-muted" title={dp.data?.sections[id]?.description}>{dp.data?.sections[id]?.description}</div>
                </div>
                <Select aria-label={`${id} action`} className="w-32 shrink-0" value={cur?.action ?? 'inherit'}
                  onChange={(e) => e.target.value === 'inherit' ? update(id, undefined) : update(id, { ...cur, action: e.target.value })}>
                  {SECTION_ACTIONS.map((a) => <option key={a} value={a}>{a === 'inherit' ? 'unchanged' : a}</option>)}
                </Select>
              </div>
              {cur && ['replace', 'append', 'prepend'].includes(cur.action) && (
                <Textarea rows={3} aria-label={`${id} content`} className={monoArea} value={cur.content ?? ''} onChange={(e) => update(id, { ...cur, content: e.target.value })} placeholder="Text for this section…" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DefaultPromptModal({ open, onClose, workdir }: { open: boolean; onClose: () => void; workdir?: string }) {
  const dp = useDefaultPrompt(workdir, true, open);
  const cap = dp.data?.capture;
  return (
    <Modal open={open} onClose={onClose} title="Copilot default system prompt" width="max-w-3xl" footer={<Button onClick={onClose}>Close</Button>}>
      {dp.isLoading && <div className="flex items-center gap-2 text-sm text-muted"><Spinner />Capturing the default prompt…</div>}
      {dp.isError && <Callout tone="danger">{errMsg(dp.error)}</Callout>}
      {dp.data && (
        <div className="space-y-3">
          {dp.data.note && <p className="text-xs text-muted">{dp.data.note}</p>}
          {cap?.ok && cap.text ? <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs">{cap.text}</pre>
            : <Callout tone="warn">{cap?.error ?? 'The prompt could not be captured. Section ids are listed in the Customize mode.'}</Callout>}
        </div>
      )}
    </Modal>
  );
}

