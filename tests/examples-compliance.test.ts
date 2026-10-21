import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentDefinition } from '../src/agents/loader.js';

/**
 * The examples/ directory is the user-facing sample set: every definition there must
 * be compliant with the bundled schema in src/schema/ (the compliance contract for
 * ALL agent definitions) so the samples run out of the box.
 */
const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));

const agentFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));

describe('examples/ schema compliance', () => {
  it('ships at least one sample agent', () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(1);
  });

  for (const f of agentFiles) {
    it(`agent definition ${f} passes loadAgentDefinition (schema + rules)`, () => {
      const { definition, definitionHash } = loadAgentDefinition(join(EXAMPLES_DIR, f));
      expect(definition.metadata.name).toBeTruthy();
      expect(definitionHash).toMatch(/^[0-9a-f]{16}$/);
    });
  }
});
