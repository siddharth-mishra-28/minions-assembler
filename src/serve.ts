import type { FastifyInstance } from 'fastify';

export async function startServer(port = 3100, dbPath = './data/minion.db') {
  const { buildServer } = await import('./server.js');
  const built = await buildServer(dbPath);
  const app = built.app as FastifyInstance;
  await app.listen({ port, host: '127.0.0.1' });
  // Fail loudly instead of hanging: runtime crashes (e.g. unhandled rejections from
  // a misbehaving SDK child) should exit the process so a supervisor restarts it.
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
  });
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down`);
    try { await app.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  return app;
}

if (process.argv[1]?.endsWith('serve.js')) {
  const port = Number(process.env.PORT ?? 3100);
  startServer(port).then(() => console.log(`minion-assembler serve on http://127.0.0.1:${port} (docs: /docs)`));
}
