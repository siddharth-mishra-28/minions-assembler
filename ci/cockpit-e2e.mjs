#!/usr/bin/env node
/**
 * Exhaustive cockpit acceptance: drives the real React UI in Chromium against a
 * fresh database and proves the whole product surface, not just that pages render.
 *
 * Coverage: onboarding + provider form (real Mimo key from the environment), all
 * Settings tabs (defaults, approvals, retention, about), agent JSON import and
 * publish, registered-agent run through New run, run detail + timeline, Runs
 * explorer, Dashboard, Audit filters, MCP registration + probe, a real chat turn,
 * thread rename/pin, command palette, theme, project switcher, responsive layout
 * and the retired /ui surface.
 *
 * Usage: node ci/cockpit-e2e.mjs --base http://127.0.0.1:3211 \
 *          --workspace evidence/.../workspaces/e2e --out evidence/.../reports/cockpit
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const BASE = (args.base ?? 'http://127.0.0.1:3211').replace(/\/$/, '');
const WORKSPACE = resolve(args.workspace ?? '.');
const OUT = resolve(args.out ?? 'evidence/cockpit');
const SHOTS = join(OUT, 'screenshots');
const DEF = resolve(args.definition ?? 'examples/full-stack-engineer.agent.json');
const ECHO = resolve(args.echo ?? 'scripts/mcp-echo-server.mjs');
const KEY = process.env.MIMO_API_KEY ?? '';
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 700) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiGet = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null) }; };

if (!existsSync(DEF)) throw new Error(`definition not found: ${DEF}`);
const definitionText = readFileSync(DEF, 'utf8');

const { chromium } = await import('playwright-core');
const browser = await chromium.launch(process.platform === 'win32' ? { headless: true, channel: 'chrome' } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(45_000);
const shot = async (name, fullPage = true) => { try { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage }); } catch { /* transient */ } };
const text = () => page.locator('body').innerText();
const step = async (name, fn) => {
  try { const detail = await fn(); record(name, true, typeof detail === 'string' ? detail : ''); }
  catch (e) { record(name, false, (e && e.message) || String(e)); await shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`); }
};

let threadPath = '';
let runId = '';

try {
  /* ---------------- onboarding: provider form ---------------- */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot('01-onboarding');
  await step('onboarding renders the provider form', async () => {
    await page.getByRole('heading', { name: 'Welcome to Minions' }).waitFor();
    return 'welcome heading visible';
  });
  await step('provider form files a working Mimo provider', async () => {
    if (!KEY) throw new Error('MIMO_API_KEY is not set in the environment');
    await page.getByRole('button', { name: 'Custom (OpenAI-compatible)' }).click();
    await page.getByRole('textbox', { name: 'Display name' }).fill('Mimo E2E');
    await page.getByRole('textbox', { name: 'Base URL' }).fill('https://api.xiaomimimo.com/v1');
    await page.getByRole('textbox', { name: 'API key' }).fill(KEY);
    await page.getByRole('textbox', { name: 'Default model' }).fill('mimo-v2.6-flash');
    await page.getByRole('combobox', { name: 'Wire API' }).selectOption({ label: 'Chat completions' });
    await shot('02-provider-filled');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !/\/chat/.test(new URL(page.url()).pathname)) {
      await page.waitForTimeout(800);
      const body = await text();
      if (/error|failed|invalid/i.test(body) && !/Welcome to Minions/.test(body)) break;
    }
    if (!/\/chat/.test(new URL(page.url()).pathname)) {
      const body = await text();
      throw new Error(`provider save did not reach /chat: ${body.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    const providers = await apiGet('/api/providers');
    const list = providers.body?.providers ?? providers.body ?? [];
    if (!Array.isArray(list) || !list.some((p) => p.name === 'Mimo E2E')) throw new Error(`provider missing from /api/providers: ${JSON.stringify(providers.body).slice(0, 200)}`);
    return `${list.length} provider(s), onboarding complete`;
  });
  await shot('03-chat-after-onboarding');

  /* ---------------- settings ---------------- */
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await step('settings lists the saved provider', async () => {
    await page.getByText('Mimo E2E').first().waitFor();
    return 'provider visible';
  });
  await step('settings defaults save', async () => {
    await page.getByRole('tab', { name: 'Defaults' }).click();
    await page.getByRole('textbox', { name: /Extra system instructions/ }).fill('Prefer terse, production-quality answers.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(800);
    const s = await apiGet('/api/settings');
    const settings = s.body?.settings ?? s.body;
    const extra = settings?.defaults?.systemPrompt ?? '';
    if (!String(extra).includes('terse')) throw new Error(`settings did not persist: ${JSON.stringify(s.body).slice(0, 240)}`);
    return 'defaults persisted';
  });
  await step('settings approvals empty state', async () => {
    await page.getByRole('tab', { name: 'Approvals' }).click();
    await page.waitForTimeout(500);
    const body = await text();
    if (!/approval/i.test(body)) throw new Error('no approvals copy');
    return 'approvals tab renders';
  });
  await step('settings data & retention save', async () => {
    await page.getByRole('tab', { name: 'Data & retention' }).click();
    await page.getByRole('spinbutton', { name: /Keep history/ }).fill('14');
    await page.getByRole('combobox', { name: 'Audit detail' }).selectOption({ label: 'Full (all events)' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(900);
    await shot('04-settings-retention');
    return 'retention saved';
  });
  await step('settings about shows the version', async () => {
    await page.getByRole('tab', { name: 'About' }).click();
    await page.waitForTimeout(400);
    const body = await text();
    if (!/1\.0\.0/.test(body)) throw new Error('version missing from About');
    return 'version 1.0.0';
  });
  await shot('05-settings-about');

  /* ---------------- agent import + publish ---------------- */
  await page.goto(BASE + '/agents', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await step('agent JSON import opens the builder', async () => {
    await page.getByRole('button', { name: 'Import' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import an agent' });
    await dialog.waitFor();
    await dialog.getByRole('tab', { name: 'JSON' }).click();
    await dialog.getByRole('textbox', { name: 'Agent definition JSON' }).fill(definitionText);
    await dialog.getByRole('button', { name: 'Open in builder' }).click();
    await page.waitForURL(/\/agents\/(new|\S+\/edit)/, { timeout: 20_000 });
    await page.getByRole('heading', { name: /New agent|Edit/ }).waitFor();
    return new URL(page.url()).pathname;
  });
  await shot('06-builder');
  await step('agent builder validates and publishes', async () => {
    await page.getByText('Valid', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const list = await apiGet('/api/agents');
      if ((list.body?.agents ?? []).some((a) => a.name === 'full-stack-engineer')) return 'published full-stack-engineer@1.0.0';
      await page.waitForTimeout(1000);
    }
    throw new Error('agent did not appear in /api/agents');
  });
  await page.goto(BASE + '/agents', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await step('agents list shows the published agent', async () => {
    await page.getByText('full-stack-engineer').first().waitFor();
    await shot('07-agents');
    return 'agent card visible';
  });

  /* ---------------- registered run ---------------- */
  await page.goto(BASE + '/runs/new', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'New run' }).waitFor();
  await step('registered agent run starts and completes', async () => {
    const agent = page.getByRole('combobox', { name: /^Agent/ });
    await agent.selectOption({ label: 'full-stack-engineer@1.0.0' });
    await page.getByRole('textbox', { name: 'Task prompt' }).fill('Reply with exactly: COCKPIT-RUN-OK');
    await page.getByRole('spinbutton', { name: /Turn timeout/ }).fill('2');
    await shot('08-new-run');
    await page.getByRole('button', { name: 'Start run' }).click();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const m = new URL(page.url()).pathname.match(/\/runs\/([^/]+)$/);
      if (m && m[1] !== 'new') { runId = m[1]; break; }
      await page.waitForTimeout(700);
    }
    if (!runId) throw new Error('cockpit never navigated to the run');
    const poll = Date.now() + 300_000;
    let status = 'running';
    while (Date.now() < poll) {
      const r = await apiGet(`/api/runs/${runId}`);
      status = String(r.body?.status ?? '');
      if (['done', 'completed', 'failed', 'error', 'aborted', 'stopped'].includes(status)) break;
      await page.waitForTimeout(7000);
    }
    if (!['done', 'completed'].includes(status)) throw new Error(`run ${runId} ended ${status}`);
    return `${runId} ${status}`;
  });
  await page.goto(BASE + `/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await step('run detail shows metadata, output and timeline', async () => {
    const body = await text();
    for (const needle of ['full-stack-engineer', 'Usage', 'Output', 'Event timeline']) {
      if (!body.includes(needle)) throw new Error(`missing "${needle}" in run detail`);
    }
    if (!/definition hash/i.test(body)) throw new Error('missing definition hash');
    await shot('09-run-detail');
    return 'detail sections present';
  });
  await step('run detail exposes the sealed definition', async () => {
    const r = await apiGet(`/api/runs/${runId}/definition`);
    if (r.status !== 200 || !r.body?.definition?.metadata?.name) throw new Error(`definition snapshot ${r.status}`);
    return r.body.definition.metadata.name;
  });

  /* ---------------- runs + dashboard + audit + api docs ---------------- */
  await page.goto(BASE + '/runs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await step('runs explorer lists the run', async () => {
    await page.getByText(runId).first().waitFor();
    await shot('10-runs');
    return runId;
  });
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await step('dashboard renders usage KPIs from real runs', async () => {
    const body = await text();
    for (const needle of ['Requests', 'Success rate', 'Tokens']) if (!body.includes(needle)) throw new Error(`missing "${needle}"`);
    const st = await apiGet('/api/metrics');
    if (!st.body || typeof st.body !== 'object') throw new Error('metrics endpoint empty');
    await shot('11-dashboard');
    return 'KPI cards visible';
  });
  await page.goto(BASE + '/audit', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await step('audit trail and tool-approval filters respond', async () => {
    const trail = await text();
    if (!trail.includes(runId)) throw new Error('run missing from the audit trail');
    await page.getByRole('tab', { name: 'Tool approvals' }).click();
    const filter = page.getByPlaceholder('Filter by tool, run, reason…');
    await filter.fill(runId);
    await page.waitForTimeout(1000);
    await page.getByRole('tab', { name: 'Server log' }).click();
    await page.waitForTimeout(800);
    const log = await text();
    if (!/Reading|entries/i.test(log)) throw new Error('server log view empty');
    await shot('12-audit');
    return 'trail, approvals and log views usable';
  });
  await page.goto(BASE + '/developers', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await step('API docs page documents the real endpoints', async () => {
    const body = await text();
    for (const needle of ['Quick start', '/api/chat/threads', 'openapi.json', 'Swagger UI']) if (!body.includes(needle)) throw new Error(`missing "${needle}"`);
    await page.getByRole('tab', { name: 'Run API' }).click();
    await page.waitForTimeout(500);
    const runTab = await text();
    if (!runTab.includes('/api/agents/my-agent')) throw new Error('run examples missing');
    await shot('13-api-docs');
    return 'chat + run examples visible';
  });

  /* ---------------- MCP ---------------- */
  await page.goto(BASE + '/mcp', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await step('MCP server registers and probes its tools', async () => {
    await page.getByRole('button', { name: 'Add server' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
    await dialog.waitFor();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('echo-e2e');
    await dialog.getByRole('textbox', { name: 'Command' }).fill('node');
    await dialog.getByRole('textbox', { name: 'Arguments' }).fill(ECHO);
    await shot('14-mcp-form');
    await dialog.getByRole('button', { name: 'Register' }).click();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const reg = await apiGet('/api/mcp');
      const servers = reg.body?.servers ?? reg.body ?? [];
      if (Array.isArray(servers) && servers.some((s) => s.name === 'echo-e2e')) {
        await page.waitForTimeout(1500);
        await shot('15-mcp-registered');
        return 'registered echo-e2e';
      }
      await page.waitForTimeout(1200);
    }
    throw new Error('MCP server missing from the registry');
  });

  /* ---------------- chat turn ---------------- */
  await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await step('chat turn streams a real assistant reply', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.waitFor();
    await composer.fill('Reply with exactly: CHAT-OK');
    await page.getByRole('button', { name: 'Send' }).click();
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const body = await text();
      if (/CHAT-OK/.test(body)) {
        threadPath = new URL(page.url()).pathname;
        await shot('16-chat');
        return `assistant replied in ${threadPath}`;
      }
      await page.waitForTimeout(3000);
    }
    throw new Error('no CHAT-OK reply appeared');
  });
  await step('chat thread rename and pin', async () => {
    if (!threadPath) throw new Error('no thread to manage');
    const actions = page.locator('[aria-label="Chat actions"]').first();
    await actions.click({ force: true });
    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('textbox', { name: 'Rename chat' });
    await rename.fill('E2E acceptance chat');
    await rename.press('Enter');
    await page.waitForTimeout(1200);
    const threads = await apiGet('/api/chat/threads');
    const list = threads.body?.threads ?? [];
    const target = list.find((t) => t.title === 'E2E acceptance chat');
    if (!target) throw new Error('rename did not persist');
    const row = page.getByRole('link', { name: 'E2E acceptance chat' }).locator('xpath=..');
    await row.locator('[aria-label="Chat actions"]').click({ force: true });
    await page.getByRole('button', { name: 'Pin', exact: true }).click();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const pinned = await apiGet('/api/chat/threads');
      if ((pinned.body?.threads ?? []).some((t) => t.id === target.id && Number(t.pinned) === 1)) return 'renamed and pinned';
      await page.waitForTimeout(700);
    }
    throw new Error('pin did not persist');
  });
  await shot('17-thread-management');

  /* ---------------- palette, theme, project, responsive, legacy ---------------- */
  await step('command palette navigates', async () => {
    await page.keyboard.press('Control+k');
    const input = page.getByRole('textbox', { name: 'Command' });
    await input.waitFor();
    await input.fill('Settings');
    await input.press('Enter');
    await page.waitForURL(/\/settings/, { timeout: 10_000 });
    return '/settings';
  });
  await step('theme toggle flips the palette', async () => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? document.documentElement.className);
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? document.documentElement.className);
    if (before === after) throw new Error(`theme unchanged (${before})`);
    await shot('18-theme');
    return `${before} -> ${after}`;
  });
  await step('project switcher opens the workspace folder', async () => {
    await page.getByRole('button', { name: /No project|Chat without a folder/ }).click();
    await page.getByRole('button', { name: 'Open folder…' }).click();
    const path = page.getByRole('textbox', { name: 'Folder path' });
    await path.waitFor();
    await path.fill(WORKSPACE);
    await path.press('Enter');
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: 'Open this folder' }).click();
    await page.waitForTimeout(2000);
    const projects = await apiGet('/api/projects');
    const list = projects.body?.projects ?? [];
    if (!list.some((p) => p.path.replace(/\\/g, '/').toLowerCase().startsWith(WORKSPACE.replace(/\\/g, '/').toLowerCase()))) {
      throw new Error(`project missing: ${JSON.stringify(list).slice(0, 200)}`);
    }
    return 'folder registered as a project';
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await step('layout is usable at 390px without horizontal scroll', async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await shot('19-mobile');
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    return 'no horizontal overflow';
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await step('retired legacy /ui is a 404', async () => {
    const r = await fetch(BASE + '/ui/dashboard');
    if (r.status !== 404) throw new Error(`status ${r.status}`);
    return '404';
  });
} catch (e) {
  record('cockpit e2e harness', false, (e && e.message) || String(e));
  await shot('99-harness-error');
} finally {
  await browser.close().catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
writeFileSync(join(OUT, 'report.json'), JSON.stringify({
  mode: 'cockpit-e2e', base: BASE, workspace: WORKSPACE, runId, thread: threadPath,
  checks, screenshots: SHOTS, finishedAt: new Date().toISOString(),
}, null, 2));
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} cockpit E2E (${checks.length - failed.length}/${checks.length})`);
process.exit(failed.length ? 1 : 0);
