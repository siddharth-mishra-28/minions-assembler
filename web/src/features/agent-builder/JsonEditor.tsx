import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, WrapText } from 'lucide-react';
import { Button, Textarea, toast } from '@/components/ui';
import { Callout } from './ui-bits';
import { normalize, type Def } from './model';

export function downloadJson(def: Def, filename: string) {
  const blob = new Blob([JSON.stringify(def, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fileName = (def: Def) => `${def.metadata?.name || 'agent'}-${def.metadata?.version || '1.0.0'}.agent.json`;

/** Two-way raw JSON editor. Valid edits flow into the form immediately; the form never overwrites text while this is mounted. */
export default function JsonEditor({ def, onChange }: { def: Def; onChange: (d: Def) => void }) {
  const [text, setText] = useState(() => JSON.stringify(normalize(def), null, 2));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const first = useRef(true);

  useEffect(() => { first.current = false; }, []);

  const edit = (v: string) => {
    setText(v);
    try {
      const parsed = JSON.parse(v);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The definition must be a JSON object');
      setError(null);
      onChange(parsed as Def);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const format = () => {
    try { setText(JSON.stringify(JSON.parse(text), null, 2)); } catch { toast.error('Fix the JSON syntax error first'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Edit the raw definition. Valid JSON is applied to the guided form instantly.</p>
        <div className="flex gap-1.5">
          <Button size="sm" type="button" onClick={format}><WrapText className="size-3.5" />Format</Button>
          <Button size="sm" type="button" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}Copy</Button>
          <Button size="sm" type="button" onClick={() => { try { downloadJson(JSON.parse(text), fileName(def)); } catch { toast.error('Fix the JSON syntax error first'); } }}><Download className="size-3.5" />Download</Button>
        </div>
      </div>
      <Textarea aria-label="Agent definition JSON" spellCheck={false} value={text} onChange={(e) => edit(e.target.value)}
        className="h-[60vh] min-h-80 resize-y font-mono text-xs leading-relaxed" />
      {error ? <Callout tone="danger">JSON error: {error}</Callout> : <Callout tone="ok">Valid JSON.</Callout>}
    </div>
  );
}
