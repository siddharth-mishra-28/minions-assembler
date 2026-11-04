#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadAgentDefinition, redactedForLog, hydrateAgentDefinition } from './agents/loader.js';
import { sealDefinitionSecrets } from './agents/provider-keys.js';
import { executeRun } from './execution/runner.js';
import { SqliteAdapter } from './store/sqlite.js';
import { startServer } from './serve.js';
import { openMemoryStore } from './memory/sqlite-store.js';
import { createMemoryRuntime } from './memory/runtime.js';
import { loadPlatformDefaults, resolveMemoryConfig, savePlatformDefaults } from './memory/config.js';
import { indexCodeGraph } from './memory/code-index.js';
import { improve } from './memory/lessons.js';
import { recall } from './memory/retrieve.js';
import { PLATFORM_DATASET } from './memory/config.js';
import { slug } from './memory/text.js';

const program = new Command();
program.name('minions-assembler').description('Minions Assembler — Custom GitHub Copilot agents: JSON definitions, CI runs, serve mode').version('1.0.0');

program.command('validate')
  .requiredOption('--agentDefinition <path>', 'Path to agent definition JSON')
  .action((opts) => {
    try {
      const { definition, warnings, definitionHash } = loadAgentDefinition(opts.agentDefinition);
      console.log(`valid: ${definition.metadata.name}@${definition.metadata.version} (hash ${definitionHash})`);
      for (const w of warnings) console.warn(`warning: ${w}`);
    } catch (e) {
      console.error(`invalid: ${(e as Error).message}`);
      process.exit(2);
    }
  });

