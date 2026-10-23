import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

const textOf = (n: ReactNode): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' && 'props' in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : '');

const languageOf = (n: ReactNode): string => {
  const el = Array.isArray(n) ? n[0] : n;
  const cls = el && typeof el === 'object' && 'props' in el ? (el as { props: { className?: string } }).props.className : undefined;
  return /language-([\w+-]+)/.exec(cls ?? '')?.[1] ?? 'code';
};

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button aria-label="Copy" title="Copy" className={`rounded p-1 text-muted hover:bg-border hover:text-fg ${className}`}
      onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export const Markdown = memo(function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  return (
    <div className={`prose prose-sm max-w-none break-words ${streaming ? '[&>*:last-child]:after:content-["▍"] [&>*:last-child]:after:text-accent' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ children: c, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{c}</a>,
          pre: ({ children: c }) => (
            <div className="group relative my-3 overflow-hidden rounded-xl border border-border bg-surface-2">
              <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5">
                <span className="font-mono text-[11px] uppercase tracking-wider text-muted">{languageOf(c)}</span>
                <CopyButton text={textOf(c).replace(/\n$/, '')} />
              </div>
              <pre className="!m-0 overflow-x-auto !border-0 !bg-transparent !p-3">{c}</pre>
            </div>
          ),
        }}
      >{children}</ReactMarkdown>
    </div>
  );
});
