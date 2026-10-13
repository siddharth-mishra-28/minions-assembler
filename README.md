# minion-assembler

Define, run, audit, and serve **custom GitHub Copilot agents** from a single versioned JSON file.

One JSON definition drives three surfaces:

| Mode | Command | What you get |
|---|---|---|
| **CLI (autonomous / CI)** | `minion-assembler run --agentDefinition ./my-agent.json` | Headless one-shot runs with exit codes for pipelines |
| **Serve (API + Swagger)** | `minion-assembler serve --port 3100` | REST API, `/docs` Swagger UI, OpenAPI JSON |
| **Serve (UI)** | browser at `http://127.0.0.1:3100` | **Dashboard (agent metrics)** · Define (live-validating editor) · Agents · Agent runner · Runs · Sessions · MCP Registry · Audit logs |

Everything persists to SQLite (`agents`, `runs`, `events`, `usage`, `transcripts`, `sessions`) for reusability, auditing, and traceability — plus structured JSONL audit logs and per-run event files on disk. Built on [`@github/copilot-sdk`](https://docs.github.com/en/copilot/how-tos/copilot-sdk) (TypeScript / Node.js 18+).

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js **18+** (tested on 24) | Check with `node --version` |
| npm 9+ | Ships with Node |
| A BYOK LLM credential | Any OpenAI-compatible endpoint (OpenAI, Mimo, vLLM, LiteLLM, Ollama, …), Azure OpenAI, or Anthropic. **No GitHub Copilot subscription is needed** — BYOK bypasses GitHub auth. |
| Windows / macOS / Linux | All paths cross-platform |

> The API key lives **only** in an environment variable (e.g. `LLM_API_KEY`). It is never written to JSON, the database, or logs — the loader redacts anything matching `key|token|secret|password` and tests assert zero leakage.

---

## 2. Install

```bash
npm install
npm run build        # compiles TypeScript to flat dist/ (dist/cli.js, …)
```

| # | Launch path | Command | Best for |
|---|---|---|---|
| A | Compiled | `node dist/cli.js <cmd>` | Production / CI |
| B | Dev (tsx) | `npx tsx src/cli.ts <cmd>` | Iterating on source, no rebuild |
| C | Global bin | `npm link` once, then `minion-assembler <cmd>` | Daily use; undo with `npm uninstall -g minion-assembler` |

Smoke-check:

```bash
node dist/cli.js --help        # shows: validate | run | serve | list | show | history
node dist/cli.js validate --agentDefinition ./fixtures/mimo-smoke-test.agent.json
# -> valid: mimo-smoke-test@1.0.0 (hash 4d7ee2e2…)
```

---

## 3. Configure credentials

The bundled fixture uses `LLM_API_KEY`:

```bash
export LLM_API_KEY='your-key-here'            # bash / git-bash
$env:LLM_API_KEY = 'your-key-here'            # PowerShell
set LLM_API_KEY=your-key-here                 # CMD
```

Or a **`.env` file** in the project root (git-ignored) — the CLI loads it via `dotenv`:

```ini
LLM_API_KEY=your-key-here
```

Missing variable → `validate` warns; `run` fails fast (exit 3).

---

## 4. Server mode + UI

### 4.1 Start

```bash
node dist/cli.js serve --port 3100 --db ./data/minion.db
# -> minion-assembler serve on http://127.0.0.1:3100 (docs: /docs)
```

On startup the adapter creates `data/` if missing and opens `data/minion.db` — **8 tables** (`agents`, `runs`, `events`, `usage`, `transcripts`, `mcp_servers`, `sessions` + vector-free schema) in **WAL mode** for concurrency-safe reads while runs write. A custom `--db path` gets its parent folder auto-created the same way.

Loopback-only (`127.0.0.1`). Export `LLM_API_KEY` in the same shell so API-triggered runs can resolve credentials.

### 4.2 Workspace & audit logs

The **agent workspace** (where agents read/write files and where per-run transcripts go) is configurable, resolved in this order:

1. **Definition override** — `knowledge.workingDirectory` inside an agent definition
2. **`MINION_WORKSPACE` env var** — set per serve/CLI invocation: `MINION_WORKSPACE=D:/agent-workspaces minion-assembler serve`
3. **Process current directory** (project root default)

```bash
MINION_WORKSPACE=D:/agent-workspaces LLM_API_KEY=… node dist/cli.js serve --port 3100
# run transcript events then land in D:/agent-workspaces/runs/<runId>/events.jsonl
# server audit log lands in  D:/agent-workspaces/.minion/server.log.jsonl
```

Structured **JSONL audit log** (`.minion/server.log.jsonl`, secrets scrubbed): one record per HTTP request (method, url, status, duration ms) plus server lifecycle events. Filter with `GET /api/logs`: `?level=error`, `?event=http.request`, `?limit=N` (≤1000, newest last). The Dashboard also renders the latest entries inline with an "Errors only" toggle.

**Audit verbosity — `AUDIT_LEVEL` env or `--audit-level <level>` CLI flag / `auditLevel` run-body field.** Controls how much of the agent's history each run records (both to the per-run `events.jsonl` transcript and the SQLite `events` table):

| Level | Records |
|---|---|
| `minimal` | Run lifecycle only: `run.start` (definition snapshot, workspace), `prompt.send`, `session.create`/`resume`, `assistant.message`, `run.complete`/`run.error` |
| `default` | + **tool calls** (`tool.call` — tool name + full arguments), **tool results** (`tool.result` — output, success flag, error), **permission requests/decisions** (`permission.request`, `permission.decision`), hook lifecycle (`hook.start`/`hook.end`), turns, usage |
| `full` | + assistant **reasoning** (`assistant.reasoning`), streaming deltas (`assistant.message_delta`), tool partial results/progress, session errors — the complete request/response trace |

```bash
AUDIT_LEVEL=full node dist/cli.js run --agentDefinition examples/fe-engineer.agent.json
# or per request:  curl -X POST .../api/agents/fe-engineer@1.0.0/runs -d '{"auditLevel":"full"}'
```

### 4.3 UI pages

Enterprise control-plane theme (deep-indigo, gradient sidebar, Inter font, toasts, responsive full-width forms). Sidebar navigation is grouped: Overview · Agents (Agents, Define) · Operations (Runs, Sessions) · Integrations (MCP Registry) · Developer (API Docs).

| URL | Page | What you do |
|---|---|---|
| `/` | **Dashboard** | Agent metrics (runs/24h, success rate, tokens, credits, avg duration), runs-by-status bars, most-used agents, recent activity, **workspace facts + live audit-log viewer** |
| `/ui` | **Define** | Paste/edit JSON, live validation as you type with precise error messages, load template / format / download, **Validate & register** |
| `/ui/agents` | **Agents** | All registered definitions with run counts; click into a detail page |
| `/ui/agents/:id` | **Agent runner** | Task-override input + ▶ Run button (live call with spinner + inline success/error + credential hint), recent runs for that agent, stored definition |
| `/ui/mcp` | **MCP Registry** | Register MCP servers with field-level validation, live-probe their tools before/after saving, re-probe, delete; each row links to a detail page with the discovered tool schemas |
| `/ui/runs` | **Runs** | All runs with status badges, filter box, model, trace id |
| `/ui/runs/:id` | **Run detail** | Stat cards (agent, model, definition hash, timings), trace/session pills → session inspector, **color-coded event timeline** with tool calls (🔧 name + arguments), tool results (✓/✕ + output), and permission decisions rendered distinctly, expandable JSON payloads, auto-refresh while running, usage panel |
| `/ui/sessions` | **Sessions** | Every SDK session with run/agent/trace joins + final summary; `/ui/sessions/:sid` shows the full lifecycle record |
| `/docs` | **Swagger** | Interactive OpenAPI for every endpoint, with example payloads, response schemas, and documented error codes |
| `/openapi.json` | contract | Raw OpenAPI 3.x JSON |

The layout is full-width and responsive: fluid grids at desktop, forms keep an aligned two-column rhythm, and everything collapses to a single column ≤760–980px with the sidebar hiding on mobile.

### 4.4 Stop / troubleshoot

### 4.3b Stop / troubleshoot

`Ctrl+C` in its terminal. If backgrounded on Windows, map port→PID: `netstat -ano | findstr :3100`, then `taskkill /F /PID <pid>`. On macOS/Linux: `lsof -i :3100` → `kill <pid>`.

| Symptom | Fix |
|---|---|
| `EADDRINUSE` | Another process holds the port — see §4.3 or use `--port 3101`. |
| `Cannot find module …/dist/cli.js` | `npm run build` first (flat output root — no `dist/src/`). |
| API run → 500 `Missing credential` | Restart serve with the env var exported (or add `.env`). |
| Swagger renders but examples missing on "Try it out" | Old build — rebuild + restart. |

---

## 5. API reference (all endpoints, payloads, statuses)

Base URL: `http://127.0.0.1:3100`. Agent ids are `name@version` → URL-encode `@` as `%40`. All request/response bodies are JSON. Also browseable interactively at `/docs`.

### GET /api/status — server health
```bash
curl -s http://127.0.0.1:3100/api/status
```
```jsonc
// 200
{ "name": "minion-assembler", "version": "1.0.0", "sdk": "@github/copilot-sdk", "db": "./data/minion.db", "uptime": 42.5 }
```
Statuses: `200` always.

### POST /api/agents — validate + register a definition
Body must contain **either** `definitionPath` (server-side file path) **or** `definition` (inline object) — not both.
```bash
curl -s -X POST http://127.0.0.1:3100/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"definitionPath":"./fixtures/mimo-smoke-test.agent.json"}'
```
```jsonc
// 200 — registered (credentialEnv name stored; never a key value)
{ "id": "mimo-smoke-test@1.0.0", "hash": "4d7ee2e206e150bf", "warnings": [], "definition": { "...redacted..." } }
// 400 — invalid JSON / schema failure / both-or-neither sources
{ "error": "Schema validation failed: /metadata must have required property 'version'" }
{ "error": "Provide either definitionPath or definition, not both" }
```
Warning example (non-fatal): `"Credential env LLM_API_KEY is not set (required at run time, never stored)"`.
Statuses: `200` · `400` · (Fastify `404` only if route itself mismatches).

### POST /api/agents/validate — dry-run validation (no save)
Used by the UI editor; same rules as above.
```bash
curl -s -X POST http://127.0.0.1:3100/api/agents/validate \
  -H 'Content-Type: application/json' \
  -d '{"definition":{"schemaVersion":"1.0","metadata":{"name":"x","version":"1"},"persona":{"systemMessage":{"content":"hi"}},"task":{"prompt":"t"},"provider":{"type":"openai","baseUrl":"u","model":"m","credentialEnv":"E"}}}'
```
```jsonc
// 200
{ "valid": true, "hash": "5a55ef673528aefe", "warnings": ["Credential env E is not set …"] }
// 400
{ "error": "Schema validation failed: / must have required property 'persona'; …" }
```
Statuses: `200` · `400`.

### GET /api/agents — list registered agents
```jsonc
// 200
{ "agents": [ { "id": "mimo-smoke-test@1.0.0", "name": "mimo-smoke-test", "version": "1.0.0", "created_at": "2026-10-11T13:23:16.580Z" } ] }
```
Statuses: `200` (empty registry → `"agents": []`).

### GET /api/agents/:id — inspect one agent
```bash
curl -s http://127.0.0.1:3100/api/agents/mimo-smoke-test%401.0.0
```
```jsonc
// 200
{ "id": "mimo-smoke-test@1.0.0", "name": "mimo-smoke-test", "version": "1.0.0",
  "definition_json": "{\"schemaVersion\":\"1.0\",…}", "definition": { ...object... } }
// 404
{ "error": "agent not found: nope@1.0.0" }
```
Statuses: `200` · `404`.

### POST /api/agents/:id/runs — run an agent synchronously
Executes via the SDK (`sendAndWait`); returns when the turn finishes. `taskOverride` (optional) replaces the definition's `task.prompt`. The provider credential must be in the server env.
```bash
curl -s -X POST http://127.0.0.1:3100/api/agents/mimo-smoke-test%401.0.0/runs \
  -H 'Content-Type: application/json' \
  -d '{"taskOverride":"Reply with exactly: SERVE-API-OK"}'
```
```jsonc
// 200 — verified live: {"runId":"run_a5303917", ...,"text":"UI-RUN-OK"}
{ "runId": "run_a5303917", "sessionId": "sess_mv42pj5n_hkx53a", "traceId": "tr_mv42pj5n_omwglj7m", "text": "UI-RUN-OK" }
// 404
{ "error": "agent not found: nope@1.0.0" }
// 500 — runtime failure (details also persisted as run.error + run status 'failed')
{ "error": "Missing credential: env LLM_API_KEY is not set (BYOK keys are never stored in JSON or DB)" }
```
Statuses: `200` · `404` · `500`.

### GET /api/runs — list recent runs (max 100, filter `?agentId=`)
```jsonc
// 200 (each row): id, agent_id, session_id, trace_id, status, model, provider_type, task_prompt, definition_hash, created_at, finished_at, error
{ "runs": [ { "id": "run_a5303917", "status": "done", "trace_id": "tr_…", "model": "mimo-v2.6-flash", "...": "…" } ] }
```
Statuses: `200` (`status` ∈ queued|running|idle|aborted|failed|done).

### GET /api/runs/:id — one run row
```jsonc
// 200 — full row as above
// 404  { "error": "run not found: run_unknown" }
```
Statuses: `200` · `404`.

### GET /api/runs/:id/events — ordered audit events (pollable)
`?afterSeq=N` returns only events with seq > N (incremental polling; `0`/omitted = all).
```bash
curl -s "http://127.0.0.1:3100/api/runs/run_a5303917/events?afterSeq=0"
```
```jsonc
// 200 — verified live (11 events in one turn):
{ "run": { "id": "run_a5303917", "status": "done", "...": "…" },
  "events": [
    { "seq": 1, "type": "run.start",             "payload_json": "{…}", "persisted": 1, "at": "2026-10-11T20:…" },
    { "seq": 2, "type": "session.create",        "payload_json": "{…}", "persisted": 1, "at": "…" },
    { "seq": 3, "type": "prompt.send",           "payload_json": "{\"prompt\":\"…\",\"mode\":\"enqueue\"}", "persisted": 1, "at": "…" },
    { "seq": 4, "type": "assistant.turn_start",  "payload_json": "{}",  "persisted": 1, "at": "…" },
    { "seq": 5, "type": "assistant.message_delta","payload_json": "{…}", "persisted": 0, "at": "…" },
    { "seq": 6, "type": "assistant.usage",       "payload_json": "{…}", "persisted": 1, "at": "…" },
    { "seq": 7, "type": "assistant.message",     "payload_json": "{…}", "persisted": 1, "at": "…" },
    { "seq": 8, "type": "assistant.turn_end",    "payload_json": "{}",  "persisted": 1, "at": "…" },
    { "seq": 9, "type": "session.idle",          "payload_json": "{}",  "persisted": 0, "at": "…" },
    { "seq": 10,"type": "run.complete",          "payload_json": "{…}", "persisted": 1, "at": "…" }
  ] }
// failure runs additionally carry run.error; failed run rows have status "failed"
// 404  { "error": "run not found: run_unknown" }
```
Statuses: `200` · `404`.

### GET /api/runs/:id/stream — SSE replay
Replays all persisted events as `data: {"seq":n,"type":"…"}`, then `data: {"done":true}` and closes.
Statuses: `200` (Content-Type `text/event-stream`) · `404`.

### GET /api/sessions — list SDK sessions (audit)
Every SDK session with its run, agent, trace id, status, and final summary:
```jsonc
// 200 — verified live
{ "sessions": [ { "session_id": "sess_mv47z5dr_yyz0hn", "run_id": "run_6c016a45", "agent_id": "expense-tracker-dev@1.0.0", "trace_id": "tr_mv47z5dq_zfxoe0ol", "status": "idle-done", "summary": "Created `out/expense-tracker.html" — …", "created_at": "…", "updated_at": "…" } ] }
```
Statuses: `200` (empty → `"sessions": []`). No response schema: summaries are free-form.

### GET /api/sessions/:sid — inspect one SDK session
```jsonc
// 200 — single row as above
// 404  { "error": "session not found: sess_none" }
```
Statuses: `200` · `404`.

### GET /api/templates/default — working fixture template
The bundled example definition (redacted), used by the UI's "load working template" button.
```jsonc
// 200 — the mimo-smoke-test definition object
// 404  { "error": "fixture template not found" }
```
Statuses: `200` · `404`.

### GET /api/metrics — dashboard metrics
Aggregates used by the Dashboard. `byStatus` counts by run status; `byRuns` ranks agents by run count; `recentRuns` is the latest 8.
```jsonc
// 200 — verified live
{ "agents": { "total": 1, "latest": "expense-tracker-dev@1.0.0", "byRuns": [{ "id": "expense-tracker-dev@1.0.0", "runs": 2 }] },
  "runs": { "total": 2, "last24h": 2, "finished": 2, "succeeded": 1, "byStatus": { "done": 1, "failed": 1 } },
  "usage": { "tokensIn": null, "tokensOut": null, "credits": null, "avgDurationMs": 1997, "rows": 1 },
  "mcp": { "total": 0 },
  "recentRuns": [ { "id": "run_…", "agent_id": "…", "status": "done", "model": "…", "created_at": "…" } ] }
