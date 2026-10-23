#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAgentDefinition, redactedForLog } from './agents/loader.js';
import { executeRun } from './execution/runner.js';
import { SqliteAdapter } from './store/sqlite.js';
import { startServer } from './serve.js';

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
  .option('--yes', 'Explicit CI approval for approve-all-ci-only policies (alias of --approval autopilot)')
  .option('--approval <mode>', 'Headless approval mode: autopilot (auto-approve every ask) | strict (deny every ask)')
  .option('--audit-level <level>', 'Audit verbosity: minimal|default|full (falls back to AUDIT_LEVEL env, then default)')
  .action(async (opts) => {
    const started = Date.now();
    try {
      const { definition, warnings, definitionHash } = loadAgentDefinition(opts.agentDefinition);
      for (const w of warnings) console.warn(`warning: ${w}`);
      if (opts.approval && !['autopilot', 'strict'].includes(opts.approval)) throw new Error("--approval must be autopilot or strict (got '${opts.approval}')");
      const approval = (opts.approval as 'autopilot' | 'strict' | undefined) ?? (opts.yes ? 'autopilot' : undefined);
      const db = new SqliteAdapter(opts.db);
      const agentId = db.saveAgent(definition.metadata.name, definition.metadata.version, JSON.stringify(definition), definitionHash);
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
        definition, agentId, definitionHash, db,
        taskOverride: opts.task,
        ciApproveAll: Boolean(opts.yes),
        approvalMode: approval,
        auditLevel: (opts.auditLevel as 'minimal' | 'default' | 'full' | undefined) || undefined,
        resumeSessionId: opts.sessionId,
        streamOut: opts.stream === false ? undefined : (t) => { streamed += t; process.stdout.write(t); },
        mcpRegistry, mcpRegistryTools,
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
      const hash = createHash('sha256').update(JSON.stringify(validated.definition)).digest('hex').slice(0, 16);
      if (!opts.register) { console.log(defJson); return; }
      const db = new SqliteAdapter(opts.db);
      try {
        const id = db.saveAgent(validated.definition.metadata.name, validated.definition.metadata.version, JSON.stringify(validated.definition), hash);
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
    const def = JSON.parse(row.definition_json as string);
    const { executeChatTurn } = await import('./execution/chat-runner.js');
    const { join } = await import('node:path');
    const threadDir = resolve(`./.chats/${opts.thread}`);
    mkdirSync(threadDir, { recursive: true });
    const userMessageId = db.addChatMessage(opts.thread, { role: 'user', author: 'user', content: opts.message });
    try {
      const turn = await executeChatTurn({
        definition: def, agentId, db,
        sessionId: (t.session_id as string | null) ?? undefined,
        sessionIdPrefix: 'chat',
        content: opts.message,
        workingDirectory: threadDir,
        turnTimeoutMs: Number(opts.timeoutMs),
      });
      db.updateChatThread(opts.thread, { sessionId: turn.sessionId });
      const replyMessageId = db.addChatMessage(opts.thread, { role: 'assistant', author: agentId, content: turn.text, runId: turn.runId });
      console.log(JSON.stringify({ userMessageId, replyMessageId, runId: turn.runId, agentId, text: turn.text }, null, 2));
    } catch (e) {
      console.error(`chat turn failed: ${(e as Error).message}`);
      process.exitCode = 3;
    } finally { db.close(); }
  });
chat.command('read').requiredOption('--thread <id>').option('--db <path>', 'SQLite path', './data/minion.db').action((opts) => {
  const db = new SqliteAdapter(opts.db);
  const t = db.getChatThread(opts.thread);
  if (!t) { console.error(`chat thread not found: ${opts.thread}`); process.exitCode = 2; db.close(); return; }
  console.log(JSON.stringify({ ...t, messages: db.getChatMessages(opts.thread) }, null, 2));
  db.close();
});

// Parse argv only when actually run as the CLI entrypoint (`node dist/cli.js …` or
// `tsx src/cli.ts …`). When imported by tests, program.parseAsync would read vitest's
// argv and call commander's help→exit(1), aborting the test run.
const invokedAsMain = process.argv[1] ? /cli\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/')) : false;
if (invokedAsMain) void program.parseAsync(process.argv);
