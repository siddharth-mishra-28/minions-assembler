import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

const textOf = (n: ReactNode): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' && 'props' in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : '');

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
            <div className="group relative">
              <pre>{c}</pre>
              <CopyButton text={textOf(c).replace(/\n$/, '')} className="absolute right-2 top-2 opacity-0 group-hover:opacity-100" />
            </div>
          ),
        }}
      >{children}</ReactMarkdown>
    </div>
  );
});
