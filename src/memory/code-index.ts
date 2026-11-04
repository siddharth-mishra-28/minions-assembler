import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { expandTerms } from './text.js';
import type { MemoryStore } from './store.js';
import type { IndexOptions, IndexResult } from './types.js';

/**
 * Deterministic code graph: File → Symbol/imports/tests edges.
 *
 * Deliberately NOT an AST parser. Symbol/import extraction is regex-based over
 * top-level declarations — bounded, reproducible, and fast enough to run at the
 * start of every run. Tree-sitter is future scope; the graph shape it would fill
 * is already the right one.
 *
 * Incrementality: every file records its sha256. Unchanged files skip all writes,
 * and a full root scan removes File nodes whose path no longer exists (run-scoped
 * scans never remove, because their paths are workspace-relative, not root-relative).
 */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.json': 'json', '.md': 'markdown',
};

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.hg', '.svn', '.next', '.nuxt',
  '.turbo', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.idea', '.vscode',
  'data', 'runs', '.chats', '.minion', '.smoke', '.audit', 'tmp', 'temp',
]);

const NODE_BUILTINS = new Set([
  'fs', 'path', 'crypto', 'os', 'url', 'util', 'child_process', 'http', 'https', 'stream', 'events',
  'assert', 'buffer', 'zlib', 'timers', 'net', 'tty', 'dns', 'readline', 'worker_threads', 'perf_hooks',
  'vm', 'v8', 'module', 'process', 'node',
]);

const PY_STDLIB = new Set([
  'os', 'sys', 'json', 're', 'typing', 'pathlib', 'datetime', 'subprocess', 'dataclasses', 'collections',
  'itertools', 'functools', 'math', 'time', 'random', 'logging', 'shutil', 'tempfile', 'unittest',
  'argparse', 'asyncio', 'hashlib', 'uuid', 'base64', 'sqlite3', 'contextlib', 'traceback', 'inspect',
]);

const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '/index.ts', '/index.tsx', '/index.js', '/index.py', '/__init__.py'];

const MAX_SYMBOLS_PER_FILE = 120;
const TERMS_SOURCE_MAX = 4000;

