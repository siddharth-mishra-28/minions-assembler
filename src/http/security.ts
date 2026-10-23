import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hostnameOf = (hostHeader: string): string => {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
};

const safeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface SecurityOptions {
  /** Extra hostnames accepted in Host/Origin (e.g. behind a reverse proxy). Also read from MINION_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** When set, every /api request must carry `Authorization: Bearer <token>`. Also read from MINION_API_TOKEN. */
  apiToken?: string;
}

/**
 * The cockpit can browse folders and run shell tools, so a bare loopback bind is not enough:
 *  - Host allow-list defeats DNS-rebinding (attacker domain resolving to 127.0.0.1).
 *  - Origin check on state-changing requests defeats cross-site form/fetch posts from other tabs.
 *  - Optional bearer token for shared/proxied deployments.
 * Non-browser clients (curl, CI) send no Origin and are unaffected.
 */
export function registerSecurity(app: FastifyInstance, opts: SecurityOptions = {}): void {
  const extra = [...(opts.allowedHosts ?? []), ...(process.env.MINION_ALLOWED_HOSTS?.split(',') ?? [])].map((h) => h.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set([...LOOPBACK, ...extra]);
  const token = opts.apiToken ?? process.env.MINION_API_TOKEN;

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (host && !allowed.has(hostnameOf(host))) {
      return reply.code(403).send({ error: 'Forbidden: unrecognised Host header' });
    }
    const origin = req.headers.origin;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (origin && (mutating || req.url.startsWith('/api/'))) {
      let originHost = '';
      try { originHost = hostnameOf(new URL(origin).host); } catch { /* malformed origin */ }
      let originPort = '';
      try { originPort = new URL(origin).port; } catch { /* ignore */ }
      const hostPort = host?.includes(':') && !host.endsWith(']') ? host.split(':').pop() : '';
      if (!allowed.has(originHost) || (originPort && hostPort && originPort !== hostPort)) {
        return reply.code(403).send({ error: 'Forbidden: cross-origin request blocked' });
      }
    }
    if (token && req.url.startsWith('/api/')) {
      const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!safeEq(given, token)) return reply.code(401).send({ error: 'Unauthorized: missing or invalid bearer token' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
}
