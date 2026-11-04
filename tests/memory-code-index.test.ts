import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteMemoryStore } from '../src/memory/sqlite-store.js';
import { indexCodeGraph, extractSymbols, extractImports, resolveSpecifier, matchesPattern, isTestPath } from '../src/memory/code-index.js';

let root: string;
let store: SqliteMemoryStore;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'code-index-'));
  put('src/a.ts', "import { beta } from './b';\nexport function alpha() {\n  return beta();\n}\n");
  put('src/b.ts', 'export function beta() {\n  return 1;\n}\n');
  put('src/util/c.ts', 'export const gamma = 1;\nexport type Delta = { x: number };\n');
  put('tests/a.test.ts', "import { alpha } from '../src/a';\n");
  put('node_modules/pkg/index.js', 'export function vendored() { return 1; }\n');
  put('dist/bundle.js', 'export function bundled() { return 1; }\n');
  put('package.json', '{"name":"fixture"}\n');
});

afterAll(() => {
  try { store?.close(); } catch { /* noop */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ }
});

describe('indexCodeGraph', () => {
  it('indexes files, symbols, imports and test edges (skipping node_modules/dist)', () => {
    store = new SqliteMemoryStore(join(root, '.db.sqlite'));
    const res = indexCodeGraph(store, { root, dataset: 'platform' });
    expect(res.files).toBeGreaterThanOrEqual(4);
    expect(res.symbols).toBeGreaterThanOrEqual(4);
    expect(store.findNode('platform', 'File', 'src/a.ts')).toBeTruthy();
    expect(store.findNode('platform', 'File', 'node_modules/pkg/index.js')).toBeUndefined();
    expect(store.findNode('platform', 'File', 'dist/bundle.js')).toBeUndefined();
    expect(store.findNode('platform', 'Symbol', 'src/a.ts#alpha')).toBeTruthy();
    expect(store.findNode('platform', 'Symbol', 'src/b.ts#beta')).toBeTruthy();
    expect(store.findNode('platform', 'Symbol', 'src/util/c.ts#gamma')).toBeTruthy();

    const a = store.findNode('platform', 'File', 'src/a.ts')!;
    const b = store.findNode('platform', 'File', 'src/b.ts')!;
    const around = store.edgesAround([a.id], 'platform').filter((e) => e.relation === 'imports');
    expect(around.map((e) => e.target_id)).toContain(b.id);

    const test = store.findNode('platform', 'File', 'tests/a.test.ts')!;
    const testEdge = store.edgesAround([test.id], 'platform').filter((e) => e.relation === 'tests');
    expect(testEdge.map((e) => e.target_id)).toContain(a.id);

    // The file node carries the language and the content hash used for incrementality.
    const props = JSON.parse(store.findNode('platform', 'File', 'src/a.ts')!.properties_json!) as { lang: string; sha: string };
    expect(props.lang).toBe('typescript');
    expect(props.sha).toHaveLength(16);
  });

  it('is incremental: unchanged files keep their node identity and timestamp', () => {
    const before = store.findNode('platform', 'File', 'src/a.ts')!;
    indexCodeGraph(store, { root, dataset: 'platform' });
    const after = store.findNode('platform', 'File', 'src/a.ts')!;
    expect(after.id).toBe(before.id);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('re-indexes changed files and drops symbols that disappeared', () => {
    put('src/b.ts', 'export function betav2() {\n  return 2;\n}\n');
    indexCodeGraph(store, { root, dataset: 'platform' });
    expect(store.findNode('platform', 'Symbol', 'src/b.ts#beta')).toBeUndefined();
    expect(store.findNode('platform', 'Symbol', 'src/b.ts#betav2')).toBeTruthy();
  });

  it('removes File and Symbol nodes for deleted files on a full scan', () => {
    unlinkSync(join(root, 'src/util/c.ts'));
    const res = indexCodeGraph(store, { root, dataset: 'platform' });
    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(store.findNode('platform', 'File', 'src/util/c.ts')).toBeUndefined();
    expect(store.findNode('platform', 'Symbol', 'src/util/c.ts#gamma')).toBeUndefined();
  });

  it('never removes nodes when removeStale is false (run-scoped scans)', () => {
    put('src/only-in-run.ts', 'export function runOnly() { return 1; }\n');
    indexCodeGraph(store, { root, dataset: 'platform', removeStale: false });
    const res = indexCodeGraph(store, { root: join(root, 'src'), dataset: 'platform', removeStale: false });
    expect(res.removed).toBe(0);
  });

  it('records index metadata for observability', () => {
    expect(store.getMeta('code.last_index_at:platform')).toBeTruthy();
    expect(store.getMeta('code.files:platform')).toBeTruthy();
  });
});

describe('extraction helpers', () => {
  it('extracts top-level declarations per language', () => {
    expect(extractSymbols('typescript', 'export async function a() {}\nexport interface B {}\nconst c = 1;').map((s) => s.name)).toContain('a');
    expect(extractSymbols('typescript', 'export interface B {}\nconst c = 1;').map((s) => s.name)).toEqual(expect.arrayContaining(['B', 'c']));
    expect(extractSymbols('python', 'def run(x):\n  pass\nclass Thing:\n  pass\n').map((s) => s.name)).toEqual(['run', 'Thing']);
    expect(extractSymbols('go', 'func Do(x int) {}\ntype T struct{}').map((s) => s.name)).toEqual(['Do', 'T']);
    expect(extractSymbols('rust', 'pub async fn go() {}\npub struct S;').map((s) => s.name)).toEqual(['go', 'S']);
    expect(extractSymbols('markdown', '# heading')).toEqual([]);
  });

  it('extracts import specifiers', () => {
    expect(extractImports('typescript', "import a from './x';\nconst b = require('pkg');\nexport * from './y';"))
      .toEqual(expect.arrayContaining(['./x', 'pkg', './y']));
    expect(extractImports('python', 'import os\nfrom pkg.mod import thing\n')).toEqual(expect.arrayContaining(['os', 'pkg.mod']));
    expect(extractImports('json', '{}')).toEqual([]);
  });

  it('resolves relative specifiers by probing extensions and index files', () => {
    const known = new Set(['src/b.ts', 'src/util/index.ts']);
    expect(resolveSpecifier('src/a.ts', './b', (p) => known.has(p))).toBe('src/b.ts');
    expect(resolveSpecifier('src/a.ts', './util', (p) => known.has(p))).toBe('src/util/index.ts');
    expect(resolveSpecifier('src/a.ts', './missing', (p) => known.has(p))).toBeUndefined();
    expect(resolveSpecifier('src/a.ts', 'react', () => true)).toBeUndefined();
  });

  it('matches exclude/include patterns', () => {
    expect(matchesPattern('node_modules/pkg/a.js', 'node_modules')).toBe(true);
    expect(matchesPattern('src/a.ts', '*.ts')).toBe(true);
    expect(matchesPattern('src/a.md', '*.ts')).toBe(false);
    expect(matchesPattern('src/deep/a.ts', 'src')).toBe(true);
  });

  it('recognises test paths and pairs the file under test', () => {
    expect(isTestPath('tests/a.test.ts')).toBe(true);
    expect(isTestPath('src/a.spec.ts')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
    expect(isTestPath('test_thing.py')).toBe(true);
  });
});
