import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AgentDefinition } from '../core/types.js';

/**
 * Markdown agent profiles — the regular GitHub Copilot custom-agent format.
 *
 * A profile is a markdown file (`.agent.md` / `.md`) with a small YAML frontmatter
 * block (identity + optional provider/tool knobs) whose BODY is the agent's task
 * prompt. Everything else stays at the defaults, so a profile maps to a *regular*
 * agent running on the default Copilot system prompt (persona untouched):
 *
 *   ---
 *   name: fullstack-dev
 *   description: Full-stack builder
 *   model: mimo-v2.6-flash
 *   tools: view, create, edit, bash
 *   ---
 *   Build the app described below …
 *
 * This mirrors how `.github/agents/*.agent.md` profiles work in regular Copilot.
 */

export interface AgentMarkdownProfile {
  name: string;
  description?: string;
  version: string;
  model?: string;
  /** Tool allowlist from frontmatter `tools:` (comma list or one-per-line). */
  tools?: string[];
  workingDirectory?: string;
  /** The markdown body — becomes `task.prompt`. */
  prompt: string;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'md-agent';

/** Minimal YAML-ish frontmatter parser: `key: value` lines, `#` comments, simple lists. */
function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data: Record<string, string> = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length).trim() };
}

/** Parse a markdown agent profile from text. Throws on profiles without any prompt body. */
export function parseAgentMarkdown(text: string, fallbackName?: string): AgentMarkdownProfile {
  const { data, body } = parseFrontmatter(text);
  if (!body) throw new Error('markdown agent profile has no prompt body (text after the --- frontmatter)');
  const tools = (data.tools ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: slug(data.name || fallbackName || basename(String(data.title ?? '')) || 'md-agent'),
    description: data.description || undefined,
    version: data.version || '1.0.0',
    model: data.model || undefined,
    tools: tools.length ? tools : undefined,
    workingDirectory: data.workingdirectory || data.basedir || undefined,
    prompt: body,
  };
}

/**
 * Map a markdown profile to a canonical AgentDefinition.
 *
 * Persona is OMITTED on purpose: the agent runs on the default Copilot system
 * prompt exactly like a regular Copilot custom agent. `provider` falls back to
 * the MiMo preset with an env-var key reference so the definition is complete
 * without ever embedding secrets.
 */
export function mdProfileToDefinition(profile: AgentMarkdownProfile): AgentDefinition {
  return {
    schemaVersion: '1.0',
    metadata: {
      name: profile.name,
      version: profile.version,
      ...(profile.description ? { description: profile.description } : { description: `Markdown agent profile (${profile.name})` }),
      tags: ['markdown-profile'],
    },
    knowledge: {
      ...(profile.workingDirectory ? { workingDirectory: profile.workingDirectory } : {}),
      sessionStore: false,
    },
    ...(profile.tools
      ? {
          tools: {
            permissionPolicy: 'pattern-list',
            harness: true,
            patterns: profile.tools.map((t) => ({ tool: t, decision: 'allow' as const, reason: 'markdown profile tools allowlist' })),
          },
        }
      : {}),
    task: { prompt: profile.prompt, deliveryMode: 'enqueue' },
    provider: {
      type: 'openai',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: profile.model ?? 'mimo-v2.6-flash',
      wireApi: 'completions',
      providerApiKey: '${MIMO_API_KEY}',
    },
  } as AgentDefinition;
}

export interface InstructionFileHit {
  path: string;
  kind: 'agents-md' | 'claude-md' | 'copilot-instructions' | 'agent-profile';
  bytes: number;
  preview: string;
}

/**
 * Scan a working directory for the instruction/profile files regular GitHub
 * Copilot uses: AGENTS.md (+ AGENTS.local.md), CLAUDE.md, .github/copilot-instructions.md
 * and custom agent profiles in .github/agents/*.agent.md. Pure read-only discovery.
 */
export function scanInstructionFiles(workdir: string): InstructionFileHit[] {
  const root = resolve(workdir || process.cwd());
  const hits: InstructionFileHit[] = [];
  const add = (p: string, kind: InstructionFileHit['kind']): void => {
    try {
      if (!existsSync(p) || !statSync(p).isFile()) return;
      const text = readFileSync(p, 'utf8');
      hits.push({ path: p, kind, bytes: text.length, preview: text.slice(0, 400) });
    } catch { /* unreadable — skip */ }
  };
  add(join(root, 'AGENTS.md'), 'agents-md');
  add(join(root, 'AGENTS.local.md'), 'agents-md');
  add(join(root, 'CLAUDE.md'), 'claude-md');
  add(join(root, '.github', 'copilot-instructions.md'), 'copilot-instructions');
  const agentsDir = join(root, '.github', 'agents');
  try {
    for (const f of readdirSync(agentsDir)) {
      if (/\.md$/i.test(f)) add(join(agentsDir, f), 'agent-profile');
    }
  } catch { /* no .github/agents dir */ }
  return hits;
}

/** Load + parse + map in one go from a file path. */
export function loadAgentMarkdown(path: string): { definition: AgentDefinition; profile: AgentMarkdownProfile } {
  const text = readFileSync(path, 'utf8');
  const profile = parseAgentMarkdown(text, basename(path).replace(/\.(agent\.)?md$/i, ''));
  return { definition: mdProfileToDefinition(profile), profile };
}