export function indexCodeGraph(store: MemoryStore, opts: IndexOptions): IndexResult {
  const started = Date.now();
  const root = resolve(opts.root);
  const dataset = opts.dataset;
  const maxFiles = clampInt(opts.maxFiles ?? 4000, 1, 50000);
  const maxBytes = clampInt(opts.maxBytesPerFile ?? 512 * 1024, 1024, 10 * 1024 * 1024);
  const timeBudgetMs = clampInt(opts.timeBudgetMs ?? 10_000, 100, 120_000);
  const withSymbols = opts.symbols !== false;
  const stripPrefix = (opts.stripPrefix ?? '').replace(/\\/g, '/');

  const result: IndexResult = {
    root, dataset, files: 0, symbols: 0, edges: 0, skipped: 0, removed: 0, truncated: false,
    durationMs: 0,
  };
  if (!existsSync(root)) {
    result.durationMs = Date.now() - started;
    return result;
  }

  store.upsertDataset(dataset, dataset === 'platform' ? 'platform' : 'agent');
  const excludePatterns = [...(opts.exclude ?? [])];
  const includePatterns = (opts.include ?? []).filter(Boolean);

  // ---- pass 1: collect candidate files ----
  const collected: string[] = [];
  const walk = (dir: string): void => {
    if (collected.length >= maxFiles || Date.now() - started > timeBudgetMs) { result.truncated = true; return; }
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (collected.length >= maxFiles || Date.now() - started > timeBudgetMs) { result.truncated = true; return; }
      const abs = join(dir, entry.name);
      const relPath = toPosix(relative(root, abs));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
        if (/^(run_|workspace-)/.test(entry.name)) continue;
        if (excludePatterns.some((p) => matchesPattern(`${relPath}/`, p) || matchesPattern(entry.name, p))) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!LANG_BY_EXT[ext]) continue;
      if (excludePatterns.some((p) => matchesPattern(relPath, p))) continue;
      if (includePatterns.length && !includePatterns.some((p) => matchesPattern(relPath, p))) continue;
      collected.push(relPath);
    }
  };
  walk(root);

  // ---- pass 2: upsert file + symbol nodes ----
  const fileIdByPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  // One read of the current symbol inventory, grouped by file — used to drop
  // symbols that a changed file no longer declares (without per-file scans).
  const existingSymbols = new Map<string, { id: string; name: string }[]>();
  for (const s of store.listNodes({ dataset, node_type: 'Symbol', limit: 50000 })) {
    const key = s.source_path ?? '';
    const list = existingSymbols.get(key) ?? [];
    list.push({ id: s.id, name: s.name });
    existingSymbols.set(key, list);
  }
  const importSpecs = new Map<string, { rel: string; specs: string[] }>();
  const seenPaths = new Set<string>();

  for (const relRaw of collected) {
    const rel = stripPrefix && relRaw.startsWith(stripPrefix) ? relRaw.slice(stripPrefix.length) : relRaw;
    const abs = join(root, relRaw);
    let stat: import('node:fs').Stats;
    try { stat = statSync(abs); } catch { continue; }
    if (stat.size > maxBytes) { result.skipped++; continue; }

    let source = '';
    try { source = readFileSync(abs, 'utf8'); } catch { result.skipped++; continue; }
    const lang = LANG_BY_EXT[extname(relRaw).toLowerCase()] ?? 'text';
    const sha = createHash('sha256').update(source).digest('hex').slice(0, 16);

    const existing = store.findNode(dataset, 'File', rel);
    const prevSha = existing?.properties_json ? safeJson(existing.properties_json)?.sha : undefined;
    if (prevSha === sha) {
      // Unchanged: keep the node (and its id) but mark it present.
    seenPaths.add(rel);
    fileIdByPath.set(rel, existing!.id);
    registerBasename(byBasename, rel);
      result.files++;
      if (withSymbols) {
        const syms = extractSymbols(lang, source);
        result.symbols += syms.length;
      }
      const specs = extractImports(lang, source);
      if (specs.length) importSpecs.set(rel, { rel, specs });
      continue;
    }

    const symbols = withSymbols ? extractSymbols(lang, source) : [];
    const specs = extractImports(lang, source);
    // The rendered memory block shows this line, so it is a STRUCTURAL summary
    // (what the file defines and imports) rather than a raw source prefix.
    const uniqueSpecs = dedupe(specs);
    const summary = [
      `${lang} · ${(stat.size / 1024).toFixed(1)}KB`,
      symbols.length ? `defines: ${symbols.slice(0, 12).map((s) => s.name).join(', ')}${symbols.length > 12 ? ', …' : ''}` : '',
      uniqueSpecs.length ? `imports: ${uniqueSpecs.slice(0, 10).join(', ')}${uniqueSpecs.length > 10 ? ', …' : ''}` : '',
    ].filter(Boolean).join(' · ');
    const fileNode = store.upsertNode({
      dataset,
      node_type: 'File',
      name: rel,
      content: summary,
      terms: expandTerms(rel, symbols.map((s) => s.name).join(' '), specs.join(' '), source.slice(0, TERMS_SOURCE_MAX)),
      node_set: 'code',
      properties_json: JSON.stringify({ lang, bytes: stat.size, sha, symbols: symbols.length }),
      importance: 0.5,
      source_run_id: opts.runId ?? null,
      source_path: rel,
    });
    seenPaths.add(rel);
    fileIdByPath.set(rel, fileNode.id);
    registerBasename(byBasename, rel);
    result.files++;

    // Remove symbols this file no longer declares (renames/deletions within a file).
    const liveSymbols = new Set(symbols.map((s) => `${rel}#${s.name}`));
    for (const old of existingSymbols.get(rel) ?? []) {
      if (!liveSymbols.has(old.name)) store.deleteNode(old.id);
    }

    for (const sym of symbols.slice(0, MAX_SYMBOLS_PER_FILE)) {
      const symNode = store.upsertNode({
        dataset,
        node_type: 'Symbol',
        name: `${rel}#${sym.name}`,
        content: `${sym.kind} ${sym.name} — ${rel}:${sym.line}`,
        node_set: 'code',
        properties_json: JSON.stringify({ kind: sym.kind, line: sym.line, file: rel }),
        importance: 0.45,
        source_run_id: opts.runId ?? null,
        source_path: rel,
      });
      store.upsertEdge({ dataset, source_id: fileNode.id, target_id: symNode.id, relation: 'contains', edge_text: `${rel} defines ${sym.name}` });
      result.symbols++;
    }
    if (specs.length) importSpecs.set(rel, { rel, specs });
  }

  // ---- pass 3: resolve imports (file→file, file→package) ----
  for (const { rel, specs } of importSpecs.values()) {
    const fromId = fileIdByPath.get(rel);
    if (!fromId) continue;
    for (const spec of dedupe(specs)) {
      if (spec.startsWith('.')) {
        const target = resolveSpecifier(rel, spec, (p) => fileIdByPath.has(p));
        if (!target) continue;
        const targetId = fileIdByPath.get(target);
        if (!targetId || targetId === fromId) continue;
        store.upsertEdge({
          dataset, source_id: fromId, target_id: targetId, relation: 'imports',
          edge_text: `${rel} imports ${target}`,
        });
        result.edges++;
      } else {
        const pkg = packageName(spec);
        if (!pkg || isBuiltin(spec)) continue;
        const pkgNode = store.upsertNode({
          dataset, node_type: 'Package', name: pkg, content: `external package ${pkg}`,
          node_set: 'deps', importance: 0.35,
        });
        store.upsertEdge({
          dataset, source_id: fromId, target_id: pkgNode.id, relation: 'imports',
          edge_text: `${rel} imports package ${pkg}`,
        });
        result.edges++;
      }
    }
  }

  // ---- pass 4: test → source edges (heuristic, basename match) ----
  for (const rel of seenPaths) {
    if (!isTestPath(rel)) continue;
    const testId = fileIdByPath.get(rel);
    if (!testId) continue;
    const base = testBasename(rel);
    if (!base) continue;
    const candidates = (byBasename.get(base) ?? []).filter((p) => p !== rel && !isTestPath(p));
    const preferred = candidates.find((p) => p.startsWith('src/')) ?? candidates[0];
    const targetId = preferred ? fileIdByPath.get(preferred) : undefined;
    if (!targetId) continue;
    store.upsertEdge({ dataset, source_id: testId, target_id: targetId, relation: 'tests', edge_text: `${rel} tests ${preferred}` });
    result.edges++;
  }

  // ---- pass 5: stale removal (full scans only) ----
  if (!stripPrefix && opts.removeStale !== false) {
    const known = store.listNodes({ dataset, node_type: 'File', limit: 50000 });
    for (const node of known) {
      if (seenPaths.has(node.name)) continue;
      // Files that only exist in per-run folders are indexed separately with a
      // stripped path; a root scan must not delete them just because the run
      // folder itself is excluded from the walk.
      if (node.source_run_id && !node.source_path) continue;
      // Drop the file's symbol children before the file node itself.
      for (const sym of existingSymbols.get(node.name) ?? []) store.deleteNode(sym.id);
      if (store.deleteNode(node.id)) result.removed++;
    }
  }

  store.setMeta(`code.last_index_at:${dataset}`, new Date().toISOString());
  store.setMeta(`code.files:${dataset}`, String(result.files));
  result.durationMs = Date.now() - started;
  return result;
}

