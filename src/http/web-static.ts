import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Built SPA location: dist/web (next to the compiled server) or, when running from src via tsx, ../dist/web. */
export function findWebRoot(): string | undefined {
  for (const c of [join(HERE, '..', 'web'), join(HERE, '..', '..', 'dist', 'web')]) if (existsSync(join(c, 'index.html'))) return c;
  return undefined;
}

const NON_SPA = /^\/(api|docs|openapi\.json|ui)(\/|$|\.)/;

/** Serves the built web app with an SPA fallback. Without a build, `/` explains how to build it. */
export async function registerWebApp(app: FastifyInstance): Promise<void> {
  const root = findWebRoot();
  if (!root) {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>Minions</title><body style="font-family:system-ui;padding:3rem"><h2>Web app not built</h2><p>Run <code>npm run build:web</code> and restart, or open the legacy UI at <a href="/ui/dashboard">/ui/dashboard</a>.</p>'));
    return;
  }
  await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'], cacheControl: true, maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.header('Cache-Control', 'no-cache'); } });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' && !NON_SPA.test(req.url) && (req.headers.accept ?? '').includes('text/html')) {
      return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: `Route ${req.method}:${req.url.split('?')[0]} not found` });
  });
}
