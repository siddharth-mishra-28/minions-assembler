import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Product unit tests live in the root tests/ folder (separated from src/).
    // Agent workspaces (workspace-*/) hold runtime output from coding runs and
    // must never enter the suite.
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'workspace-*/**'],
    // Several suites spawn CLI/SDK child processes and open SQLite files. Running
    // every file in its own worker at once can exhaust a small CI runner (the
    // workers exit with no test-level error). Keep one worker and run files
    // sequentially; the suite is still fast enough for the package job.
    pool: 'forks',
    fileParallelism: false,
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
  },
});
