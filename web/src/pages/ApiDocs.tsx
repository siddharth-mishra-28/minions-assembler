import { useState } from 'react';
import { BookOpen, ExternalLink, FileJson } from 'lucide-react';
import { Button, Card, Tabs } from '@/components/ui';
import { CodeBlock, CopyButton, OpsPage } from '@/features/ops/components';

const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3100';

const examples: { id: string; label: string; items: { title: string; note?: string; code: string }[] }[] = [
  {
    id: 'chat', label: 'Chat API',
    items: [
      { title: '1 · Create a thread', note: 'agentId, projectId, model and title are all optional. Omit agentId for a general thread.', code: `curl -s -X POST ${origin}/api/chat/threads \\\n  -H 'Content-Type: application/json' \\\n  -d '{"agentId":"my-agent@1.0.0","title":"API demo"}'` },
      { title: '2 · Send a message and wait for the reply', note: 'Without ?wait=true the call returns 202 immediately; follow the turn on /events or /stream.', code: `curl -s -X POST "${origin}/api/chat/threads/<threadId>/messages?wait=true" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"content":"Summarise the open TODOs in this repo"}'\n# → { userMessageId, replyMessageId, runId, agentId, text, reasoning, tools[] }` },
      { title: '3 · Stream a turn (SSE)', code: `curl -N ${origin}/api/chat/threads/<threadId>/stream` },
      { title: 'Cancel a running turn', code: `curl -s -X POST ${origin}/api/chat/threads/<threadId>/cancel` },
      { title: 'Export a thread', code: `curl -s ${origin}/api/chat/threads/<threadId>/export` },
    ],
  },
  {
    id: 'run', label: 'Run API',
    items: [
      { title: 'Run a registered agent', note: 'The call blocks until the run finishes. The id is name@version, URL-encoded (@ → %40). Optional: taskOverride, auditLevel (minimal | default | full), turnTimeoutMs.', code: `curl -s -X POST ${origin}/api/agents/my-agent%401.0.0/runs \\\n  -H 'Content-Type: application/json' \\\n  -d '{"taskOverride":"Reply with exactly: OK","auditLevel":"full"}'\n# → { runId, sessionId, traceId, text }` },
      { title: 'Run an inline definition (not registered)', code: `curl -s -X POST ${origin}/api/agent-definitions/runs \\\n  -H 'Content-Type: application/json' \\\n  -d '{"definition":{ …full AgentDefinition… },"taskOverride":"Reply with exactly: OK"}'` },
      { title: 'List runs and read events', code: `curl -s "${origin}/api/audit/runs?status=failed&limit=20"\ncurl -s "${origin}/api/runs/<runId>/events?afterSeq=0"` },
      { title: 'Export an audit bundle', code: `curl -s -OJ ${origin}/api/audit/runs/<runId>/export` },
    ],
  },
  {
    id: 'auth', label: 'Authentication',
    items: [
      { title: 'Bearer token', note: 'When the server is started with MINION_API_TOKEN, every /api request needs the token.', code: `curl -s -H "Authorization: Bearer $MINION_API_TOKEN" ${origin}/api/status` },
    ],
  },
];

export default function ApiDocs() {
  const [tab, setTab] = useState('chat');
  const group = examples.find((g) => g.id === tab) ?? examples[0];
  return (
    <OpsPage title="API docs" description="Interactive OpenAPI reference for every endpoint, plus quick-start examples."
      actions={
        <div className="flex gap-2">
          <a href="/openapi.json" target="_blank" rel="noreferrer"><Button variant="secondary"><FileJson className="size-4" />openapi.json</Button></a>
          <a href="/docs" target="_blank" rel="noreferrer"><Button variant="primary"><ExternalLink className="size-4" />Open in new tab</Button></a>
        </div>
      }>
      <div className="space-y-6">
        <section>
          <div className="mb-3 flex items-center gap-2"><BookOpen className="size-4 text-accent" /><h3 className="text-sm font-semibold">Quick start</h3></div>
          <div className="mb-3"><Tabs value={tab} onChange={setTab} items={examples.map((g) => ({ id: g.id, label: g.label }))} /></div>
          <div className="grid gap-3 lg:grid-cols-2">
            {group.items.map((ex) => (
              <Card key={ex.title} className="p-4">
                <div className="mb-1 flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{ex.title}</h4><CopyButton text={ex.code} /></div>
                {ex.note && <p className="mb-2 text-xs text-muted">{ex.note}</p>}
                <CodeBlock text={ex.code} maxHeight="max-h-60" />
              </Card>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold">Swagger UI</h3>
          <Card className="overflow-hidden">
            <iframe src="/docs" title="Swagger UI" className="block h-[78vh] min-h-[480px] w-full border-0 bg-white" />
          </Card>
        </section>
      </div>
    </OpsPage>
  );
}
