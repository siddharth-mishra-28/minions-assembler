#!/usr/bin/env node
/**
 * Repair driver for the generated app.
 *
 * When the independent verifier finds required failures, this script turns the report
 * into a precise repair task and runs the SAME full-stack-engineer definition over the
 * existing workspace. It never edits the verifier and never rebuilds the app from
 * scratch; the final verifier run is still the gate.
 *
 * Usage:
 *   node ci/repair-app.mjs --app app --report reports/app/report.json --out reports/repair
 *   node ci/repair-app.mjs ... --dry-run          # print the task without invoking the agent
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));

const APP = resolve(args.app ?? 'app');
const REPORT = resolve(args.report ?? 'reports/app/report.json');
const OUT = resolve(args.out ?? 'reports/repair');
mkdirSync(OUT, { recursive: true });

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (error) {
  console.error(`repair: cannot read ${REPORT}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const failures = (report.results ?? []).filter((result) => !result.ok && result.required !== false);
if (failures.length === 0) {
  console.log('repair: no required failures in the report; nothing to repair');
  process.exit(0);
}

const failureList = failures
  .map((failure, index) => `${index + 1}. ${failure.name}: ${String(failure.detail ?? '').replace(/\s+/g, ' ').slice(0, 900)}`)
  .join('\n');

const task = `# Repair the generated Northwind Outfitters app in place

The independent verifier ran against the app in this workspace and reported ${failures.length} required
failure(s). The app is already built: do not recreate the project from scratch, and do not change the
fixed contract, URLs, seed credentials or data-testid names.

## Required failures

${failureList}

## Repair rules

- Read the failing files first, then make the smallest root-cause change. Preserve the existing
  backend/frontend structure and the public /api contract.
- React data loading: never put a newly-created object, array or URLSearchParams in a useEffect
  dependency array. Derive the primitives (q, category, minPrice, maxPrice, inStock, sort, page)
  and depend on those, or memoize the object. A catalog that refetches on every render detaches
  product cards and fails the browser checks.
- Both /account/login and /admin/login must expose login-email, login-password and login-submit.
- PUT /api/admin/products/{id} is a full replacement. Accept the complete product body and do not
  treat the product's own SKU or slug as a duplicate.
- Checkout with a valid Bearer token or nw_token cookie must set Order.customerId so GET /api/orders
  lists the order. Guest checkout keeps customerId null.
- Do not modify ci/verify-app.mjs, ci/repair-app.mjs or any verifier task. Do not weaken tests or
  delete checks. Do not leave servers running.
- Before finishing, run \`mvn -q -B test\` in backend/ (0 failures, >= 25 tests) and
  \`npm run build\` in frontend/ (strict TypeScript, no errors).

Final answer: list the files changed, the failure(s) fixed, and the exact commands with their exit
status. If a failure cannot be fixed without violating the contract, explain why.`;

const taskPath = resolve(OUT, 'repair-task.md');
writeFileSync(taskPath, task);
console.log(`repair: ${failures.length} required failure(s); task written to ${taskPath}`);
console.log(task);

if (args['dry-run'] === 'true') {
  console.log('repair: dry run, not invoking the agent');
  process.exit(0);
}

const definition = resolve('examples/full-stack-engineer.agent.json');
const db = resolve(OUT, 'repair.db');
const result = spawnSync(
  'minions-assembler',
  [
    'run',
    '--agentDefinition', definition,
    '--task', task,
    '--db', db,
    '--runDir', APP,
    '--approval', 'autopilot',
    '--no-stream',
    '--output-format', 'json',
  ],
  { stdio: 'inherit', env: process.env },
);

if (result.error) {
  console.error(`repair: could not start minions-assembler: ${result.error.message}`);
  process.exit(1);
}
console.log(`repair: agent exited ${result.status ?? 'unknown'}`);
process.exit(result.status ?? 1);
