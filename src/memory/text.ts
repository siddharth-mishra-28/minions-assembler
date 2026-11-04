/**
 * Text helpers shared by the memory modules. All deterministic and dependency-free:
 * the lexical channel's quality depends on these being predictable.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'there', 'these',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you',
  'your', 'please', 'can', 'should', 'would', 'could', 'do', 'does', 'did', 'not', 'no', 'yes',
]);

/** Strip ANSI escapes and control characters — memory content is untrusted tool output. */
export function stripControl(value: string): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Clip to a character budget on a word boundary where possible. */
export function clip(value: string, max: number): string {
  const s = stripControl(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Split an identifier into its searchable parts: camelCase, snake_case, dotted, path segments. */
export function splitIdentifier(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of String(raw ?? '').split(/[^A-Za-z0-9_$@.-]+/)) {
    if (!chunk) continue;
    const lower = chunk.toLowerCase();
    out.push(lower);
    // camelCase / PascalCase → sub-words
    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_.\-/]+/)
      .filter(Boolean);
    if (parts.length > 1) for (const p of parts) out.push(p.toLowerCase());
  }
  return out;
}

/** Expanded, de-duplicated term string stored in the FTS `terms` column. */
export function expandTerms(...inputs: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!input) continue;
    const text = stripControl(String(input)).slice(0, 20000);
    for (const token of splitIdentifier(text)) {
      if (token.length < 2 || token.length > 64) continue;
      if (STOPWORDS.has(token)) continue;
      seen.add(token);
      if (seen.size >= 800) return [...seen].join(' ');
    }
  }
  return [...seen].join(' ');
}

/** Query tokens for FTS5 (unordered; the caller builds the MATCH expression). */
export function queryTokens(query: string, max = 24): string[] {
  const seen = new Set<string>();
  for (const token of splitIdentifier(query)) {
    if (token.length < 2 || token.length > 64) continue;
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Build a safe FTS5 MATCH expression: each token becomes a quoted prefix term, joined
 * with OR. Quoting prevents FTS5 syntax injection from arbitrary task text.
 */
export function toFtsMatch(query: string, max = 24): string | undefined {
  const tokens = queryTokens(query, max);
  if (!tokens.length) return undefined;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

/** Stable slug for identity keys (facts/lessons named by content). */
export function slug(value: string, len = 10): string {
  // Small FNV-1a (no node:crypto dependency, works in any runtime/test env).
  let h = 0x811c9dc5;
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, len);
}

/** 0..1 recency weight with a 30-day half-life-ish decay. */
export function recencyScore(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.exp(-days / 30);
}