```
Statuses: `200`.

### GET /api/logs — structured audit logs (JSONL)
Reads the server audit log with optional filters.
```bash
curl -s "http://127.0.0.1:3100/api/logs?level=error&limit=50"
```
```jsonc
// 200 — verified live
{ "file": "D:/…/.minion/server.log.jsonl", "count": 3,
  "entries": [
    { "ts": "2026-10-13T00:47:…", "level": "info",  "event": "server.start",   "pid": 12345, "db": "./data/minion.db", "workspace": "…", "workspaceSource": "cwd" },
    { "ts": "…", "level": "audit", "event": "http.request", "pid": 12345, "method": "GET",  "url": "/api/status", "statusCode": 200, "ms": 2 }
  ] }
```
Query params: `level` ∈ info|warn|error|audit · `event` (substring) · `limit` ≤ 1000 (newest last). Every entry is also on disk, scrubbed of secret-looking values.
Statuses: `200`.

---

## 5b. MCP server registry — endpoints, payloads, statuses

MCP servers are registered once and referenced by name from any definition via `mcp.use`. The registry lives in the same SQLite file (`mcp_servers` table).

### How agents reference registered servers
```jsonc
// in an agent definition:
"mcp": {
  "use": [ "inventory-echo" ]                                  // full: all discovered/stored tools
  // or scoped: { "name": "inventory-echo", "allow": ["echo"], "deny": [], "disabled": false }
  // inline servers (not from the registry) remain supported:
  "servers": { "my-local": { "type": "local", "command": "node", "args": ["./x.mjs"] } }
}
```
At run time the runner expands `mcp.use` against the registry, filters tools per `allow`/`deny`, and injects the concrete server configs into the SDK session — recorded in the audit trail as an `mcp.expand` event. Unknown names fail the run fast: *`MCP server 'x' not found in registry — register it first via POST /api/mcp …`*.

### POST /api/mcp — register / update an MCP server
```bash
curl -s -X POST http://127.0.0.1:3100/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "inventory-echo",
        "description": "Echo test server",
        "config": { "type": "local", "command": "node", "args": ["./my-mcp-servers/echo.mjs"], "tools": ["*"] },
        "probe": true
      }'
