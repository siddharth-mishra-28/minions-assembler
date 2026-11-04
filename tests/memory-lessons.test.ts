import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../src/memory/sqlite-store.js';
import { RunMemoryCollector, interpretResult } from '../src/memory/capture.js';
import { errorSignature, normalizeErrorMessage, improve } from '../src/memory/lessons.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/memory/config.js';
import type { MemoryConfig } from '../src/memory/types.js';

const dir = mkdtempSync(join(tmpdir(), 'memory-lessons-'));
let store: SqliteMemoryStore;
let n = 0;

const cfg = (patch: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...JSON.parse(JSON.stringify(DEFAULT_MEMORY_CONFIG)) as MemoryConfig,
  ...patch,
});

beforeEach(() => { store = new SqliteMemoryStore(join(dir, `l${n++}.db`)); });
afterEach(() => { try { store.close(); } catch { /* noop */ } });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });

describe('error signatures', () => {
  it('normalizes paths, line numbers and ids so the same failure has one identity', () => {
    const a = errorSignature('bash', "Error: cannot open C:\\proj\\x\\a.ts:12:5 (id 0xdeadbeef)");
    const b = errorSignature('bash', 'error: cannot open /home/user/repo/b.ts:99:1 (id 0xfeedface)');
    expect(a).toBe(b);
    expect(normalizeErrorMessage('ENOENT C:\\x\\y.ts:3:4')).toContain('<path>');
  });

  it('keeps different tools and different failures apart', () => {
    expect(errorSignature('bash', 'boom')).not.toBe(errorSignature('edit', 'boom'));
    expect(errorSignature('bash', 'boom')).not.toBe(errorSignature('bash', 'different failure'));
  });
});