// ---------------- extraction ----------------

export interface ExtractedSymbol { name: string; kind: string; line: number }

/** Top-level declarations per language. Approximate by design (regex, line-anchored). */
export function extractSymbols(lang: string, source: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  if (lang === 'json' || lang === 'markdown' || lang === 'text') return out;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    const line = lines[i];
    if (line.length > 400) continue;
    const push = (name: string, kind: string): void => {
      if (!name || /^(if|for|while|switch|return|catch|function)$/.test(name)) return;
      out.push({ name, kind, line: i + 1 });
    };
    // Column 0 only: these are MODULE-LEVEL declarations. Indented matches are
    // locals/methods and would bury the API surface in thousands of noise nodes.
    if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript' || lang === 'jsx') {
      const decl = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (decl) push(decl[2], decl[1]);
      const named = /^export\s*\{([^}]+)\}/.exec(line);
      if (named) for (const part of named[1].split(',')) push(part.trim().split(/\s+as\s+/).pop() ?? '', 'export');
      continue;
    }
    if (lang === 'python') {
      const m = /^(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
      if (m && (m[1] === 'class' || !m[2].startsWith('_'))) push(m[2], m[1]);
      continue;
    }
    if (lang === 'go') {
      const f = /^func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(line);
      if (f) push(f[1], 'func');
      const t = /^type\s+(\w+)\s+(struct|interface)/.exec(line);
      if (t) push(t[1], t[2]);
      continue;
    }
    if (lang === 'rust') {
      const m = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod)\s+(\w+)/.exec(line);
      if (m) push(m[2], m[1]);
    }
  }
  return out;
}