```
```jsonc
// 200 — verified live
{ "name": "inventory-echo", "status": "registered (tools discovered: 1)", "config": { "type": "local", "command": "node", "args": ["./my-mcp-servers/echo.mjs"], "tools": ["*"] }, "tools": [ { "name": "echo" } ] }
// 400
{ "error": "type must be 'local'|'stdio'|'http'|'sse'" }
{ "error": "http/sse servers require 'url'" }
{ "error": "spawn failed: spawn definitely-not-a-real-cmd-xyz ENOENT" }   // probe:true with a bad command
```
Notes: `local`/`stdio` need `command`; `http`/`sse` need a valid `url`. `env`/`headers` accept `${ENV_VAR}` references only (literal secrets are rejected by the loader warning + redaction). `probe:true` connects now (stdio JSON-RPC handshake or HTTP `initialize`+`tools/list`) and stores the tool list; re-registering without `probe` keeps previously stored tools. Upsert on `name`.
Statuses: `200` · `400`.

### POST /api/mcp/probe — dry-run tool discovery (not persisted)
Used by the UI for live preview while editing a config.
```jsonc
// 200  { "count": 1, "tools": [ { "name": "echo", "description": "Echo back the provided text (test tool)", "inputSchema": { … } } ] }
// 400  { "error": "timed out after 10000ms waiting for tools/list" }
```
Statuses: `200` · `400`.

### GET /api/mcp — list registered servers
```jsonc
// 200
{ "servers": [ { "name": "inventory-echo", "description": "Echo test server", "tools_json": "[…JSON tool list…]", "created_at": "2026-10-11T17:55:09.639Z" } ] }
```
Statuses: `200` (empty registry → `"servers": []`).

### GET /api/mcp/:name — inspect one server (config + discovered tools)
```jsonc
// 200
{ "name": "inventory-echo", "description": "Echo test server", "config_json": "{\"type\":\"local\",…}", "tools": [ { "name": "echo", "description": "Echo back the provided text (test tool)", "inputSchema": { "type": "object", "properties": { "text": { … } }, "required": ["text"] } } ], "created_at": "…" }
// 404
{ "error": "mcp server not found: nope" }
```
Statuses: `200` · `404`.

### POST /api/mcp/:name/tools — re-probe a registered server
Connects live and refreshes the stored tool list.
```jsonc
// 200 — verified live
{ "name": "inventory-echo", "count": 1, "tools": [ { "name": "echo", "description": "Echo back the provided text (test tool)", "inputSchema": { … } } ] }
// 404 { "error": "mcp server not found: nope" }
// 400 { "error": "spawn failed: …" }   // server process gone or hung
```
Statuses: `200` · `400` · `404`.

### DELETE /api/mcp/:name — remove from the registry
```jsonc
// 200  { "deleted": true, "name": "inventory-echo" }
// 404  { "error": "mcp server not found: nope" }
```
Definitions still referencing a deleted name fail at run time with the missing-registry error above.
Statuses: `200` · `404`.

### MCP server implementations
MCP server processes (stdio scripts, HTTP/SSE endpoints) are **supplied by you** at the paths/URLs you declare — the repo ships none. Verified end to end previously with a request-driven echo stdio server: register-with-probe discovered its tool, and an agent using `mcp.use:["inventory-echo"]` returned `MCP-USE-OK` with `mcp.expand` recorded in its audit chain.

### MCP in definitions (inline, definition-driven runs)
For a self-contained agent, declare servers directly in the definition; the SDK session receives them as-is:

```jsonc
"mcp": {
  "servers": {
    "inventory-echo": { "type": "local", "command": "node", "args": ["./my-mcp-servers/echo.mjs"], "tools": ["*"], "timeoutMs": 10000 }
  }
}
```

### CLI (registry flows — same two flows from the command line)
```bash
npx tsx src/cli.ts mcp register --name inventory-echo \
  --config '{"type":"local","command":"node","args":["./my-mcp-servers/echo.mjs"],"tools":["*"]}' \
  --probe --db ./data/minion.db
