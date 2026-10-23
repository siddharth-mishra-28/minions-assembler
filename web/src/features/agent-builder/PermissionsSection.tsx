import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Input, Select, Toggle } from '@/components/ui';
import { useBuilder } from './context';
import { useBuiltinTools } from './hooks';
import { Callout, RadioCards, Segmented, SectionCard, SectionTitle } from './ui-bits';
import { PRESET_LABELS, detectPreset, presetValue, setToolDecision, toolDecision, type Decision, type Def, type PermissionPreset } from './model';

interface Pattern { tool: string; decision: string; reason?: string }

export default function PermissionsSection() {
  const { def, set } = useBuilder();
  const tools = useBuiltinTools();
  const builtins = (def.tools?.builtins ?? { all: true }) as Def;
  const preset = detectPreset(builtins);
  const patterns = (def.tools?.patterns ?? []) as Pattern[];
  const enabled = (tools.data ?? []).filter((t) => builtins.all !== false ? true : toolDecision(builtins, t.name) !== 'deny');

  const applyPreset = (p: PermissionPreset) => {
    if (p === 'custom') return;
    set('tools.builtins', presetValue(p));
  };

  return (
    <div className="space-y-5">
      <SectionTitle title="Permissions" description="Control what the agent may do on its own. Risky actions can require your approval in chat." />
      <SectionCard title="Approval policy" description="Pick a starting point, then fine-tune individual tools below.">
        <RadioCards<PermissionPreset> label="Permission preset" value={preset} onChange={applyPreset} options={[
          { value: 'ask', title: PRESET_LABELS.ask.title, desc: PRESET_LABELS.ask.desc, badge: 'Recommended' },
          { value: 'readonly', title: PRESET_LABELS.readonly.title, desc: PRESET_LABELS.readonly.desc },
          { value: 'autonomous', title: PRESET_LABELS.autonomous.title, desc: PRESET_LABELS.autonomous.desc },
        ]} />
        {preset === 'custom' && <Callout tone="info">Custom permissions — you have changed individual tools. Choose a preset above to reset.</Callout>}
        <Callout tone="info"><b>Ask</b> prompts you in chat according to your chat approval mode. In headless runs (no human) it is treated as a denied, audited call.</Callout>
      </SectionCard>

      <SectionCard title="Per-tool decisions" description="Allow runs silently, Ask needs approval, Deny blocks the tool.">
        <div className="divide-y divide-border rounded-lg border border-border">
          {enabled.map((t) => (
            <div key={t.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0"><div className="font-mono text-xs font-medium">{t.name}</div>{t.description && <div className="truncate text-xs text-muted" title={t.description}>{t.description}</div>}</div>
              <Segmented<Decision> label={`${t.name} decision`} value={toolDecision(builtins, t.name)} onChange={(d) => set('tools.builtins', setToolDecision(builtins, t.name, d))}
                options={[{ value: 'allow', label: 'Allow', tone: 'text-ok' }, { value: 'ask', label: 'Ask', tone: 'text-warn' }, { value: 'deny', label: 'Deny', tone: 'text-danger' }]} />
            </div>
          ))}
          {tools.data && enabled.length === 0 && <div className="p-3 text-xs text-muted">No built-in tools are enabled.</div>}
        </div>
        {builtins.all !== false && (
          <Field label="Default for other tools (MCP, custom)" hint="Applies to tools without an explicit decision.">
            <Select className="w-40" value={builtins.default ?? 'allow'} onChange={(e) => set('tools.builtins.default', e.target.value)}>
              <option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option>
            </Select>
          </Field>
        )}
      </SectionCard>

      <SectionCard title="Safety">
        <Toggle checked={!!def.tools?.allowDestructive} onChange={(v) => set('tools.allowDestructive', v ? true : undefined)}
          label="Allow destructive commands" description="Skips the built-in gate that blocks things like recursive deletes and force pushes. Leave off unless you trust the agent completely." />
        {def.tools?.allowDestructive && <Callout tone="warn">Destructive commands will no longer be intercepted for this agent.</Callout>}
      </SectionCard>

      <details className="rounded-xl border border-border bg-surface px-5 py-3">
        <summary className="cursor-pointer text-sm font-semibold">Advanced policy &amp; patterns</summary>
        <div className="mt-4 space-y-4">
          <Field label="Fallback policy" hint="What happens to tool calls that no rule above decides.">
            <Select value={def.tools?.permissionPolicy ?? 'deny-all'} onChange={(e) => set('tools.permissionPolicy', e.target.value)}>
              <option value="pattern-list">pattern-list (recommended)</option><option value="deny-all">deny-all (schema default)</option><option value="approve-all-ci-only">approve-all-ci-only</option>
            </Select>
          </Field>
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted">Pattern rules (checked first)</div>
            <Button size="sm" type="button" onClick={() => set('tools.patterns', [...patterns, { tool: '', decision: 'allow' }])}><Plus className="size-3.5" />Add rule</Button>
          </div>
          {patterns.map((p, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem_1fr_auto] items-center gap-2">
              <Input aria-label="Tool pattern" value={p.tool} onChange={(e) => set(`tools.patterns.${i}.tool`, e.target.value)} placeholder="bash" className="font-mono text-xs" />
              <Select aria-label="Decision" value={p.decision} onChange={(e) => set(`tools.patterns.${i}.decision`, e.target.value)}><option value="allow">allow</option><option value="deny">deny</option></Select>
              <Input aria-label="Reason" value={p.reason ?? ''} onChange={(e) => set(`tools.patterns.${i}.reason`, e.target.value)} placeholder="Reason (optional)" />
              <IconButton label="Remove rule" type="button" onClick={() => set('tools.patterns', patterns.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
