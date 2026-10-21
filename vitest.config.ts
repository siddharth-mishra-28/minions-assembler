import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Product unit tests live in the root tests/ folder (separated from src/).
    // Agent workspaces (workspace-*/) hold runtime output from coding runs and
    // must never enter the suite.
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'workspace-*/**'],
  },
});