# -> probed 1 tool(s): echo
# -> registered: inventory-echo — reference it from a definition with "mcp": { "use": ["inventory-echo"] }

npx tsx src/cli.ts mcp-list --db ./data/minion.db
```
CLI runs resolve `mcp.use` from the same `--db` registry; unknown refs exit code 3.

---

## 6. CLI reference

```
minion-assembler validate --agentDefinition <path>
minion-assembler run      --agentDefinition <path> [--task <text>] [--sessionId <id>] [--resume]
                          [--no-stream] [--output-format text|json] [--share <path>]
                          [--db <path>] [--yes]
minion-assembler serve    [--port <n>] [--db <path>]
minion-assembler list     [--db <path>]
minion-assembler show     <id> [--db <path>]
minion-assembler history  [--agentId <id>] [--db <path>]
```

`run` exit codes: `0` done · `2` validation · `3` runtime/auth · `4` permission (`approve-all-ci-only` without `--yes`).

Examples:
```bash
# one-shot with streaming deltas to stdout
LLM_API_KEY=… node dist/cli.js run --agentDefinition ./fixtures/mimo-smoke-test.agent.json

# override task + Markdown transcript + JSON for the pipeline
… run --agentDefinition ./my-agent.json --task "Summarize this repo" --share ./out/transcript.md --output-format json