program.command('run')
  .requiredOption('--agentDefinition <path>', 'Path to agent definition JSON')
  .option('--task <text>', 'Override task prompt')
  .option('--sessionId <id>', 'Resume/pin session id')
  .option('--resume', 'Resume existing session id')
  .option('--no-stream', 'Disable streaming delta output')
  .option('--output-format <fmt>', 'text|json', 'text')
  .option('--share <path>', 'Write Markdown transcript after completion')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .option('--runDir <path>', 'Explicit working directory for this run (default: <workspace>/run_<id>); useful for phase builds')
  .option('--yes', 'Explicit CI approval for approve-all-ci-only policies (alias of --approval autopilot)')
  .option('--approval <mode>', 'Headless approval mode: autopilot (auto-approve every ask) | strict (deny every ask)')
  .option('--audit-level <level>', 'Audit verbosity: minimal|default|full (falls back to AUDIT_LEVEL env, then default)')
  .action(async (opts) => {
    const started = Date.now();
    try {
      const { definition: portable, resolved: definition, warnings } = loadAgentDefinition(opts.agentDefinition);
      for (const w of warnings) console.warn(`warning: ${w}`);
      if (opts.approval && !['autopilot', 'strict'].includes(opts.approval)) throw new Error("--approval must be autopilot or strict (got '${opts.approval}')");
      const approval = (opts.approval as 'autopilot' | 'strict' | undefined) ?? (opts.yes ? 'autopilot' : undefined);
      // Same storage contract as POST /api/agents: seal literal secrets, keep ${ENV}
      // refs portable, and snapshot the sealed form onto the run.
      const sealed = sealDefinitionSecrets(portable);
      const sealedHash = createHash('sha256').update(JSON.stringify(sealed)).digest('hex').slice(0, 16);
      const portableJson = JSON.stringify(sealed);
      const db = new SqliteAdapter(opts.db);
      const memoryStore = openMemoryStore(opts.db);
      const agentId = db.saveAgent(sealed.metadata.name, sealed.metadata.version, portableJson, sealedHash);
      const memoryConfig = resolveMemoryConfig(memoryStore, definition);
      const memory = memoryConfig.enabled
        ? createMemoryRuntime({
            store: memoryStore, config: memoryConfig, definition, agentId,
            task: opts.task ?? definition.task.prompt, sessionId: opts.sessionId,
          })
        : undefined;
      // Wire the MCP registry so mcp.use refs resolve in CLI runs too
      let mcpRegistry: Map<string, import('./mcp/mcp.js').McpServerConfig> | undefined;
      let mcpRegistryTools: Map<string, string[]> | undefined;
      if (definition.mcp?.use?.length) {
        const registry = new Map<string, import('./mcp/mcp.js').McpServerConfig>();
        const tools = new Map<string, string[]>();
        for (const row of db.listMcpServers()) {
          try {
            registry.set(row.name, JSON.parse((db.getMcpServer(row.name) as { config_json: string }).config_json));
            const tj = row.tools_json ? JSON.parse(row.tools_json) as { name: string }[] : [];
            tools.set(row.name, tj.map((t) => t.name));
          } catch { /* skip malformed rows */ }
        }
        mcpRegistry = registry; mcpRegistryTools = tools;
      }
      mkdirSync('./runs', { recursive: true });
      let streamed = '';
      const result = await executeRun({
        definition, agentId, definitionHash: sealedHash, definitionSnapshot: portableJson, db,
        runDir: opts.runDir ? resolve(opts.runDir) : undefined,
        taskOverride: opts.task,
        ciApproveAll: Boolean(opts.yes),
        approvalMode: approval,
        auditLevel: (opts.auditLevel as 'minimal' | 'default' | 'full' | undefined) || undefined,
        resumeSessionId: opts.sessionId,
        streamOut: opts.stream === false ? undefined : (t) => { streamed += t; process.stdout.write(t); },
        mcpRegistry, mcpRegistryTools,
        memory,
      });
      if (opts.stream !== false && streamed && !result.text.startsWith(streamed.slice(0, 50))) process.stdout.write('\n');
      if (opts.share) {
        writeFileSync(opts.share, `# ${definition.metadata.name} — ${result.runId}\n\ntrace: ${result.traceId}\nsession: ${result.sessionId}\n\n---\n\n${result.text}\n`);
        try {
          const sha = createHash('sha256').update(result.text).digest('hex');
          (db as SqliteAdapter).saveTranscript(result.runId, opts.share, sha);
        } catch { /* noop */ }
      }
      const durationMs = Date.now() - started;
      if (opts.outputFormat === 'json') {
        console.log(JSON.stringify({ runId: result.runId, sessionId: result.sessionId, traceId: result.traceId, agentId, status: 'done', durationMs, text: result.text }));
      } else {
        if (opts.stream === false) console.log(result.text);
        console.error(`\ndone: ${result.runId} trace=${result.traceId} session=${result.sessionId} (${durationMs}ms)`);
      }
      db.close();
      memoryStore.close();
    } catch (e) {
      const msg = (e as Error).message;
      if (/Schema|Duplicate|defaultAgent|acknowledgeReplaceRisks|Invalid JSON/i.test(msg)) { console.error(`validation error: ${msg}`); process.exit(2); }
      if (/permission|approve-all/i.test(msg)) { console.error(`permission error: ${msg}`); process.exit(4); }
      console.error(`runtime error: ${msg}`);
      process.exit(3);
    }
  });

program.command('import-md')
  .description('Import a markdown agent profile (.agent.md frontmatter + prompt body) and register it as a regular agent')
  .requiredOption('--file <path>', 'Path to the .agent.md / .md profile')
  .option('--no-register', 'Only print the mapped definition JSON without saving')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts: { file: string; register: boolean; db: string }) => {
    try {
      const { loadAgentMarkdown } = await import('./agents/md-profile.js');
      const { validateDefinitionObject } = await import('./agents/loader.js');
      const { definition, profile } = loadAgentMarkdown(opts.file);
      const validated = validateDefinitionObject(definition);
      const defJson = JSON.stringify(validated.definition, null, 2);
      if (!opts.register) { console.log(defJson); return; }
      const sealed = sealDefinitionSecrets(validated.definition);
      const hash = createHash('sha256').update(JSON.stringify(sealed)).digest('hex').slice(0, 16);
      const db = new SqliteAdapter(opts.db);
      try {
        const id = db.saveAgent(sealed.metadata.name, sealed.metadata.version, JSON.stringify(sealed), hash);
        console.log(`imported: ${id} (hash ${hash}) from markdown profile "${profile.name}" — runs on the default Copilot system prompt`);
        for (const w of validated.warnings) console.warn(`warning: ${w}`);
      } finally { db.close(); }
    } catch (e) {
      console.error(`import failed: ${(e as Error).message}`);
      process.exit(2);
    }
  });