describe('tool result interpretation', () => {
  it('treats a returned non-zero exit code as a failure even when the SDK reports success', () => {
    const verdict = interpretResult(true, JSON.stringify({ exitCode: 1, stdout: '', stderr: 'nope' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('exit code 1');
  });

  it('accepts zero exit codes, plain text and explicit failures', () => {
    expect(interpretResult(true, JSON.stringify({ exitCode: 0 })).ok).toBe(true);
    expect(interpretResult(true, 'plain output').ok).toBe(true);
    expect(interpretResult(false, 'tool blew up')).toEqual({ ok: false, error: 'tool blew up' });
    expect(interpretResult(true, JSON.stringify({ success: false, error: 'bad args' })).error).toBe('bad args');
  });
});

describe('episode capture', () => {
  it('records a failed episode and a lesson with the recovery that worked', async () => {
    const injected = store.upsertNode({ dataset: 'agent:tester', node_type: 'Fact', name: 'fact:used', content: 'was used' });
    const collector = new RunMemoryCollector({
      store, config: cfg(), dataset: 'agent:tester', agentId: 'tester@1.0.0', runId: 'run_1', task: 'run the tests',
    });
    collector.setInjected([injected.id]);
    collector.noteToolStart('bash', { command: 'npm test' });
    collector.noteToolResult('bash', { command: 'npm test' }, true, JSON.stringify({ exitCode: 1, stderr: "ENOENT: no such file, open 'C:\\p\\package.json'" }));
    collector.noteToolStart('bash', { command: 'npm init -y' });
    collector.noteToolResult('bash', { command: 'npm init -y' }, true, JSON.stringify({ exitCode: 0, stdout: 'ok' }));
    collector.setSummary('tests could not run');

    const out = await collector.finish('failed');
    expect(out.episode?.outcome).toBe('failed');
    expect(out.episode?.run_id).toBe('run_1');
    expect(out.episode?.tool_failures_json).toContain('npm test');
    expect(out.lessons).toHaveLength(1);

    const lesson = out.lessons[0];
    expect(lesson.dataset).toBe('agent:tester');
    expect(lesson.node_type).toBe('Lesson');
    expect(lesson.content).toContain('npm init -y');
    const props = JSON.parse(lesson.properties_json!) as { recovered: boolean; seen: number; tool: string };
    expect(props.recovered).toBe(true);
    expect(props.seen).toBe(1);
    expect(props.tool).toBe('bash');

    // The failure penalises what the run READ, not the lesson it just taught.
    expect(out.feedbackApplied).toBe(1);
    expect(Number(store.getNode(injected.id)?.weight)).toBeCloseTo(-0.3, 5);
    expect(Number(store.getNode(lesson.id)?.weight)).toBe(0);
    expect(store.listEpisodes({ runId: 'run_1' })).toHaveLength(1);
  });

  it('increments seen on a repeated signature instead of duplicating the lesson', async () => {
    const run = async (runId: string): Promise<void> => {
      const c = new RunMemoryCollector({ store, config: cfg(), dataset: 'agent:tester', agentId: 'tester@1.0.0', runId });
      c.noteToolStart('bash', { command: 'npm test' });
      c.noteToolResult('bash', { command: 'npm test' }, true, JSON.stringify({ exitCode: 1, stderr: 'ENOENT: package.json' }));
      await c.finish('failed');
    };
    await run('run_a');
    await run('run_b');
    const lessons = store.listNodes({ dataset: 'agent:tester', node_type: 'Lesson' });
    expect(lessons).toHaveLength(1);
    expect((JSON.parse(lessons[0].properties_json!) as { seen: number }).seen).toBe(2);
  });

  it('captures the episode but no lesson when distillation is off', async () => {
    const c = new RunMemoryCollector({ store, config: cfg({ distill: 'off' }), dataset: 'agent:tester', agentId: 'tester@1.0.0' });
    c.noteToolStart('bash', { command: 'nope' });
    c.noteToolResult('bash', { command: 'nope' }, true, JSON.stringify({ exitCode: 127, stderr: 'not found' }));
    const out = await c.finish('failed');
    expect(out.episode).toBeTruthy();
    expect(out.lessons).toHaveLength(0);
    expect(store.listNodes({ node_type: 'Lesson' })).toHaveLength(0);
  });

  it('joins the episode to a run id attached after construction', async () => {
    const c = new RunMemoryCollector({ store, config: cfg(), dataset: 'agent:tester', agentId: 'tester@1.0.0' });
    c.setRunId('run_late');
    c.noteToolStart('bash', { command: 'x' });
    c.noteToolResult('bash', { command: 'x' }, true, JSON.stringify({ exitCode: 1, stderr: 'boom' }));
    const out = await c.finish('failed');
    expect(out.episode?.run_id).toBe('run_late');
    expect(store.listEpisodes({ runId: 'run_late' })).toHaveLength(1);
  });

  it('is idempotent — a second finish writes nothing new', async () => {
    const c = new RunMemoryCollector({ store, config: cfg(), dataset: 'agent:tester', agentId: 'tester@1.0.0', runId: 'run_once' });
    c.noteToolStart('bash', { command: 'x' });
    c.noteToolResult('bash', { command: 'x' }, true, JSON.stringify({ exitCode: 1, stderr: 'bad' }));
    await c.finish('failed');
    const again = await c.finish('failed');
    expect(again.episode).toBeUndefined();
    expect(store.listEpisodes({ runId: 'run_once' })).toHaveLength(1);
  });
});

describe('improve()', () => {
  it('builds co-change edges from episodes that touched the same file pair twice', () => {
    const a = store.upsertNode({ dataset: 'agent:tester', node_type: 'File', name: 'src/a.ts', content: '' });
    const b = store.upsertNode({ dataset: 'agent:tester', node_type: 'File', name: 'src/b.ts', content: '' });
    for (const runId of ['run_1', 'run_2']) {
      store.insertEpisode({
        run_id: runId, agent_id: 'tester@1.0.0', outcome: 'done',
        files_touched_json: JSON.stringify(['src/a.ts', 'src/b.ts']),
      });
    }
    const report = improve(store, cfg(), { dataset: 'agent:tester' });
    expect(report.coChangeEdges).toBe(1);
    const edges = store.edgesAround([a.id], 'agent:tester').filter((e) => e.relation === 'co_change');
    expect(edges).toHaveLength(1);
    expect([edges[0].source_id, edges[0].target_id].sort()).toEqual([a.id, b.id].sort());
  });

  it('promotes a lesson once the configured number of agents learned it', () => {
    const name = 'lesson:bash:same';
    store.upsertNode({ dataset: 'agent:one', node_type: 'Lesson', name, content: 'shared lesson' });
    expect(improve(store, cfg(), {}).promoted).toBe(0);

    store.upsertNode({ dataset: 'agent:two', node_type: 'Lesson', name, content: 'shared lesson' });
    const report = improve(store, cfg(), {});
    expect(report.promoted).toBe(1);
    const platform = store.findNode('platform', 'Lesson', name);
    expect(platform?.content).toBe('shared lesson');
    expect(platform?.properties_json).toContain('agent:one');
  });

  it('honours autoPromoteAcrossAgents=0 (promotion disabled)', () => {
    store.upsertNode({ dataset: 'agent:one', node_type: 'Lesson', name: 'lesson:x', content: 'a' });
    store.upsertNode({ dataset: 'agent:two', node_type: 'Lesson', name: 'lesson:x', content: 'a' });
    expect(improve(store, cfg({ lessons: { autoPromoteAcrossAgents: 0 } }), {}).promoted).toBe(0);
  });
});