# resume an existing conversation
… run --agentDefinition ./my-agent.json --sessionId sess_mv3uupeu_tw4p7e --resume --task "Now add tests"
```
CI: set `COPILOT_AUTO_UPDATE=false`; `--yes` is required for `approve-all-ci-only` (fails closed otherwise). Default policy `deny-all` allows nothing without an explicit pattern.

---

## 7. Agent definition JSON (schema v1.0)

Full schema: [`src/schema/agent-definition.schema.json`](src/schema/agent-definition.schema.json).

| Section | Key fields | Maps to (Copilot SDK) |
|---|---|---|
| `metadata` | `name`, `version`, `description?`, `tags?` | — (identity + audit join) |
| `persona` | `systemMessage.mode: append\|replace\|customize`, `.content`, `.sections{identity,preamble,tone,guidelines,safety,tool_instructions}`, `.acknowledgeReplaceRisks` | session `systemMessage` (replace drops SDK guardrails — must acknowledge) |
| `instructions` | `global[]`, `scoped[]{applyTo,body}`, `refreshDiscoveryCache` | injected into prompt + `refreshCustomInstructions` |
| `knowledge.workingDirectory` | `workingDirectory`, `additionalDirectories[]`, `attachments[]{type,path\|directory\|blob,…}`, `sessionStore` | session `workingDirectory`, `additionalDirectories`, message `attachments`, `enableSessionStore` |
| `agents[]` | `name`, `prompt` (specialist persona), `description`, `tools[]`, `infer`, `skills[]`, `model`, `reasoningEffort` | session `customAgents` |
| `defaultAgent` | one `agents[]` name | session `agent` |
| `skills` | `directories[]` — definition-declared folder references (absolute, or relative resolved against the session workspace, e.g. `workspace-fe/skills`), each containing `SKILL.md` files; `disabled[]` | `skillDirectories`, `disabledSkills` |
| `task` | `prompt`, `deliveryMode: enqueue\|immediate`, `attachments[]` | `session.send({prompt, mode, attachments})` |
| `tools` | `custom[]{name,description,parametersSchema}`, `available[]`, `excluded[]`, `permissionPolicy: deny-all\|approve-all-ci-only\|pattern-list`, `patterns[]{tool,decision,reason}` | `tools`, `availableTools`, `excludedTools`, `onPreToolUse`/`onPermissionRequest` (deny-by-default) |
| `mcp` | `servers{name:{type:local\|stdio\|http\|sse,command,args,env,cwd,url,headers,tools,timeoutMs}}`, `disabled[]` | session `mcpServers`, `disabledMcpServers` (secrets only as `${ENV_VAR}`) |
| `provider` | `type: openai\|azure\|anthropic`, `baseUrl`, `model`, `wireApi: completions\|responses`, `credentialEnv`, `azureApiVersion?` | BYOK `provider` + session `model` (credential resolved at run/resume time, never stored) |
| `runtime` | `streaming`, `sessionId`, `resume`, `idleTimeoutSecs`, `maxAiCredits` (SDK floor 30), `logLevel`, `clientInfo{}` | session/client options |

Minimal example:
```json
{
  "schemaVersion": "1.0",
  "metadata": { "name": "my-reviewer", "version": "1.0.0", "description": "PR reviewer" },
  "persona": { "systemMessage": { "mode": "append", "content": "You are a concise senior engineer. Cite file paths." } },
  "instructions": { "global": ["Prefer minimal diffs."] },
  "knowledge": { "workingDirectory": "./my-workspace" },
  "agents": [{ "name": "reviewer", "prompt": "Review code for security and test coverage.", "tools": ["grep","glob","view"], "infer": true }],
  "defaultAgent": "reviewer",
  "task": { "prompt": "Review the auth module.", "deliveryMode": "enqueue" },
  "tools": { "permissionPolicy": "pattern-list", "patterns": [{ "tool": "view", "decision": "allow" }] },
  "mcp": { "servers": {} },
  "provider": { "type": "openai", "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1", "model": "mimo-v2.6-flash", "wireApi": "completions", "credentialEnv": "LLM_API_KEY" },
  "runtime": { "streaming": true, "idleTimeoutSecs": 300, "maxAiCredits": 100 }
}
```

Bundled working fixtures:
- [`fixtures/mimo-smoke-test.agent.json`](fixtures/mimo-smoke-test.agent.json) — minimal smoke agent, verified live against Mimo `mimo-v2.6-flash`.
- [`fixtures/mimo-mcp-test.agent.json`](fixtures/mimo-mcp-test.agent.json) — agent referencing the MCP registry via `mcp.use` (needs `inventory-echo` registered first), verified live (`MCP-USE-OK`).

### Example: "UI Developer" agent (ready to try)
[`examples/ui-developer.agent.json`](examples/ui-developer.agent.json) — a **senior UI developer** agent persona with a `ui-builder` sub-agent (grep/glob/view/write/edit tools), scoped CSS instructions, `pattern-list` permissions, and a default task to build a responsive dark-theme dashboard. Verified live in ~72 s (453-line page: sticky top bar, 4-card stats grid, recent-orders table with status filters, aria-live feedback, two media-query breakpoints) — the artifact itself was removed in the lean-up; re-run the agent to regenerate it.

[`examples/expense-tracker-dev.agent.json`](examples/expense-tracker-dev.agent.json) — **front-end engineer** that builds a full Expense Tracker (add/delete expenses, summary cards, div-bar category chart, filters, localStorage persistence, dark theme, zero dependencies). Verified live in ~80 s (665-line page), fully audited in SQLite: 1 agent, 1 run (`done`), 82 events, 1 usage row, 1 transcript (SHA-256), 1 session (`idle-done`) all joined by `runId ↔ sessionId ↔ traceId ↔ definition_hash` — artifact removed in the lean-up; re-run to regenerate.

[`examples/fe-engineer.agent.json`](examples/fe-engineer.agent.json) — **senior SaaS front-end engineer** for marketing sites: ships single-file landing pages (sticky nav, hero, feature grid, waitlist form with client-side validation, dark theme + signature accent gradient, scroll-reveal, responsive 360/768/1440px, zero dependencies). Uses its own workspace `./workspace-fe` (definition-resolved). Task: builds the 'Nebula IQ' SaaS landing page at `./index.html`. Same design language works via CLI, API and UI.

```bash
LLM_API_KEY=… node dist/cli.js run --agentDefinition ./examples/ui-developer.agent.json   # uses the default task
# or assign your own task:
LLM_API_KEY=… node dist/cli.js run --agentDefinition ./examples/ui-developer.agent.json \
  --task "Rebuild the dashboard page from the previous run with a light theme and add a search box filtering by customer name"