program.command('mcp')
  .description('MCP registry operations')
  .command('register')
  .requiredOption('--name <name>', 'Registry key (referenced by definitions via mcp.use)')
  .requiredOption('--config <jsonOrPath>', 'Config JSON string or path to a JSON file')
  .option('--description <text>')
  .option('--probe', 'Connect now and store the discovered tool list')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts: { name: string; config: string; description?: string; probe?: boolean; db: string }) => {
    const { validateMcpConfig, probeMcpTools } = await import('./mcp/mcp.js');
    let raw: string;
    try { raw = (await import('node:fs').then((fs) => fs.readFileSync(opts.config, 'utf8'))).trim(); } catch { raw = opts.config; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) { console.error(`config is not valid JSON: ${(e as Error).message}`); process.exit(2); }
    const db = new SqliteAdapter(opts.db);
    try {
      const { config } = await validateMcpConfig(parsed);
      let toolsJson: string | undefined;
      if (opts.probe) {
        const tools = await probeMcpTools(config);
        toolsJson = JSON.stringify(tools);
        db.updateMcpServerTools(opts.name, toolsJson);
        console.log(`probed ${tools.length} tool(s): ${tools.map((t: { name: string }) => t.name).join(', ')}`);
      }
      db.saveMcpServer({ name: opts.name, config_json: JSON.stringify(config), description: opts.description, tools_json: toolsJson });
      console.log(`registered: ${opts.name} — reference it from a definition with "mcp": { "use": ["${opts.name}"] }`);
    } catch (e) {
      console.error(`register failed: ${(e as Error).message}`); process.exit(3);
    } finally { db.close(); }
  });

program.command('mcp-list')
  .description('List registered MCP servers')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts: { db: string }) => {
    const { SqliteAdapter } = await import('./store/sqlite.js');
    const db = new SqliteAdapter(opts.db);
    console.log(JSON.stringify(db.listMcpServers(), null, 2));
    db.close();
  });

program.command('serve')
  .option('--port <n>', 'Port', '3100')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts) => {
    await startServer(Number(opts.port), opts.db);
    console.log(`minions-assembler serve on http://127.0.0.1:${opts.port} (docs: /docs)`);
  });

program.command('list').option('--db <path>', 'SQLite path', './data/minion.db').action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listAgents(), null, 2));
  db.close();
});

program.command('show').argument('<id>').option('--db <path>', 'SQLite path', './data/minion.db').action((id, opts) => {
  const db = new SqliteAdapter(opts.db);
  const agent = db.getAgent(id);
  console.log(agent ? JSON.stringify({ ...agent, definition: redactedForLog(JSON.parse((agent as { definition_json: string }).definition_json)) }, null, 2) : 'not found');
  db.close();
});

program.command('history').option('--agentId <id>').option('--db <path>', 'SQLite path', './data/minion.db').action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listRuns(opts.agentId), null, 2));
  db.close();
});

