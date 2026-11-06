# Minions Assembler

**Assemble, run and audit custom GitHub Copilot agents from versioned JSON — through one npm package, one server and one UI.**

Minions Assembler turns an agent definition (a small, reviewable JSON file) into a real, auditable coding worker. It gives you a browser cockpit, a REST API, a CLI for CI, and a GitLab pipeline mode — all backed by the same SQLite database, the same agent schema and the same execution engine. It also gives agents a persistent memory: a per-agent dataset, a shared platform dataset, a searchable code graph and a lessons loop that turns run outcomes into better future runs.

- **One artifact, one UI** — `npm pack` produces a single tarball. `minions-assembler serve` serves the React cockpit, the REST API and Swagger from the same process and port. The old server-rendered `/ui` pages were removed; there is one interface to learn, test and support.
- **One definition format** — schema v1.0, validated before anything runs.
- **One audit trail** — every run, tool call, permission decision, token count and memory event is recorded and queryable.
- **Four ways to work** — browser UI, REST API, CLI and GitLab CI.

---

## The problem it solves

Coding agents are easy to demo and hard to operate. A prompt in a chat box is not a product: it has no version history, no reproducible task definition, no audit trail, no permission model, no way to run in CI, and no memory beyond the current context window.

Minions Assembler makes the agent itself a versioned, testable artifact:

1. **Define** the agent once in JSON — provider, persona, instructions, tools, MCP servers, runtime limits, memory policy and task.
2. **Validate** it against the bundled schema before spending a token.
3. **Run** it headlessly from the UI, the API, the CLI or a pipeline.
4. **Audit** exactly what happened, including which tools ran and which secrets were never exposed.
5. **Improve** it: memory captures what worked and what failed, and recalls relevant lessons next time.

Typical uses:

- A repository of role agents (full-stack developer, reviewer, designer) that anyone on the team can run.
- Nightly CI builds where an agent implements a task and the pipeline verifies the generated app.
- A local cockpit for exploring projects, chatting with an agent and approving sensitive tool calls.
- A durable record of every agent run for compliance or debugging.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              minions-assembler               │
                    │                                              │
  Browser  ─────────▶  React SPA (dist/web)                       │
  curl     ─────────▶  Fastify REST API + Swagger (/docs)         │
  CLI      ─────────▶  same routes, same execution engine           │
  GitLab   ─────────▶  the installed npm package, run headless     │
                    │                                              │
                    │  Agents → validation → execution → audit     │
                    │         │                    │               │
                    │         ▼                    ▼               │
                    │   GitHub Copilot SDK    SQLite (WAL)         │
                    │   (BYOK provider)       runs · events ·      │
                    │                         memory · chats       │
                    │                                              │
                    │  Workspace: <root>/run_<id>/                 │
                    └──────────────────────────────────────────────┘
```

- **Composition root** — `src/server.ts` builds one Fastify app, one SQLite connection (plus a memory connection), one run queue, one chat engine and the shared services.
- **Execution** — `src/execution/runner.ts` runs headless definitions; `chat-runner.ts` runs one chat turn; `chat-engine.ts` manages background turns, approvals and streaming.
- **Storage** — `src/store/sqlite.ts` owns agents, runs, events, usage, sessions, chats, credentials and MCP registry rows. `src/store/platform.ts` owns providers, projects, settings, approvals and retention. `src/memory/sqlite-store.ts` owns the knowledge graph and datasets in the same database file.
- **UI** — `web/` is a Vite + React 19 + TypeScript SPA. `npm run build` emits `dist/web`; `src/http/web-static.ts` serves it with SPA fallback. No server-rendered UI ships in the package.
- **Security** — loopback host allow-list, Origin checks on state-changing requests, optional bearer token, loopback bind by default, encrypted provider credentials and MCP secrets.

---

## Quick start (5 minutes, no JSON)

Prerequisites: **Node.js 22.12+**, npm 10+. Java 17+ and Maven are only needed when an agent builds a Java project.

```bash
# 1. Install the package globally (or use npx)
npm install -g minions-assembler