```

> Tip: point `knowledge.workingDirectory` at the workspace (or an absolute path anywhere on disk) and let the agent create output subfolders there. Long build tasks stream live; multi-turn UI work takes 1–2 minutes (the runner waits up to 10 min per turn, far beyond the SDK's 60 s default).

---

## 8. Audit, traceability, and secrets

- `runId ↔ sessionId ↔ traceId ↔ definition_hash` join across all tables.
- Dual-write: human JSONL at `<workspace>/runs/<runId>/events.jsonl` **and** the SQLite `events` table, scrubbed of secret-looking values at write time.
- Structured **server audit log** at `<workspace>/.minion/server.log.jsonl` (per-HTTP-request in/out + status + ms, lifecycle events) — browse via `GET /api/logs` or the Dashboard log viewer.
- **Agent workspace** configurable: definition `knowledge.workingDirectory` > `MINION_WORKSPACE` env > cwd (§4.2); resolved root is reported in `GET /api/status` and recorded in each run's `run.start` event.
- Usage (tokens in/out, credits, duration, endpoint) from `assistant.usage`; transcripts hashed (SHA-256).
- Verify: `grep -c 'your-key' data/minion.db` and the run transcript paths printed by the runner → expect `0` (verified).

---

## 9. Tests

Live-verified this build: typecheck clean · **13/13 unit tests** · all UI screens `200` (`/` dashboard, `/ui`, `/ui/agents(/:id)`, `/ui/runs(/:id)`, `/ui/sessions(/:sid)`, `/ui/mcp(/:name)`, `/docs`, 404 pages) · Swagger + OpenAPI lists **24 API paths** (incl. `/api/sessions`, `/api/sessions/:sid`, `/api/metrics`, `/api/logs`) · validate endpoint `200/400` both proven · register by path `200` · unknown agent/run/server `404` messages · MCP register/probe/list/delete live-verified with the echo server · agent `mcp.use` run returned `MCP-USE-OK` with `mcp.expand` in the audit chain · dashboard metrics + audit-log viewer + workspace resolution all live-verified in the browser · **UI Developer example agent verified live (453-line dashboard, 72 s; workspace `workspace-et/`, skills reference `<workspace>/skills`)** · **FE Engineer example agent built [`workspace-fe/index.html`](workspace-fe/index.html) (890 lines) via CLI, API and interactive UI runs (`VERIFIED-OK` in UI mode; full tool-call/permission audit at `AUDIT_LEVEL=full`; artifact + skills live in `workspace-fe/`)** · Nebula IQ landing page browser-verified (0 external assets, no horizontal scroll at 360px, smooth scroll + IntersectionObserver).

### 9.1 Production hardening

- **Credentials are BYOK env-only**: definitions name `credentialEnv`; the runner resolves from process env (`.env` via dotenv). Keys never touch JSON, DB, transcripts or the audit log — `scrubSecrets` redacts secret-shaped values from every persisted event and log line.
- **Workspace confinement**: the runner always passes the absolutely-resolved workspace root to the SDK session, so agents cannot write outside their workspace even with relative `knowledge.workingDirectory` paths.
- **Ordered shutdown**: run teardown disconnects the session, then stops the client, releasing the spawned SDK child process even on `run.error`.
- **Fast-fail validation**: bad definitions, invalid AUDIT_LEVEL values, and missing credentials abort *before* any SDK session starts; errors persist as `run.error` events and a `failed` run row (auditable, not lost).
- **Timeout tiers**: generous 10-minute per-turn `sendAndWait` budget for multi-turn tool-using tasks; `AUDIT_LEVEL` env/flag controls event volume so full-verbosity runs don't flood storage.
- **Audit levels** (`AUDIT_LEVEL` env, `--audit-level` flag, or `auditLevel` API field): `minimal` keeps run lifecycle only; `default` adds tool calls/results + permission decisions; `full` adds reasoning, streaming deltas, and partial results.
- **Lean repo layout**: runtime code lives in `src/` (+ tests alongside), compiled output in flat `dist/`, agent definitions in `examples/` and `fixtures/`, SQLite in auto-created `data/minion.db`, and per-agent workspaces (`workspace-fe/`, `workspace-et/`) holding skills and artifacts — MCP servers and skill directories are declared inside definitions; there is no app-owned bundled MCP server or repo-root skills folder.

---

## 10. Database schema (SQLite v1)

| Table | Purpose |
|---|---|
| `agents` | `id (name@version)`, definition JSON, hash, timestamps |
| `runs` | agent, session, trace, status, model, provider, prompt, error |
| `events` | ordered per-run audit stream (`seq`, `type`, payload JSON, persisted flag) |
| `mcp_servers` | registry of MCP servers: name, config JSON, description, discovered tools JSON |
| `sessions` | SDK session registry: session ↔ run ↔ agent ↔ trace, status, final summary |
| `usage` | tokens in/out, credits, duration, endpoint, request id |
| `transcripts` | shared transcript path + SHA-256 |

Postgres ships as an interface-conformant stub ([`src/store/postgres-stub.ts`](src/store/postgres-stub.ts)); the swap is mechanical.

---

## 11. Known limitations

- **Postgres** = stub (SQLite-first scope).
- **Serve auth**: none beyond loopback; front with proxy + token before shared exposure.
- **`maxAiCredits`**: hard SDK floor of 30 (`Minimum session limit is 30 AI credits`).
- **Plugin file agents** (`agents/*.md`) not yet mapped — inline `agents[]` only.
- **MCP probes**: one-shot initialize→tools/list per call (no persistent connection); OAuth-protected remote servers will surface as probe errors rather than opening a browser flow.
- **Usage rows**: token counts arrive when the runtime emits token-level usage data; credits/duration are always recorded.
- **MCP test server**: strict request-driven protocol; a server that writes before its first request desyncs the CLI's stdio handshake (this is how the bundled echo server was debugged).
- **Redaction quirks**: values containing `key|token|secret` are masked in *display* responses (e.g. `baseUrl` may show `***`); stored runs keep the real value. Credential env var **names** (`LLM_API_KEY`) are fine and expected.
- **Windows note**: backgrounded `serve` may detach from its shell PID; stop via port→PID lookup (§4.3).
