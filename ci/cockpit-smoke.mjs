#!/usr/bin/env node
/**
 * Cockpit smoke test for CI: proves the installed tarball serves the React cockpit,
 * the bundled example imports, onboarding completes, the core pages render and the
 * legacy /ui surface is gone.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const BASE = args.base ?? 'http://127.0.0.1:3110';
const OUT = resolve(args.out ?? 'reports/cockpit');
const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const json = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: parsed, text };
};

const { chromium } = await import('playwright-core');
const browser = await chromium.launch(process.platform === 'win32' ? { headless: true, channel: 'chrome' } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name) => { try { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } catch { /* ignore */ } };

try {
  const template = await json('GET', '/api/templates/default');
  check('bundled example template', template.status === 200 && template.body?.metadata?.name === 'full-stack-engineer', `status ${template.status}`);
  if (template.status === 200) {
    const imported = await json('POST', '/api/agents', { definition: template.body });
    check('import bundled example', [200, 201].includes(imported.status), `status ${imported.status}`);
  }
  const settings = await json('PATCH', '/api/settings', { onboarding: { completed: true } });
  check('complete onboarding', [200, 204].includes(settings.status), `status ${settings.status}`);

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('cockpit root renders', (await page.locator('body').innerText()).includes('Minions'), page.url());
  await shot('01-cockpit');

  for (const [path, name] of [['/agents', 'agents'], ['/runs', 'runs'], ['/runs/new', 'new-run'], ['/settings', 'settings'], ['/dashboard', 'dashboard'], ['/developers', 'api-docs']]) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const text = await page.locator('body').innerText();
    check(`cockpit ${name}`, text.length > 40 && !/can't reach the minions server/i.test(text), `${text.length} chars`);
    await shot(`02-${name}`);
  }

  const legacy = await fetch(BASE + '/ui/dashboard');
  check('legacy /ui is gone', legacy.status === 404, `status ${legacy.status}`);
} catch (e) {
  check('cockpit smoke', false, (e && e.message) || String(e));
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} cockpit smoke (${results.length - failed.length}/${results.length})\n`);
process.exit(failed.length ? 1 : 0);
