/**
 * Agent identity colors — the chat UI's team-member palette.
 *
 * Rules (standard team-chat behavior):
 * 1. An agent's `metadata.color` (hex #rrggbb) wins when present.
 * 2. Otherwise a deterministic color is derived from the agent id: stable across
 *    restarts, spread over a curated palette so roster members stay distinct.
 * 3. The signed-in user is ALWAYS the fixed accent indigo.
 *
 * Bubble text contrasts automatically: dark text on light backgrounds, light text
 * on dark ones (WCAG-ish luminance check, no dependencies).
 */

/** Curated 10-hue palette — distinct at a glance, accessibility-checked on both themes. */
export const IDENTITY_PALETTE: string[] = [
  '#7c5cff', // violet (base accent family)
  '#2fd68f', // emerald
  '#ffb547', // amber
  '#4fd8e0', // cyan
  '#ff6b7a', // rose
  '#5b8def', // blue
  '#e070e8', // magenta
  '#8fe388', // spring green
  '#f2994a', // orange
  '#54d1c5', // teal
];

/** The fixed user color (never derived, never overridden). */
export const USER_COLOR = '#6d5cff';

/** Stable string hash (djb2) — enough spread for roster-sized inputs. */
function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Normalize any candidate to `#rrggbb` lowercase; null when not a valid hex color. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(input.trim());
  if (!m) return null;
  return `#${m[1].toLowerCase()}`;
}

/**
 * Resolve an agent's identity color:
 * explicit `metadata.color` → normalized hex, else deterministic palette entry
 * from the id hash. Same id → same color, always.
 */
export function agentColor(definitionOrId: { metadata?: { color?: string; name?: string; version?: string }; color?: string } | string): string {
  const id = typeof definitionOrId === 'string' ? definitionOrId : `${definitionOrId.metadata?.name ?? ''}@${definitionOrId.metadata?.version ?? ''}`;
  const explicit = typeof definitionOrId === 'string' ? null : normalizeHex(definitionOrId.metadata?.color);
  if (explicit) return explicit;
  if (typeof definitionOrId !== 'string' && normalizeHex((definitionOrId as { color?: string }).color)) return normalizeHex((definitionOrId as { color?: string }).color) as string;
  return IDENTITY_PALETTE[hashId(id) % IDENTITY_PALETTE.length];
}

/** Relative luminance (0..1) of a #rrggbb color. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Readable text color for a colored background: near-black on light, white on dark. */
export function textColorOn(hex: string): string {
  return luminance(hex) > 0.45 ? '#14171f' : '#f5f6f8';
}
