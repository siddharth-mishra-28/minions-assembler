#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadAgentDefinition, redactedForLog } from './loader.js';
import { executeRun } from './runner.js';
import { SqliteAdapter } from './store/sqlite.js';
import { startServer } from './serve.js';

const program = new Command();
program.name('minion-assembler').description('Custom GitHub Copilot agents: JSON definitions, CI runs, serve mode').version('1.0.0');

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
  .option('--yes', 'Explicit CI approval for approve-all-ci-only policies')
  .option('--audit-level <level>', 'Audit verbosity: minimal|default|full (falls back to AUDIT_LEVEL env, then default)')
  .action(async (opts) => {
    const started = Date.now();
    try {
      const { definition, warnings, definitionHash } = loadAgentDefinition(opts.agentDefinition);
      for (const w of warnings) console.warn(`warning: ${w}`);
      const db = new SqliteAdapter(opts.db);
      const agentId = db.saveAgent(definition.metadata.name, definition.metadata.version, JSON.stringify(definition), definitionHash);
      // Wire the MCP registry so mcp.use refs resolve in CLI runs too
      let mcpRegistry: Map<string, import('./mcp.js').McpServerConfig> | undefined;
      let mcpRegistryTools: Map<string, string[]> | undefined;
      if (definition.mcp?.use?.length) {
        const registry = new Map<string, import('./mcp.js').McpServerConfig>();
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

program.command('mcp')
  .description('MCP registry operations')
  .command('register')
  .requiredOption('--name <name>', 'Registry key (referenced by definitions via mcp.use)')
  .requiredOption('--config <jsonOrPath>', 'Config JSON string or path to a JSON file')
  .option('--description <text>')
  .option('--probe', 'Connect now and store the discovered tool list')
  .option('--db <path>', 'SQLite path', './data/minion.db')
  .action(async (opts: { name: string; config: string; description?: string; probe?: boolean; db: string }) => {
    const { validateMcpConfig, probeMcpTools } = await import('./mcp.js');
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
    console.log(`minion-assembler serve on http://127.0.0.1:${opts.port} (docs: /docs)`);
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

program.parseAsync(process.argv);
