#!/usr/bin/env node
/**
 * UI-mode acceptance: drive the real cockpit in Chromium.
 *
 * Opens New run -> Inline definition, pastes the Full Stack Engineer definition,
 * supplies the phase task, audit level, turn budget and working directory, presses
 * Start run, follows the automatic navigation to /runs/:id, and waits (through the
 * public API) until the run reaches a terminal state. Screenshots and a JSON report
 * are written so the artifact can be audited after the fact.
 *
 * Usage:
 *   node ci/ui-mode-run.mjs --base http://127.0.0.1:3210 \
 *     --definition examples/full-stack-engineer.agent.json \
 *     --task ci/tasks/backend.md --label backend --run-dir app \
 *     --out evidence/.../reports/ui/phase-a --timeout-min 120
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));

const BASE = (args.base ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
const DEF_PATH = resolve(args.definition ?? 'examples/full-stack-engineer.agent.json');
const TASK_PATH = resolve(args.task ?? '');
const LABEL = args.label ?? 'ui';
const WORKSPACE = resolve(args.workspace ?? '.');
const RUN_DIR = args['run-dir'] ? resolve(WORKSPACE, args['run-dir']) : '';
const OUT = resolve(args.out ?? `evidence/ui-mode/${LABEL}`);
const TIMEOUT_MIN = Number(args['timeout-min'] ?? 120);
const WAIT_MS = Number(args['wait-ms'] ?? 7_500_000);
const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(DEF_PATH)) throw new Error(`definition not found: ${DEF_PATH}`);
if (!TASK_PATH || !existsSync(TASK_PATH)) throw new Error(`task file not found: ${TASK_PATH}`);
const definitionText = readFileSync(DEF_PATH, 'utf8');
const task = readFileSync(TASK_PATH, 'utf8');
JSON.parse(definitionText);

const { chromium } = await import('playwright-core');
const browser = await chromium.launch(process.platform === 'win32' ? { headless: true, channel: 'chrome' } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(60_000);
const shot = async (name, fullPage = true) => {
  try { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage }); } catch { /* window may be mid-navigation */ }
};

const startedAt = Date.now();
let runId = '';
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const skip = page.getByRole('button', { name: 'Skip for now' });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(800);
  }
  await shot('01-cockpit');

  await page.goto(BASE + '/runs/new', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'New run' }).waitFor();
  await page.getByRole('tab', { name: 'Inline definition' }).click();
  await page.waitForTimeout(300);

  const areas = page.locator('textarea');
  await areas.nth(0).fill(definitionText);
  await page.waitForTimeout(400);
  const invalid = await page.getByText(/Invalid JSON/i).count();
  record('inline definition parses in the UI', invalid === 0, invalid ? 'UI reported Invalid JSON' : 'no parse error');

  await areas.nth(1).fill(task);
  await page.getByRole('spinbutton', { name: /Turn timeout/i }).fill(String(TIMEOUT_MIN));
  await page.getByRole('textbox', { name: /Working directory/i }).fill(RUN_DIR);
  await page.waitForTimeout(300);
  await shot('02-filled');

  const start = page.getByRole('button', { name: 'Start run' });
  await start.waitFor();
  if (await start.isDisabled()) throw new Error('Start run stayed disabled after a valid definition and task');
  await start.click();

  const deadline = Date.now() + 180_000;
  const runPath = () => {
    const p = new URL(page.url()).pathname;
    const hit = p.match(/\/runs\/([^/]+)$/);
    return hit && hit[1] !== 'new' ? hit[1] : '';
  };
  while (Date.now() < deadline && !runPath()) {
    await page.waitForTimeout(800);
    const body = await page.locator('body').innerText().catch(() => '');
    const failure = body.match(/runDir must be inside[^\n]*|Run failed to start[^\n]*|Invalid request body[^\n]*/i);
    if (failure) {
      await shot('03-start-rejected');
      throw new Error(`cockpit rejected the run: ${failure[0]}`);
    }
  }
  const m = [null, runPath()];
  const path = new URL(page.url()).pathname;
  if (!m) {
    await shot('03-start-failed');
    const body = await page.locator('body').innerText();
    throw new Error(`cockpit did not navigate to the run: ${body.slice(0, 400)}`);
  }
  runId = decodeURIComponent(m[1]);
  record('run submitted through the cockpit', true, runId);
  await page.waitForTimeout(1500);
  await shot('03-running');

  const seen = [];
  let run;
  const pollDeadline = Date.now() + WAIT_MS;
  while (Date.now() < pollDeadline) {
    const r = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}`);
    if (!r.ok) throw new Error(`GET /api/runs/${runId} -> ${r.status}`);
    run = await r.json();
    const status = String(run.status ?? '');
    if (seen[seen.length - 1] !== status) { seen.push(status); console.log(`  status: ${status}`); }
    if (['done', 'completed', 'failed', 'error', 'aborted', 'stopped'].includes(status)) break;
    if (Date.now() % 60000 < 2500) await shot(`04-progress-${seen.length}`);
    await sleep(10_000);
  }
  const status = String(run?.status ?? 'unknown');
  record('run reached a terminal state', ['done', 'completed', 'failed', 'error', 'aborted', 'stopped'].includes(status), status);
  record('run completed successfully', ['done', 'completed'].includes(status), status);

  // Wait for the detail page to render the finished run before the final capture.
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const text = await page.locator('body').innerText();
  record('run detail renders the finished run', text.includes(runId), runId);
  await shot('05-complete');

  const events = await (await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/events`)).json();
  const kinds = (events.events ?? []).map((e) => e.type);
  record('audit events recorded', kinds.length > 5, `${kinds.length} events`);
  record('session and usage captured', kinds.includes('session.create') && kinds.some((k) => String(k).startsWith('assistant.usage')), kinds.filter((k) => k.startsWith('assistant.')).join(','));
  writeFileSync(join(OUT, 'events.json'), JSON.stringify(events, null, 2));
  writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 2));
} catch (e) {
  record('UI mode run', false, (e && e.message) || String(e));
  await shot('99-error');
} finally {
  await browser.close().catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
const report = {
  mode: 'ui', label: LABEL, base: BASE, definition: DEF_PATH, task: TASK_PATH,
  runId, status: checks.find((c) => c.name === 'run completed successfully')?.detail ?? 'unknown',
  durationMs: Date.now() - startedAt, checks, screenshots: SHOTS,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} UI mode ${LABEL} (${checks.length - failed.length}/${checks.length}) runId=${runId || 'none'}`);
process.exit(failed.length ? 1 : 0);