// ---------- chat: persistent threads with registered agents (multi-turn) ----------
const chat = program.command('chat').description('Chat threads with registered agents (persistent multi-turn sessions)');
chat.command('create')
  .requiredOption('--agent <id>', 'Registered agent id (name@version)')
  .option('--title <text>', 'Optional thread title')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts) => {
    const db = new SqliteAdapter(opts.db);
    if (!db.getAgent(opts.agent)) { console.error(`agent not found: ${opts.agent}`); process.exitCode = 2; db.close(); return; }
    const id = db.createChatThread({ title: opts.title || `Chat with ${opts.agent}`, agentId: opts.agent, sessionId: null });
    console.log(JSON.stringify({ threadId: id, agentId: opts.agent, title: opts.title || `Chat with ${opts.agent}` }));
    db.close();
  });
chat.command('list').option('--db <path>', 'SQLite path', './data/minion.db').action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listChatThreads(), null, 2));
  db.close();
});
chat.command('send')
  .requiredOption('--thread <id>', 'Thread id from `chat create`')
  .requiredOption('--message <text>', 'User message for this turn')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .option('--timeout-ms <n>', 'Per-turn budget in ms', '2700000')
  .action(async (opts) => {
    const db = new SqliteAdapter(opts.db);
    const t = db.getChatThread(opts.thread);
    if (!t) { console.error(`chat thread not found: ${opts.thread}`); process.exitCode = 2; db.close(); return; }
    const agentId = t.agent_id as string | null;
    if (!agentId) { console.error('thread has no fixed agent — use chat send with an @mention to route a general thread'); process.exitCode = 2; db.close(); return; }
    const row = db.getAgent(agentId);
    if (!row) { console.error(`agent not found: ${agentId}`); process.exitCode = 2; db.close(); return; }
    const hydrated = hydrateAgentDefinition(row.definition_json as string);
    const def = hydrated.resolved;
    const { executeChatTurn } = await import('./execution/chat-runner.js');
    const { join } = await import('node:path');
    const threadDir = resolve(`./.chats/${opts.thread}`);
    mkdirSync(threadDir, { recursive: true });
    const userMessageId = db.addChatMessage(opts.thread, { role: 'user', author: 'user', content: opts.message });
    const memoryStore = openMemoryStore(opts.db);
    const memoryConfig = resolveMemoryConfig(memoryStore, def);
    const memory = memoryConfig.enabled
      ? createMemoryRuntime({
          store: memoryStore, config: memoryConfig, definition: def, agentId,
          task: opts.message, threadId: opts.thread,
        })
      : undefined;
    try {
      const turn = await executeChatTurn({
        definition: def, agentId, db,
        definitionHash: (row.definition_hash as string | null) || hydrated.definitionHash,
        definitionSnapshot: row.definition_json as string,
        sessionId: (t.session_id as string | null) ?? undefined,
        sessionIdPrefix: 'chat',
        content: opts.message,
        workingDirectory: threadDir,
        turnTimeoutMs: Number(opts.timeoutMs),
        memory,
      });
      db.updateChatThread(opts.thread, { sessionId: turn.sessionId });
      const replyMessageId = db.addChatMessage(opts.thread, { role: 'assistant', author: agentId, content: turn.text, runId: turn.runId });
      console.log(JSON.stringify({ userMessageId, replyMessageId, runId: turn.runId, agentId, text: turn.text }, null, 2));
    } catch (e) {
      console.error(`chat turn failed: ${(e as Error).message}`);
      process.exitCode = 3;
    } finally { db.close(); memoryStore.close(); }
  });
chat.command('read').requiredOption('--thread <id>').option('--db <path>', 'SQLite path', './data/minion.db').action((opts) => {
  const db = new SqliteAdapter(opts.db);
  const t = db.getChatThread(opts.thread);
  if (!t) { console.error(`chat thread not found: ${opts.thread}`); process.exitCode = 2; db.close(); return; }
  console.log(JSON.stringify({ ...t, messages: db.getChatMessages(opts.thread) }, null, 2));
  db.close();
});

// ---------------- memory ----------------
const memory = program.command('memory').description('Long-term memory: code graph, learned lessons, platform config (same SQLite db)');