/** Import specifiers (relative or bare) per language. */
export function extractImports(lang: string, source: string): string[] {
  const specs: string[] = [];
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript' || lang === 'jsx') {
    for (const re of [
      /\bimport\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
      /\bexport\s+[^'"\n]*?\s+from\s+['"]([^'"\n]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        if (m[1] && specs.length < 400) specs.push(m[1]);
      }
    }
    return specs;
  }
  if (lang === 'python') {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const spec = m[1] ?? m[2];
      if (spec && specs.length < 400) specs.push(spec);
    }
  }
  return specs;
}

// ---------------- path helpers ----------------

/** Resolve a relative import specifier to a known repo-relative file path. */
export function resolveSpecifier(fromRel: string, spec: string, exists: (rel: string) => boolean): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = normalize(join(dirname(fromRel), spec)).replace(/\\/g, '/');
  const candidates = [base, ...PROBE_EXTENSIONS.map((ext) => `${base}${ext}`)];
  for (const c of candidates) {
    const clean = c.replace(/^\.\//, '');
    if (exists(clean)) return clean;
  }
  return undefined;
}

/** Bare specifier → package identity (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageName(spec: string): string | undefined {
  const clean = spec.replace(/^node:/, '').replace(/^@/, '@');
  const parts = clean.split('/');
  if (!parts[0]) return undefined;
  if (parts[0].startsWith('@')) return parts[1] ? `@${parts[0].slice(1)}/${parts[1]}` : undefined;
  return parts[0];
}

function isBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  const root = spec.split('/')[0];
  return NODE_BUILTINS.has(root) || PY_STDLIB.has(root);
}

export function isTestPath(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  return /\.(test|spec)\.[^.]+$/.test(name) || /^test_.+\.py$/.test(name) || /(^|\/)tests?\//.test(rel);
}

function testBasename(rel: string): string | undefined {
  const name = rel.split('/').pop() ?? rel;
  const stripped = name
    .replace(/\.(test|spec)\.[^.]+$/, '')
    .replace(/^test_/, '')
    .replace(/\.[^.]+$/, '');
  return stripped || undefined;
}

function registerBasename(map: Map<string, string[]>, rel: string): void {
  const name = rel.split('/').pop() ?? rel;
  const base = name.replace(/\.[^.]+$/, '');
  if (!base) return;
  const list = map.get(base) ?? [];
  if (!list.includes(rel)) list.push(rel);
  map.set(base, list);
}

function toPosix(p: string): string { return p.split(sep).join('/'); }

function safeJson(raw: string): { sha?: string } | undefined {
  try { return JSON.parse(raw) as { sha?: string }; } catch { return undefined; }
}

function dedupe(list: string[]): string[] { return [...new Set(list)]; }

/** Minimal glob support: `*` wildcards, otherwise substring or exact-segment match. */
export function matchesPattern(rel: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.includes('*')) {
    const re = new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`, 'i');
    return re.test(rel);
  }
  return rel === p || rel.startsWith(`${p}/`) || rel.includes(`/${p}`) || rel.endsWith(`/${p}`);
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}