# 2. Start the cockpit
minions-assembler serve --port 3100

# 3. Open the app
#    http://127.0.0.1:3100
```

On first launch:

1. **Settings → Providers** (or onboarding) → add a provider: a name, base URL, model and API key. The key is sealed in the encrypted credential vault and never returned by the API.
2. Pick **No project** for a folder-less chat, or open a project folder. The agent works inside that folder.
3. Choose an agent in the chat header and type a message. The default agent is the built-in GitHub Copilot agent.
4. For a one-off headless task, open **New run**, choose a registered agent or paste a definition, paste the task, and press **Start run**.

The server binds `127.0.0.1` by default. See [Security](#security-and-operations) before exposing it.

---

## One artifact: the npm package

The package is designed to be published and installed as one unit. Until the first `npm publish`, install the tarball directly with `npm install -g ./minions-assembler-1.0.0.tgz`; after that the `npm install -g minions-assembler` shown in the quick start works as written.

```bash
npm pack                      # builds dist/ + dist/web, then creates the tarball
npm install -g ./minions-assembler-1.0.0.tgz
minions-assembler --version    # 1.0.0
minions-assembler serve        # SPA + API + Swagger, one port
```

What `serve` exposes on a single origin:

| Path | What it is |
| --- | --- |
| `/` and SPA routes (`/chat`, `/agents`, `/runs`, `/dashboard`, `/settings`, …) | React cockpit |
| `/api/**` | REST API (see below) |
| `/docs` | Swagger UI |
| `/openapi.json` | OpenAPI document |

The tarball contains `dist/` (including the bundled web build in `dist/web`), the one example agent (`examples/full-stack-engineer.agent.json`), the acceptance record (`docs/UAT.md`), plus `README.md`, `LICENSE` and `package.json`, which npm always includes. It does **not** contain tests, source, `web/`, data, runs, CI scripts or local evidence. `prepack` runs the full build automatically, so `npm pack` always ships a UI that matches the server.

---

## The cockpit UI

The React app is organised around the work, not around CRUD tables:

- **Chat** — streaming replies, reasoning blocks, tool cards, inline approvals, Stop, model and agent pickers, project-aware workspace, thread pin/archive/rename/export.
- **Agents** — list, inspect, duplicate, edit and delete; the builder supports guided sections and a raw JSON view, validation, import/upload, drafts and test runs.
- **Runs** — explorer with filters, run detail with KPIs, event timeline, streamed chunks, definition snapshot, live stop, and links back to the chat thread.
- **Dashboard** — requests, success rate, tokens, credits, runs by model and a 24-hour timeline.
- **MCP registry** — add local/stdio/HTTP/SSE servers, probe tools, seal secrets, diagnose failures, delete.
- **Audit & logs** — search runs, inspect the event chain, download a bundle, view server logs.
- **Settings** — providers, defaults, chat approval mode, retention, audit level, onboarding.
- **API docs** — a readable tour of the endpoints with copy-paste examples.

Keyboard: `⌘K` / `Ctrl+K` opens the command palette. The layout is responsive down to phone width.

---

## The REST API

Every UI action is a public API call. The same endpoints work with `curl`, a script or another service. Interactive docs: `http://127.0.0.1:3100/docs`.

### Run an agent

```bash
# Register a definition
curl -sS -X POST http://127.0.0.1:3100/api/agents \
  -H 'content-type: application/json' \
  -d '{"definitionPath":"./examples/full-stack-engineer.agent.json"}'

# Execute it (blocks until the turn finishes)
curl -sS -X POST 'http://127.0.0.1:3100/api/agents/full-stack-engineer%401.0.0/runs' \
  -H 'content-type: application/json' \
  -d '{"taskOverride":"Build the feature described in TASK.md","approvalMode":"autopilot","turnTimeoutMs":7200000}'
```

The response is `{ runId, sessionId, traceId, text }`. The full event chain is available at `GET /api/runs/:id/events`.

### Inline definition (no registration)

```bash
curl -sS -X POST http://127.0.0.1:3100/api/agent-definitions/runs \
  -H 'content-type: application/json' \
  -d '{"definition": { ... }, "taskOverride": "Reply with exactly: OK"}'
```

The definition is validated, sealed and snapshotted onto the run.

### Chat

```bash
# Create a thread (no agentId = built-in Copilot agent)
curl -sS -X POST http://127.0.0.1:3100/api/chat/threads \
  -H 'content-type: application/json' -d '{"title":"My chat"}'

# Send a message (returns 202 immediately)
curl -sS -X POST http://127.0.0.1:3100/api/chat/threads/<threadId>/messages \
  -H 'content-type: application/json' -d '{"content":"Explain this repository"}'

# Follow the typed SSE stream
curl -N http://127.0.0.1:3100/api/chat/threads/<threadId>/events
```

### Everything else

| Group | Endpoints |
| --- | --- |
| System | `GET /api/status`, `/api/bootstrap`, `/api/logs`, `/api/metrics`, `/api/metrics/daily`, `/api/builtin-tools`, `/api/persona/default-system-prompt`, `/api/workspace/instruction-files`, `/api/fs/browse`, `/api/sessions`, `/api/sessions/:sid` |
| Agents | `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`, `POST /api/agents/validate`, `POST /api/agents/import`, `GET /api/agents/:id/definition`, `POST /api/agents/draft`, `GET /api/agents/drafts`, `POST /api/agents/elaborate`, `GET /api/templates/default`, `POST /api/templates/upload` |
| Runs | `POST /api/agents/:id/runs`, `POST /api/agent-definitions/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/definition`, `GET /api/runs/:id/events`, `GET /api/runs/:id/stream`, `POST /api/runs/:id/stop`, `GET /api/audit/runs`, `GET /api/audit/runs/:id/export` |
| Chat | `GET/POST /api/chat/threads`, `GET/PATCH/DELETE /api/chat/threads/:id`, `POST .../messages`, `POST .../cancel`, `GET .../events`, `GET .../stream`, `GET .../export`, `GET /api/chat/agents` |
| Platform | `GET/POST /api/providers`, `GET/PATCH/DELETE /api/providers/:id`, `POST /api/providers/:id/default`, `POST /api/providers/:id/test`, `GET /api/providers/models`, `GET /api/providers/:id/models`, `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `GET /api/projects/:id/agents`, `GET /api/settings`, `PATCH /api/settings`, `GET /api/approvals`, `POST /api/approvals/:id`, `GET /api/retention`, `POST /api/retention/purge`, `GET/POST /api/credentials`, `DELETE /api/credentials/:name` |
| MCP | `GET/POST /api/mcp`, `GET/DELETE /api/mcp/:name`, `POST /api/mcp/probe`, `POST /api/mcp/:name/tools`, `POST /api/mcp/oauth/start`, `GET /api/mcp/oauth/callback`, `GET /api/mcp/oauth/status` |
| Memory | `GET/PUT /api/memory/config`, `GET /api/memory/stats`, `/datasets`, `/graph`, `/nodes`, `/episodes`, `POST /api/memory/nodes`, `DELETE /api/memory/nodes/:id`, `POST /api/memory/search`, `POST /api/memory/lessons`, `POST /api/memory/index`, `/improve`, `/forget`, `/promote`, `/feedback` |

All errors are `{ "error": "…" }`. Validation failures add `fieldErrors`.

---

## The CLI

```bash
minions-assembler --help
```

### Validate

```bash
minions-assembler validate --agentDefinition ./my-agent.json
# -> valid: my-agent@1.0.0 (hash 91c2324af5158405)
# exit 0; 2 on schema/rule failure
```

### Run headlessly

```bash
MIMO_API_KEY=... minions-assembler run \
  --agentDefinition ./my-agent.json \
  --task "Build the service described in TASK.md" \
  --yes --no-stream --output-format json \
  --db ./data/minion.db
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--task <text>` | One-off task override |
| `--runDir <path>` | Explicit working directory (default `<workspace>/run_<id>`); useful for phase builds and resuming a folder |
| `--yes` | CI approval for approve-all policies (alias of `--approval autopilot`) |
| `--approval autopilot\|strict` | How `ask` decisions are answered in headless runs |
| `--no-stream` | Disable streamed deltas |
| `--output-format json` | Machine-readable result (`runId`, `sessionId`, `traceId`, `status`, `durationMs`, `text`) |
| `--audit-level minimal\|default\|full` | Audit verbosity |
| `--sessionId <id>` / `--resume` | Pin or resume an SDK session |
| `--share <path>` | Write a Markdown transcript |
| `--db <path>` | SQLite path (default `./data/minion.db`) |

Exit codes: **0** done · **2** validation · **3** runtime/provider · **4** permission.

### Chat from the terminal

```bash
minions-assembler chat create --agent full-stack-engineer@1.0.0 --title "Code review"
minions-assembler chat send --thread <threadId> --message "Review the diff"
minions-assembler chat read --thread <threadId>
```

### Memory

```bash
minions-assembler memory stats
minions-assembler memory search "flaky maven test"
minions-assembler memory lesson --text "Run mvn -q -B test before packaging" --trigger "maven package"
minions-assembler memory improve --dataset agent:full-stack-engineer
```

### Serve

```bash
minions-assembler serve --port 3100 --db ./data/minion.db
```

### Full command reference

| Command | What it does |
| --- | --- |
| `validate --agentDefinition <file>` | Schema + rule check, prints `name@version` and hash; exit 2 on failure. |
| `run --agentDefinition <file> [--task …]` | Headless run (see flags above). |
| `import-md --file <profile.agent.md> [--no-register]` | Map a Markdown agent profile (frontmatter + body) to schema v1.0 and optionally register it. |
| `list` / `show <id>` / `history [--agentId <id>]` | Registered agents, one agent's sealed definition, and run history, as JSON. |
| `chat create/list/send/read` | Persistent multi-turn threads against a registered agent. |
| `mcp register --name <n> --config <json\|path> [--probe]`, `mcp-list` | Register and inspect MCP servers without the UI. |
| `memory index/search/recall/stats/lesson/improve/promote/forget` | Build the code graph, query recall, record lessons and curate datasets. |
| `serve --port <n> --db <path>` | Cockpit + REST API + Swagger from one process. |

Every command accepts `--db <path>` and defaults to `./data/minion.db`, so the CLI and the server can share one database.

---

## GitLab CI mode

GitLab mode is not another server: it is the same npm artifact, installed globally inside a job and driven headlessly. The repository ships a working pipeline in [`.gitlab-ci.yml`](.gitlab-ci.yml):

| Stage | Job | What it proves |
| --- | --- | --- |
| `package` | `package` | `npm ci`, both typechecks, both test suites and `npm pack`; asserts the tarball contains `dist/web/index.html` and the example, and that no legacy `/ui` module leaked. Stores the `.tgz` as an artifact. |
| `generate` | `generate_backend` | Installs that exact tarball, Maven + JDK 17, validates the definition and runs Phase A ([`ci/tasks/backend.md`](ci/tasks/backend.md)) with `--runDir app`. |
| `generate` | `generate_frontend` | Runs Phase B ([`ci/tasks/frontend.md`](ci/tasks/frontend.md)) into the same `app/` workspace after Phase A. |
| `verify` | `app_check` | Boots the generated Spring Boot jar and the generated Next.js production build, then [`ci/verify-app.mjs`](ci/verify-app.mjs) drives catalog, cart, checkout and admin flows in Chromium and writes `reports/`. |
| `cockpit` | `cockpit_check` | Installs the same tarball, serves the cockpit, asserts `/ui/**` is 404 and runs [`ci/cockpit-smoke.mjs`](ci/cockpit-smoke.mjs) through Chromium. |

Requirements:

- A masked CI variable `MIMO_API_KEY` (or whatever key your definition references).
- The `package` job is the only place that builds the artifact; every later job installs `./minions-assembler-1.0.0.tgz`. Never rebuild per job.
- The runner needs Docker, disk for Maven/npm and a Chromium download. `playwright-core` is already a dev dependency; CI installs Chromium with `npx playwright install --with-deps chromium`.
- This is the same four-mode contract as local use: UI, API, CLI and pipeline all execute one artifact.

Minimal standalone job, if you only want the agent (no verification):

```yaml
agent:
  image: node:22-bookworm
  timeout: 2h
  before_script:
    - apt-get update -qq && apt-get install -y -qq maven openjdk-17-jdk-headless
    - npm install -g ./minions-assembler-1.0.0.tgz
  script:
    - minions-assembler validate --agentDefinition examples/full-stack-engineer.agent.json
    - minions-assembler run --agentDefinition examples/full-stack-engineer.agent.json
        --task "$(cat task.md)" --runDir ./app --yes --no-stream --output-format json
        --db ./data/minion.db | tee reports/run.json
  artifacts:
    when: always
    paths: [app/, reports/]
```

`--yes`, `--no-stream` and `--output-format json` make the run non-interactive and machine-readable; `--runDir` lets a later job reuse the same tree.

## Agent definitions (schema v1.0)

A definition is a single JSON file. The bundled schema lives in `src/schema/agent-definition.schema.json`; the CLI and API validate against it. The one shipped example is [`examples/full-stack-engineer.agent.json`](examples/full-stack-engineer.agent.json).

```jsonc
{
  "schemaVersion": "1.0",
  "metadata": { "name": "my-agent", "version": "1.0.0", "description": "…", "tags": [], "color": "#4f7df3" },
  "persona": {
    "useCopilotDefaultPrompt": true,
    "systemMessage": { "mode": "append", "content": "You are…" }
  },
  "instructions": {
    "global": ["…"],
    "scoped": [{ "applyTo": "src/**/*.ts", "body": "…" }],
    "agentsMdPaths": ["AGENTS.md"]
  },
  "knowledge": { "workingDirectory": ".", "additionalDirectories": [], "sessionStore": false },
  "agents": [{ "name": "reviewer", "prompt": "…", "tools": ["read", "grep"], "infer": true }],
  "skills": { "directories": [], "disabled": [] },
  "task": { "prompt": "…", "deliveryMode": "enqueue" },
  "tools": {
    "permissionPolicy": "pattern-list",
    "builtins": { "default": "allow", "all": true },
    "harness": true,
    "allowDestructive": false,
    "patterns": [{ "tool": "bash", "decision": "allow" }]
  },
  "mcp": { "servers": {}, "use": [] },
  "memory": {
    "enabled": true,
    "scope": { "agent": true, "platform": true, "crossAgentRead": false, "writeTarget": "agent" },
    "recall": { "enabled": true, "k": 12, "hops": 1, "maxChars": 6000, "includeFacts": true },
    "codeGraph": { "enabled": true, "autoRefresh": true, "root": ".", "symbols": true, "maxFiles": 4000 },
    "capture": { "episodes": true, "toolFailures": true, "commands": true },
    "distill": "heuristic"
  },
  "provider": {
    "type": "openai",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.6-flash",
    "wireApi": "completions",
    "providerApiKey": "${MIMO_API_KEY}"
  },
  "runtime": {
    "streaming": false,
    "turnTimeoutMs": 7200000,
    "maxAiCredits": 2000,
    "logLevel": "info",
    "clientInfo": { "applicationName": "minions-assembler", "applicationVersion": "1.0.0" }
  }
}
```

### Provider modes

- **Inline key** — `provider.providerApiKey` may be a literal (sealed to `enc:v1:` on save), a `${ENV_VAR}` reference (resolved at run time, portable across machines) or an `enc:v1:` token.
- **Settings provider** — set `provider.providerRef` to a provider id from **Settings → Providers**. The key stays in the vault; the definition stays portable. The same provider can be used by chat and headless runs.
- `wireApi` is `completions` for OpenAI-compatible endpoints (Mimo, OpenRouter, …) or `responses` where supported.

### Permissions

`tools.permissionPolicy` is `deny-all`, `approve-all-ci-only` or `pattern-list`. `pattern-list` evaluates `tools.patterns` first, then `tools.builtins.default`. The destructive gate always applies, regardless of policy. In headless runs, `--approval autopilot` auto-approves `ask` decisions (still subject to the destructive gate), `strict` denies them, and the default keeps the legacy deferred-deny.

### Harness tools

With `tools.harness: true` the agent gets a small, confined coding harness: `bash`, `read`, `write`, `create`, `edit`, `glob`, `grep` and `ls`. All paths are confined to the run workspace. Every tool call is audited.

### MCP

Register servers in the MCP page or with `POST /api/mcp`; reference them from a definition with `mcp.use: ["name"]`. Literal secrets in `env`/`headers` are sealed before storage; `${ENV_VAR}` references stay portable. Probing a server lists its tools and can diagnose a broken command.

---

## Memory: working context vs long-term knowledge

The agent keeps two different kinds of memory, on purpose.

**Working memory** is the SDK session: the conversation for the current chat thread or run. It is scoped to that session and is how the agent follows a multi-turn task. It is not the same as long-term memory.

**Long-term memory** is a SQLite knowledge graph shared across runs:

- **Datasets** — `agent:<name>` for one agent's lessons/facts, and `platform` for knowledge shared by every agent. A definition chooses `scope.agent`, `scope.platform`, `crossAgentRead` and `writeTarget`.
- **Nodes and edges** — files, symbols, facts, lessons, tasks and runs, with typed edges (imports, defines, recalls, follows, …). The code graph is refreshed automatically from the workspace.
- **Episodes** — one record per run: task, outcome, tools, errors, commands and summary. Successful and failed runs both teach.
- **Lessons** — distilled, searchable rules ("run the tests before packaging"). They can be linked to triggers and recalled by lexical similarity.
- **Recall** — before a run starts, the engine searches the agent + platform datasets, expands one hop through the graph and injects a bounded context block (default 6000 chars). It emits `memory.injected` / `memory.recalled` events so you can see exactly what was used.
- **Capture** — during and after a run it notes tool failures, commands, errors and the final summary, then writes an episode and optionally distills lessons.
- **Curation** — `verify`, `promote`, `forget`, `feedback` and `improve` endpoints/commands let a human (or a judge) correct the graph. Nothing deletes tables; `forget` deletes rows.

Embeddings are optional and disabled by default. Retrieval is lexical and deterministic, so it works offline and has no hidden API cost. The interface is ready for an embedding provider when you want semantic recall.

Inspect it:

```bash
minions-assembler memory stats
minions-assembler memory search "postgres migration"
curl -sS 'http://127.0.0.1:3100/api/memory/graph?dataset=agent:full-stack-engineer'
```

or `GET /api/memory/stats`, `/api/memory/graph`, `/api/memory/lessons`.

---

## Security and operations

- **Bind** — the server binds `127.0.0.1` by default. Do not expose it directly to a network.
- **Host allow-list** — `Host`/`Origin` must be loopback unless listed in `MINION_ALLOWED_HOSTS` (comma-separated). This defeats DNS rebinding and cross-site posts.
- **Origin check** — state-changing requests with an `Origin` header must match an allowed host/port. CLI/curl without `Origin` are unaffected.
- **Bearer token** — set `MINION_API_TOKEN` to require `Authorization: Bearer <token>` on every `/api/*` request (the SPA does not send it; use it behind a proxy or for API-only deployments).
- **Credentials** — provider keys and MCP secrets are AES-256-GCM encrypted at rest (`enc:v1:`), never returned by list endpoints, and redacted from logs and definition exports. `${ENV_VAR}` refs are resolved only at run time.
- **Approvals** — sensitive tool calls can wait for a human in chat; headless runs use `autopilot`/`strict` or the deferred-deny default. The destructive gate is not configurable away.
- **Retention** — configure days/scope in Settings. Pinned chats and running runs are preserved. Audit logs live outside project folders (`<db dir>/audit` by default) so purging a project cannot delete them.
- **Workspaces** — every headless run gets `<workspace>/run_<id>` (or `--runDir`), so one run cannot overwrite another. Run output is never committed by the server.

### Environment variables

| Variable | Effect |
| --- | --- |
| `MINION_WORKSPACE` | Default working root for runs and chats when the definition sets no `knowledge.workingDirectory` (default: the process cwd). |
| `MINIONS_DATA_DIR` | Directory holding the credential master key (`./data` by default). Point it at a persisted volume or sealed provider keys cannot be decrypted after a redeploy. |
| `MINION_API_TOKEN` | Require `Authorization: Bearer <token>` on every `/api/*` request. |
| `MINION_ALLOWED_HOSTS` | Comma-separated extra host/port pairs accepted by the Host and Origin guards. |
| `MINION_CHAT_CONCURRENCY` | Concurrent chat turns (default `3`). |
| `RUN_TURN_TIMEOUT_MS` | Default per-turn budget when neither the API body nor `runtime.turnTimeoutMs` sets one (default 45 min). |
| `AUDIT_LEVEL` | Default audit verbosity: `minimal`, `default` or `full`. |
| `PORT` | Port used by `serve` when `--port` is omitted (default `3100`). |
| `MIMO_API_KEY` (or any name you reference) | Resolved from the definition as `${MIMO_API_KEY}` at run time. The value is never stored in the database. |

Operations:

```bash
# health and version
curl -sS http://127.0.0.1:3100/api/status

# audit log (JSONL)
tail -f .minion/server.log.jsonl

# stop a live run
curl -sS -X POST http://127.0.0.1:3100/api/runs/<runId>/stop
```

---

## Development

```bash
npm install                 # server dependencies
npm --prefix web install    # UI dependencies
npm run typecheck           # server TypeScript
npm run typecheck:web       # UI TypeScript
npm test                    # server suites (Vitest)
npm run test:web            # UI suite
npm run build               # dist + dist/web
npm run dev:serve           # server from source
npm run dev:web             # Vite dev server (proxy to 3100)
```

Layout:

```
src/
  agents/        definitions, loading/validation, persona/session translation,
                 tools policy, harness, permissions, default agents, MCP glue
  core/          types, audit log, crypto, workspace, run queue, package info
  execution/     headless runner, chat runner/engine/hub, approvals, retention,
                 usage proxy
  http/          Fastify route groups (system, agents, runs, mcp, chat,
                 platform, memory), security, static SPA serving
  mcp/           MCP client/probe/OAuth
  memory/        schema, store, code graph, recall, capture, lessons, tools
  store/         SQLite adapter, migrations, platform store
  schema/        agent-definition.schema.json
web/             Vite + React + TypeScript cockpit
tests/           Vitest suites
examples/        the one shipping example definition
```

---

## Testing and publishing

```bash
npm run typecheck && npm run typecheck:web
npm test && npm run test:web
npm run build
npm pack --dry-run            # inspect the exact tarball contents
npm pack                      # build is run by prepack
npm publish --access public   # publish the single artifact (when you are ready)
```

Only the root package is published. `web/package.json` is `private`, and the root `files`
whitelist ships `dist/` (including `dist/web`), the one example definition and `docs/UAT.md`.
There is no second package and no separate UI artifact to keep in sync.

Release checklist:

```bash
# 1. clean tree, correct version
node -p "require('./package.json').name + '@' + require('./package.json').version"

# 2. full verification
npm ci && npm --prefix web ci
npm run typecheck && npm run typecheck:web
npm test && npm run test:web

# 3. inspect exactly what will be published (prepack builds first)
npm pack --dry-run

# 4. publish the single artifact, then tag the release
npm publish --access public
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION" && git push origin "v$VERSION"

# 5. prove the published package, not the working tree
npx --yes minions-assembler@$VERSION --version
```

`npm publish` runs `prepack`, so the published `dist/` always matches the version in
`package.json`. Requires an authenticated npm account with publish rights to the package name.

### Verified acceptance

All four execution modes were exercised end to end against the generated three-tier
Northwind Outfitters app (Spring Boot + H2 + Next.js App Router): the browser cockpit,
the REST API, the packaged CLI and a real GitLab pipeline. The full matrix, run IDs,
repairs and evidence paths are in [`docs/UAT.md`](docs/UAT.md). Summary:

| Mode | Result |
| --- | --- |
| Cockpit (real Chromium, 25 flows) | PASS 25/25 |
| CLI generation + independent verifier | PASS, 0 required failures |
| REST API generation + verifier | PASS, 0 required failures |
| UI generation (browser-driven) + verifier | PASS, 0 required failures |
| GitLab pipeline `3032134135` (package, two generate jobs, app check, cockpit check) | PASS — every job green; 72/72 verifier checks on the first attempt and 11/11 cockpit checks, no repair round |
| Installed npm tarball (CLI + server UI + API) | PASS — `PACKAGED_OK`, `API_PACKAGED_OK`, `UI_PACKAGED_OK` from the final rebuilt tarball |

The release contract checked by the suite:

- no destructive schema migrations; old databases upgrade forward;
- event payloads stay valid JSON under truncation;
- run rows never leak the definition snapshot; the snapshot is available at `/api/runs/:id/definition`;
- stored definitions are hydrated and sealed on every execution path;
- the retired `/ui` surface stays a 404 (it is not in the package); Swagger still works next to the SPA;
- the npm tarball contains `dist/web` and one example, with no tests/data/runs.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Web app not built` at `/` | Run `npm run build` (or install the npm package, which includes `dist/web`). |
| `No model provider is configured` | Add a provider in Settings and make it the default. |
| Provider 401 | Re-enter the key; check `baseUrl`, `wireApi` and model name. `providerRef` agents resolve the key from Settings at run time. |
| `agent not found: name@version` | Register/import the definition first, or use the inline-run endpoint. |
| Run hangs | Check the provider status and the run's event timeline. Increase `turnTimeoutMs` for large builds; use **Stop** to abort. |
| `EADDRINUSE` | Choose another `--port`. |
| MCP probe fails | Verify the command/URL and secrets; use the probe diagnostics. |
| Database locked | One server process per database file. WAL allows readers, not two writers. |
| Windows `ENOENT` for a command | Use Git Bash or install the tool on `PATH`; the agent harness inherits the server environment. |

---

## Known limitations

- One server process should own one SQLite database file; there is no multi-writer lock.
- Long-running builds are bounded by `runtime.turnTimeoutMs` (default 45 minutes; the example uses 2 hours).
- Embedding-based recall is optional and not enabled by default.
- The admin surface in generated demo apps is intentionally unauthenticated unless the app itself adds auth.
- GitLab jobs are capped by the project's job timeout; split very large builds into phases (the reference pipeline ships with backend/frontend phases and `--runDir` reuse).

---

## License

MIT — see [LICENSE](LICENSE).