memory.command('index')
  .description('Build/refresh the code graph (incremental; symbols + imports + tests)')
  .option('--root <path>', 'Root to index (default: platform codeGraph.root, or the workspace)')
  .option('--dataset <id>', 'Dataset to write into', PLATFORM_DATASET)
  .option('--no-symbols', 'Index files/imports only (skip symbol extraction)')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { root?: string; dataset: string; symbols: boolean; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const cfg = loadPlatformDefaults(store);
      const started = Date.now();
      const result = indexCodeGraph(store, {
        root: resolve(opts.root ?? cfg.codeGraph.root ?? '.'),
        dataset: opts.dataset,
        include: cfg.codeGraph.include,
        exclude: cfg.codeGraph.exclude,
        maxFiles: cfg.codeGraph.maxFiles,
        symbols: opts.symbols !== false,
        removeStale: true,
      });
      console.log(`indexed ${result.files} files, ${result.symbols} symbols, ${result.edges} edges`
        + `${result.removed ? `, removed ${result.removed} stale` : ''} in ${Date.now() - started}ms`
        + `${result.truncated ? ' (truncated: caps reached)' : ''}`);
    } finally { store.close(); }
  });

memory.command('search <query>')
  .description('Recall from memory (lexical seeds + graph expansion)')
  .option('--dataset <ids>', 'Comma-separated datasets (default: all)')
  .option('--k <n>', 'Max seed nodes', '8')
  .option('--hops <n>', 'Graph expansion depth', '1')
  .option('--json', 'Print JSON instead of the rendered block')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (query: string, opts: { dataset?: string; k: string; hops: string; json?: boolean; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const cfg = loadPlatformDefaults(store);
      const datasets = opts.dataset ? opts.dataset.split(',').map((d) => d.trim()).filter(Boolean) : store.listDatasets().map((d) => d.id);
      const result = await recall(store, cfg, { query, datasets, k: Number(opts.k), hops: Number(opts.hops), mode: cfg.retrieval.mode });
      if (opts.json) {
        console.log(JSON.stringify({ mode: result.mode, nodes: result.nodes.map((n) => ({ type: n.node.node_type, name: n.node.name, score: Number(n.score.toFixed(3)), via: n.via })) }, null, 2));
      } else {
        console.log(result.rendered || '(nothing recalled)');
      }
    } finally { store.close(); }
  });

memory.command('recall')
  .description('Show exactly what memory would be injected for an agent + task')
  .requiredOption('--agent <id>', 'Registered agent id (name@version)')
  .option('--task <text>', 'Task text to recall for')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts: { agent: string; task?: string; db: string }) => {
    const db = new SqliteAdapter(opts.db);
    const store = openMemoryStore(opts.db);
    try {
      const row = db.getAgent(opts.agent);
      if (!row) { console.error(`agent not found: ${opts.agent}`); process.exitCode = 2; return; }
      const { resolved } = hydrateAgentDefinition(row.definition_json as string);
      const cfg = resolveMemoryConfig(store, resolved);
      if (!cfg.enabled) { console.log('(memory disabled for this agent)'); return; }
      const rt = createMemoryRuntime({ store, config: cfg, definition: resolved, agentId: opts.agent, task: opts.task });
      const out = await rt.recall(opts.task ?? resolved.task.prompt);
      console.log(out.block ?? '(nothing recalled)');
      console.error(`\nmode=${out.mode} nodes=${out.nodes} chars=${out.chars} datasets=${out.datasets.join(',')}`);
    } finally { db.close(); store.close(); }
  });

memory.command('stats')
  .description('Node/edge/episode counts')
  .option('--dataset <id>', 'Restrict to one dataset')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { dataset?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try { console.log(JSON.stringify(store.stats(opts.dataset), null, 2)); } finally { store.close(); }
  });

memory.command('lesson')
  .description('Record a lesson manually')
  .requiredOption('--text <text>', 'The actionable lesson')
  .requiredOption('--trigger <text>', 'The error/command/situation that triggers it')
  .option('--dataset <id>', 'Dataset', PLATFORM_DATASET)
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { text: string; trigger: string; dataset: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const node = store.upsertNode({
        dataset: opts.dataset,
        node_type: 'Lesson',
        name: `lesson:manual:${slug(opts.trigger)}`,
        content: opts.text.slice(0, 600),
        node_set: 'pitfalls',
        properties_json: JSON.stringify({ manual: true, trigger: opts.trigger.slice(0, 300) }),
        importance: 0.7,
      });
      console.log(`lesson saved: ${node.id} (${node.dataset})`);
    } finally { store.close(); }
  });

memory.command('improve')
  .description('Decay stale weights, rebuild co-change edges, promote cross-agent lessons')
  .option('--dataset <id>', 'Limit co-change/promotion to one dataset')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { dataset?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try { console.log(JSON.stringify(improve(store, loadPlatformDefaults(store), { dataset: opts.dataset }), null, 2)); } finally { store.close(); }
  });

memory.command('promote')
  .description('Copy a node into the shared platform dataset')
  .requiredOption('--id <nodeId>', 'Memory node id')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { id: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const node = store.getNode(opts.id);
      if (!node) { console.error(`memory node not found: ${opts.id}`); process.exitCode = 2; return; }
      if (node.dataset === PLATFORM_DATASET) { console.error('node already belongs to the platform dataset'); process.exitCode = 2; return; }
      const promoted = store.upsertNode({
        dataset: PLATFORM_DATASET, node_type: node.node_type, name: node.name, content: node.content,
        node_set: node.node_set, importance: Math.max(Number(node.importance), 0.6),
        properties_json: JSON.stringify({ promoted_from: [node.dataset] }),
      });
      console.log(`promoted ${node.id} → ${promoted.id} (${promoted.dataset})`);
    } finally { store.close(); }
  });

memory.command('forget')
  .description('Delete one node, or an entire dataset (row deletes only)')
  .option('--id <nodeId>', 'Memory node id')
  .option('--dataset <id>', 'Dataset to clear')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { id?: string; dataset?: string; db: string }) => {
    if (!opts.id && !opts.dataset) { console.error('pass --id or --dataset'); process.exitCode = 2; return; }
    const store = openMemoryStore(opts.db);
    try {
      const removed = opts.id ? (store.deleteNode(opts.id) ? 1 : 0) : store.deleteDataset(opts.dataset!);
      console.log(`forgot ${removed} row(s)`);
    } finally { store.close(); }
  });

memory.command('config')
  .description('Show or update platform memory defaults')
  .option('--set <json>', 'Partial JSON merged over the current defaults')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action((opts: { set?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      if (opts.set) {
        let patch: unknown;
        try { patch = JSON.parse(opts.set); } catch { console.error('--set must be valid JSON'); process.exitCode = 2; return; }
        console.log(JSON.stringify(savePlatformDefaults(store, patch), null, 2));
      } else {
        console.log(JSON.stringify(loadPlatformDefaults(store), null, 2));
      }
    } finally { store.close(); }
  });

// Parse argv only when actually run as the CLI entrypoint (`node dist/cli.js …`,
// `tsx src/cli.ts …`) or through the npm bin symlink (`minions-assembler …`).
// Compare real paths: the symlink is named `minions-assembler`, not `cli.js`, and
// the old basename check silently did nothing for every globally installed CLI.
// When imported by tests, program.parseAsync would read vitest's argv and call
// commander's help→exit(1), aborting the test run.
function isCliEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const real = (p: string) => { try { return realpathSync(p).replace(/\\/g, '/'); } catch { return p.replace(/\\/g, '/'); } };
  const self = real(fileURLToPath(import.meta.url));
  return real(argv1) === self && /cli\.(ts|js)$/.test(self);
}
if (isCliEntrypoint()) void program.parseAsync(process.argv);
