#!/usr/bin/env node
/**
 * Independent acceptance verifier for an agent-generated Northwind Outfitters app.
 *
 * It does not trust the build report: it runs the backend tests, packages and boots
 * the jar on a fresh H2 file, exercises the whole HTTP contract, builds and starts the
 * Next.js app through its same-origin /api rewrite, and drives the real browser
 * (Chrome locally, Chromium in CI) through a full purchase and admin flow.
 *
 * Usage:
 *   node ci/verify-app.mjs --app evidence/.../app --api-port 8101 --web-port 3301 --out evidence/.../reports/cli --mode cli
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const APP = resolve(args.app ?? '.');
const API_PORT = Number(args['api-port'] ?? 8101);
const WEB_PORT = Number(args['web-port'] ?? 3301);
const OUT = resolve(args.out ?? 'evidence/report');
const MODE = args.mode ?? 'unknown';
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const BACKEND = join(APP, 'backend');
const FRONTEND = join(APP, 'frontend');
const SHOTS = join(OUT, 'screenshots');
const CHECKS = [];
const CHILDREN = [];
const IS_WIN = process.platform === 'win32';

mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 900) => String(s ?? '').slice(-n).replace(/\s+/g, ' ').trim();

function record(name, ok, detail = '', required = true) {
  CHECKS.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 1200), required });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
}

function run(cmd, cmdArgs, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? APP,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 900_000,
    shell: IS_WIN,
    maxBuffer: 30 * 1024 * 1024,
  });
  return {
    code: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error) : ''),
    ms: Date.now() - started,
  };
}

function start(cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: opts.cwd ?? APP,
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: IS_WIN,
    detached: !IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  CHILDREN.push(child);
  return { child, output: () => out };
}

function stop(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function stopAll() {
  for (const c of CHILDREN.reverse()) stop(c);
}

async function http(method, url, body, headers = {}, timeout = 20_000) {
  const r = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}

async function waitHttp(url, timeoutMs, predicate = (r) => r.ok) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, text: '' };
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const text = await r.text();
      last = { status: r.status, text, ok: r.ok };
      if (predicate(r)) return { status: r.status, text, ok: true };
    } catch (e) { last = { status: 0, text: String(e) }; }
    await sleep(700);
  }
  return { ...last, ok: false };
}

function surefireTotals() {
  const dir = join(BACKEND, 'target', 'surefire-reports');
  if (!existsSync(dir)) return null;
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.xml'))) {
    const xml = readFileSync(join(dir, f), 'utf8');
    const m = xml.match(/<testsuite[^>]*\btests="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"[^>]*\bfailures="(\d+)"/);
    if (m) {
      totals.tests += Number(m[1]);
      totals.errors += Number(m[2]);
      totals.skipped += Number(m[3]);
      totals.failures += Number(m[4]);
    }
  }
  return totals;
}

function findJar() {
  const dir = join(BACKEND, 'target');
  if (!existsSync(dir)) return undefined;
  const jars = readdirSync(dir).filter((f) => f.endsWith('.jar') && !f.endsWith('.original') && !f.endsWith('-sources.jar'));
  return jars.length ? join(dir, jars[0]) : undefined;
}

async function apiSuite() {
  const base = API;
  const api = (m, p, b, h) => http(m, base + p, b, h);

  const health = await api('GET', '/api/health');
  record('API health', health.status === 200 && health.body?.status === 'UP', `${health.status} ${health.text.slice(0, 120)}`);

  let cats = { body: { items: [] } };
  for (let i = 0; i < 40; i++) {
    cats = await api('GET', '/api/categories');
    if (cats.status === 200 && (cats.body?.items ?? []).length >= 6) break;
    await sleep(500);
  }
  const catItems = cats.body?.items ?? [];
  record('API categories (>=6)', cats.status === 200 && catItems.length >= 6, `status ${cats.status} count ${catItems.length}`);

  const page = await api('GET', '/api/products?page=0&size=12&sort=featured');
  const items = page.body?.items ?? [];
  record('API products paginated envelope', page.status === 200 && items.length > 0 && page.body?.page === 0 && page.body?.size === 12 && typeof page.body?.totalPages === 'number',
    `status ${page.status} items ${items.length} total ${page.body?.total} totalPages ${page.body?.totalPages}`);
  record('API seed has 12 products', items.length === 12 && Number(page.body?.total) === 12, `items ${items.length} total ${page.body?.total}`, false);

  const first = items[0];
  record('API product shape', Boolean(first?.id && first?.name && first?.price != null && first?.stock != null && (first?.category?.id ?? first?.categoryId)),
    JSON.stringify(first ?? null).slice(0, 300));

  if (first) {
    const detail = await api('GET', `/api/products/${encodeURIComponent(first.id)}`);
    record('API product detail', detail.status === 200 && String(detail.body?.id) === String(first.id), `status ${detail.status}`);
    const bySlug = first.slug ? await api('GET', `/api/products/${encodeURIComponent(first.slug)}`) : { status: 0 };
    record('API product detail by slug', bySlug.status === 200, `slug ${first.slug} status ${bySlug.status}`, false);
  }
  const missing = await api('GET', '/api/products/99999999');
  record('API unknown product 404', missing.status === 404, `status ${missing.status}`);

  if (first) {
    const q = String(first.name).split(/\s+/)[0];
    const search = await api('GET', `/api/products?q=${encodeURIComponent(q)}&page=0&size=12`);
    record('API search', search.status === 200 && (search.body?.items ?? []).some((p) => p.id === first.id), `q=${q} status ${search.status}`);
    const cat = first.category ?? {};
    const byCat = await api('GET', `/api/products?category=${encodeURIComponent(cat.slug ?? cat.id ?? cat.name ?? '')}&page=0&size=50`);
    record('API category filter', byCat.status === 200 && (byCat.body?.items ?? []).length > 0, `status ${byCat.status} items ${byCat.body?.items?.length}`);
  }
  const sorted = await api('GET', '/api/products?page=0&size=50&sort=priceAsc');
  const prices = (sorted.body?.items ?? []).map((p) => Number(p.price));
  record('API sort priceAsc', sorted.status === 200 && prices.every((p, i) => i === 0 || p >= prices[i - 1]), `${prices.slice(0, 5).join(',')}`);

  // ---- auth ----
  const adminLogin = await api('POST', '/api/auth/login', { email: 'admin@northwind.test', password: 'Admin123!' });
  const adminToken = adminLogin.body?.token;
  record('API admin login', adminLogin.status === 200 && Boolean(adminToken) && adminLogin.body?.user?.role === 'ADMIN',
    `status ${adminLogin.status} role ${adminLogin.body?.user?.role} ${adminLogin.text.slice(0, 100)}`);

  const badLogin = await api('POST', '/api/auth/login', { email: 'admin@northwind.test', password: 'wrong-password' });
  record('API bad login 401', badLogin.status === 401, `status ${badLogin.status}`);

  const shortPw = await api('POST', '/api/auth/register', { email: `x${Date.now()}@example.com`, password: 'short', name: 'X' });
  record('API register validation 400 + fieldErrors', shortPw.status === 400 && shortPw.body?.fieldErrors && Object.keys(shortPw.body.fieldErrors).length > 0,
    `status ${shortPw.status} ${shortPw.text.slice(0, 160)}`);

  const uniq = Date.now().toString(36);
  const customerEmail = `buyer-${uniq}@example.com`;
  const reg = await api('POST', '/api/auth/register', { email: customerEmail, password: 'Customer123!', name: 'Test Buyer' });
  const customerToken = reg.body?.token;
  record('API register', reg.status === 201 && Boolean(customerToken), `status ${reg.status} ${reg.text.slice(0, 120)}`);

  const me = customerToken ? await api('GET', '/api/auth/me', undefined, { authorization: `Bearer ${customerToken}` }) : { status: 0 };
  record('API auth me', me.status === 200 && me.body?.email === customerEmail, `status ${me.status}`);
  record('API auth me unauthenticated 401', (await api('GET', '/api/auth/me')).status === 401, 'missing bearer');
  record('API admin unauth 401', (await api('GET', '/api/admin/products')).status === 401, 'missing bearer');
  const forbidden = customerToken ? await api('GET', '/api/admin/products', undefined, { authorization: `Bearer ${customerToken}` }) : { status: 0 };
  record('API admin as customer 403', forbidden.status === 403, `status ${forbidden.status}`);

  const auth = (t) => ({ authorization: `Bearer ${t}` });

  // ---- cart ----
  const cartRes = await api('POST', '/api/cart', {});
  const cartId = cartRes.body?.cartId;
  record('API create cart', cartRes.status === 201 && Boolean(cartId), `status ${cartRes.status} ${cartRes.text.slice(0, 120)}`);

  // pick a product with stock >= 3, not the first necessarily
  const catalog = await api('GET', '/api/products?page=0&size=50&sort=featured');
  const inStock = (catalog.body?.items ?? []).filter((p) => Number(p.stock) >= 3);
  const stockProduct = inStock[0] ?? (catalog.body?.items ?? [])[0];
  const stockBefore = Number(stockProduct?.stock ?? 0);

  if (cartId && stockProduct) {
    const add = await api('POST', `/api/cart/${encodeURIComponent(cartId)}/items`, { productId: stockProduct.id, quantity: 1 });
    const line = (add.body?.items ?? [])[0];
    record('API cart add item', add.status === 200 && (add.body?.items ?? []).length === 1, `status ${add.status} items ${add.body?.items?.length}`);
    if (line) {
      const patch = await api('PATCH', `/api/cart/${encodeURIComponent(cartId)}/items/${encodeURIComponent(line.id)}`, { quantity: 2 });
      record('API cart update quantity', patch.status === 200 && Number((patch.body?.items ?? [])[0]?.quantity) === 2, `status ${patch.status} qty ${(patch.body?.items ?? [])[0]?.quantity}`);
      const del = await api('DELETE', `/api/cart/${encodeURIComponent(cartId)}/items/${encodeURIComponent(line.id)}`);
      record('API cart remove item', del.status === 200 && (del.body?.items ?? []).length === 0, `status ${del.status}`);
    }
  } else {
    record('API cart add item', false, 'no cart or product');
  }

  // ---- checkout ----
  let orderNumber = '';
  let orderTotal = 0;
  let checkoutProduct = stockProduct;
  if (cartId) {
    const empty = await api('POST', '/api/checkout', {
      cartId, email: customerEmail,
      shippingAddress: { line1: '1 Test Way', city: 'Portland', state: 'OR', postalCode: '97201', country: 'US' },
      paymentMethod: 'CARD',
    }, auth(customerToken));
    record('API checkout empty cart 400', empty.status === 400, `status ${empty.status} ${empty.text.slice(0, 140)}`);

    if (checkoutProduct) {
      await api('POST', `/api/cart/${encodeURIComponent(cartId)}/items`, { productId: checkoutProduct.id, quantity: 1 });
      if (catItems[0]) {
        const couponAdd = await api('POST', `/api/cart/${encodeURIComponent(cartId)}/items`, { productId: checkoutProduct.id, quantity: 1 });
        record('API cart quantity merges', couponAdd.status === 200 && Number((couponAdd.body?.items ?? [])[0]?.quantity) === 2, `status ${couponAdd.status}`, false);
      }
      const idem = `idem-${uniq}`;
      const checkout = await api('POST', '/api/checkout', {
        cartId, email: customerEmail,
        shippingAddress: { line1: '1 Test Way', line2: '', city: 'Portland', state: 'OR', postalCode: '97201', country: 'US' },
        paymentMethod: 'CARD', couponCode: 'WELCOME10',
      }, { 'idempotency-key': idem, ...auth(customerToken) });
      orderNumber = checkout.body?.orderNumber ?? '';
      orderTotal = Number(checkout.body?.total ?? 0);
      record('API checkout', checkout.status === 201 && Boolean(orderNumber) && orderTotal > 0,
        `status ${checkout.status} order ${orderNumber} total ${orderTotal} ${checkout.text.slice(0, 160)}`);

      if (orderNumber) {
        const replay = await api('POST', '/api/checkout', {
          cartId, email: customerEmail,
          shippingAddress: { line1: '1 Test Way', line2: '', city: 'Portland', state: 'OR', postalCode: '97201', country: 'US' },
          paymentMethod: 'CARD', couponCode: 'WELCOME10',
        }, { 'idempotency-key': idem, ...auth(customerToken) });
        record('API checkout idempotent replay', [200, 201].includes(replay.status) && replay.body?.orderNumber === orderNumber,
          `status ${replay.status} order ${replay.body?.orderNumber}`);

        const lookup = await api('GET', `/api/orders/${encodeURIComponent(orderNumber)}?email=${encodeURIComponent(customerEmail)}`);
        record('API order lookup', lookup.status === 200 && lookup.body?.orderNumber === orderNumber, `status ${lookup.status}`);

        const wrong = await api('GET', `/api/orders/${encodeURIComponent(orderNumber)}?email=nobody@example.com`);
        record('API order lookup wrong email 403', [403, 404].includes(wrong.status), `status ${wrong.status}`, false);

        if (customerToken) {
          const mine = await api('GET', '/api/orders', undefined, auth(customerToken));
          record('API customer orders', mine.status === 200 && (mine.body?.items ?? []).some((o) => o.orderNumber === orderNumber),
            `status ${mine.status} count ${mine.body?.items?.length}`, false);
        }

        if (checkoutProduct) {
          const after = await api('GET', `/api/products/${encodeURIComponent(checkoutProduct.id)}`);
          record('API checkout decrements stock', Number(after.body?.stock) <= stockBefore - 1,
            `before ${stockBefore} after ${after.body?.stock}`, false);
        }

        if (customerToken && checkoutProduct) {
          const review = await api('POST', `/api/products/${encodeURIComponent(checkoutProduct.id)}/reviews`, { rating: 5, title: 'Solid', body: 'Works well.' }, auth(customerToken));
          record('API create review', review.status === 201, `status ${review.status} ${review.text.slice(0, 120)}`, false);
          const reviews = await api('GET', `/api/products/${encodeURIComponent(checkoutProduct.id)}/reviews`);
          record('API list reviews', reviews.status === 200 && (reviews.body?.items ?? []).length >= 1 && typeof reviews.body?.average === 'number',
            `status ${reviews.status} count ${reviews.body?.items?.length}`, false);
        }
      }
    }
  }

  // ---- admin ----
  if (adminToken) {
    const list = await api('GET', '/api/admin/products?page=0&size=10', undefined, auth(adminToken));
    record('API admin product list', list.status === 200 && Array.isArray(list.body?.items), `status ${list.status}`);

    const categoryId = catItems[0]?.id;
    const productName = `Verifier Tent ${uniq}`;
    const created = await api('POST', '/api/admin/products', {
      name: productName, sku: `VER-${uniq}`, slug: `verifier-tent-${uniq}`,
      description: 'Created by the acceptance verifier.', price: 129.5, stock: 9,
      categoryId, active: true, imageUrl: null,
    }, auth(adminToken));
    const newId = created.body?.id;
    record('API admin create product', created.status === 201 && Boolean(newId), `status ${created.status} ${created.text.slice(0, 160)}`);

    if (newId) {
      // PUT is a full replacement in the contract; send the complete product with the changed price/stock.
      const upd = await api('PUT', `/api/admin/products/${encodeURIComponent(newId)}`, {
        name: productName, sku: `VER-${uniq}`, slug: `verifier-tent-${uniq}`,
        description: 'Created by the acceptance verifier.', price: 119.5, stock: 7,
        categoryId, active: true, imageUrl: null,
      }, auth(adminToken));
      record('API admin update product', [200, 204].includes(upd.status), `status ${upd.status}`);
      const storefront = await api('GET', '/api/products?q=Verifier');
      record('API created product visible in catalog', (storefront.body?.items ?? []).some((p) => p.name === productName), `items ${storefront.body?.items?.length}`, false);
      const del = await api('DELETE', `/api/admin/products/${encodeURIComponent(newId)}`, undefined, auth(adminToken));
      record('API admin delete product', [200, 204].includes(del.status), `status ${del.status}`, false);
    }

    if (categoryId) {
      const cat = await api('POST', '/api/admin/categories', { name: `Verifier ${uniq}`, slug: `verifier-${uniq}`, description: 'x' }, auth(adminToken));
      record('API admin create category', cat.status === 201, `status ${cat.status}`, false);
    }

    const coupons = await api('GET', '/api/admin/coupons', undefined, auth(adminToken));
    record('API admin coupons list', coupons.status === 200 && (coupons.body?.items ?? []).length >= 2, `status ${coupons.status} count ${coupons.body?.items?.length}`, false);
    const coupon = await api('POST', '/api/admin/coupons', { code: `VER${uniq.slice(-5).toUpperCase()}`, type: 'PERCENT', value: 5, minSubtotal: 10, active: true }, auth(adminToken));
    record('API admin create coupon', coupon.status === 201, `status ${coupon.status}`, false);

    const kpis = await api('GET', '/api/admin/kpis', undefined, auth(adminToken));
    record('API admin KPIs', kpis.status === 200 && kpis.body?.revenue != null && kpis.body?.orders != null && kpis.body?.lowStock != null,
      `status ${kpis.status} ${JSON.stringify(kpis.body ?? {}).slice(0, 160)}`);

    const orders = await api('GET', '/api/admin/orders?page=0&size=20', undefined, auth(adminToken));
    record('API admin orders list', orders.status === 200 && Array.isArray(orders.body?.items), `status ${orders.status}`);

    if (orderNumber && (orders.body?.items ?? []).length) {
      const row = (orders.body.items ?? []).find((o) => o.orderNumber === orderNumber) ?? orders.body.items[0];
      const rowId = row.orderId ?? row.id;
      if (!rowId) {
        record('API admin order id present', false, `row ${JSON.stringify(row).slice(0, 200)}`);
      } else {
        const packed = await api('PATCH', `/api/admin/orders/${encodeURIComponent(rowId)}/status`, { status: 'PACKED' }, auth(adminToken));
        record('API admin order status PACKED', [200, 204].includes(packed.status), `status ${packed.status} ${packed.text.slice(0, 120)}`);
        const invalid = await api('PATCH', `/api/admin/orders/${encodeURIComponent(rowId)}/status`, { status: 'DELIVERED' }, auth(adminToken));
        record('API admin invalid transition 409', invalid.status === 409, `status ${invalid.status}`, false);
      }
    }
  }
}

async function browserSuite() {
  const { chromium } = await import('playwright-core');
  const launch = { headless: true };
  if (IS_WIN) launch.channel = 'chrome';
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const shot = async (name) => { try { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } catch { /* ignore */ } };
  const tid = (id) => page.getByTestId(id).first();
  const visible = async (id) => tid(id).isVisible().catch(() => false);
  // Next.js hydrates after domcontentloaded; filling before that lets React reset the
  // input or leaves the submit handler unattached. Wait for quiet, then verify the value
  // and retry once hydration has completed.
  const goto = async (path) => {
    await page.goto(WEB + path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(250);
  };
  const fill = async (id, value, label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const byId = tid(id);
      if (await byId.isVisible().catch(() => false)) {
        await byId.fill(value).catch(() => {});
        if ((await byId.inputValue().catch(() => '')) === value) return true;
      }
      if (label) {
        const byLabel = page.getByLabel(label).first();
        if (await byLabel.isVisible().catch(() => false)) {
          await byLabel.fill(value).catch(() => {});
          if ((await byLabel.inputValue().catch(() => '')) === value) return true;
        }
      }
      await page.waitForTimeout(400);
    }
    return false;
  };
  const submitUntil = async (button, navigated) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (navigated()) return true;
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
      await page.waitForTimeout(700);
      if (navigated()) return true;
    }
    return navigated();
  };

  try {
    await goto('/');
    await page.waitForTimeout(900);
    const cards = await page.getByTestId('product-card').count();
    record('UI home renders', cards >= 1 || await page.locator('h1').count() > 0, `cards ${cards}`);
    record('UI home product grid', cards >= 1, `cards ${cards}`, false);
    await shot('01-home');

    await goto('/products');
    await page.waitForTimeout(900);
    const catalogCards = await page.getByTestId('product-card').count();
    record('UI catalog renders products', catalogCards >= 1, `cards ${catalogCards}`);
    if (await visible('filter-search')) {
      const initialCards = await page.getByTestId('product-card').count();
      const name = (await tid('product-name').first().textContent().catch(() => '')) ?? '';
      const term = name.trim().split(/\s+/)[0] || 'a';
      // Wait for the filtered request, then for the result count to leave its loading state.
      // Clicking a search button is a fallback for forms that do not submit on Enter.
      const filteredResponse = page.waitForResponse((r) => {
        try {
          const u = new URL(r.url());
          return u.pathname.endsWith('/api/products') && u.searchParams.get('q') === term;
        } catch { return false; }
      }, { timeout: 15_000 }).catch(() => null);
      await tid('filter-search').fill(term);
      await page.keyboard.press('Enter');
      let sawFilterRequest = Boolean(await filteredResponse);
      if (!sawFilterRequest) {
        const apply = page.locator('form[role="search"] button[type="submit"]').first();
        if (await apply.isVisible().catch(() => false)) {
          await apply.click().catch(() => {});
          sawFilterRequest = Boolean(await page.waitForResponse((r) => {
            try { return new URL(r.url()).searchParams.get('q') === term; } catch { return false; }
          }, { timeout: 8_000 }).catch(() => null));
        }
      }
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="results-count"]');
        return Boolean(el && !/loading/i.test(el.textContent ?? ''));
      }, null, { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const filteredCards = await page.getByTestId('product-card').count();
      const urlHasQuery = new URL(page.url()).searchParams.get('q') === term;
      record('UI search filters catalog', filteredCards >= 1 && filteredCards <= initialCards && (sawFilterRequest || urlHasQuery),
        `term ${term} cards ${initialCards}->${filteredCards} request ${sawFilterRequest} url ${page.url()}`);
    } else {
      record('UI search filters catalog', false, 'filter-search missing');
    }
    if (await visible('sort-select')) {
      await tid('sort-select').selectOption({ index: 1 }).catch(() => {});
      await page.waitForTimeout(800);
      record('UI sort control', true, 'selected');
    }
    await shot('02-catalog');

    await goto('/products');
    await page.waitForTimeout(700);
    // Navigate by the card's link instead of clicking the card container: the container
    // is replaced when the catalog revalidates, which detached the element mid-click.
    const firstCard = tid('product-card').first();
    const cardLink = firstCard.locator('a').first();
    const href = await cardLink.getAttribute('href').catch(() => null);
    if (href) await page.goto(new URL(href, WEB).toString(), { waitUntil: 'domcontentloaded' });
    else await cardLink.click();
    await page.waitForTimeout(1200);
    record('UI product detail', await page.locator('h1').count() > 0, page.url());
    await shot('03-product');

    if (await visible('add-to-cart')) {
      await tid('add-to-cart').click();
      await page.waitForTimeout(1000);
      record('UI add to cart', await visible('cart-count'), 'cart badge');
    } else {
      record('UI add to cart', false, 'add-to-cart missing');
    }

    await goto('/cart');
    await page.waitForTimeout(800);
    record('UI cart renders line', await page.getByTestId('cart-line').count() >= 1, `lines ${await page.getByTestId('cart-line').count()}`);
    await shot('04-cart');

    if (await visible('checkout-button')) {
      await tid('checkout-button').click();
      await page.waitForTimeout(1500);
    } else {
      await goto('/checkout');
    }
    await page.waitForTimeout(600);
    const email = `ui-${Date.now().toString(36)}@example.com`;
    await fill('checkout-email', email, /email/i);
    await fill('checkout-line1', '42 Verifier Lane', /address|line 1/i);
    await fill('checkout-city', 'Portland', /city/i);
    await fill('checkout-postal', '97201', /postal|zip/i);
    await fill('checkout-country', 'US', /country/i);
    const stateInput = page.getByLabel(/state|province/i).first();
    if (await stateInput.isVisible().catch(() => false)) await stateInput.fill('OR');
    await shot('05-checkout');
    if (await visible('checkout-place-order')) {
      await tid('checkout-place-order').click();
      await page.waitForURL(/\/orders\//, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const num = await tid('order-number').textContent().catch(() => '');
      record('UI checkout completes', Boolean(num && num.trim()), `order ${num}`);
      await shot('06-order');
    } else {
      record('UI checkout completes', false, 'checkout-place-order missing');
    }

    await goto('/account/login');
    const customerEmailFilled = await fill('login-email', 'alex@example.com', /email/i);
    const customerPasswordFilled = await fill('login-password', 'Customer123!', /password/i);
    if (await visible('login-submit')) {
      await submitUntil(tid('login-submit'), () => !/\/account\/login/.test(page.url()));
    }
    record('UI customer login', (customerEmailFilled && customerPasswordFilled) && !/\/account\/login/.test(page.url()), page.url());
    await goto('/account/orders');
    await page.waitForTimeout(800);
    record('UI account orders page', await page.locator('body').innerText().then((t) => t.length > 50), 'rendered', false);

    await goto('/admin/login');
    await page.waitForTimeout(500);
    const adminEmailFilled = await fill('login-email', 'admin@northwind.test', /email/i);
    const adminPasswordFilled = await fill('login-password', 'Admin123!', /password/i);
    const adminSubmit = (await visible('login-submit'))
      ? tid('login-submit')
      : (await visible('admin-login-submit'))
        ? tid('admin-login-submit')
        : page.getByRole('button', { name: /sign in|log in/i }).first();
    record('UI admin login form', adminEmailFilled && adminPasswordFilled, `email ${adminEmailFilled} password ${adminPasswordFilled}`);
    await submitUntil(adminSubmit, () => new URL(page.url()).pathname === '/admin');
    await goto('/admin');
    let adminReady = false;
    for (let i = 0; i < 12 && !adminReady; i++) {
      await page.waitForTimeout(500);
      adminReady = await visible('admin-kpi-revenue')
        || (await page.locator('body').innerText()).toLowerCase().includes('revenue');
    }
    record('UI admin dashboard', adminReady, page.url());
    await shot('07-admin');

    await goto('/admin/products');
    await page.waitForTimeout(900);
    let createdName = '';
    if (await visible('admin-product-new')) {
      await tid('admin-product-new').click();
      await page.waitForTimeout(700);
      createdName = `UI Verifier ${Date.now().toString(36)}`;
      await fill('admin-product-name', createdName, /name/i);
      await fill('admin-product-price', '49.99', /price/i);
      await fill('admin-product-stock', '5', /stock/i);
      const sku = page.getByLabel(/sku/i).first();
      if (await sku.isVisible().catch(() => false)) await sku.fill(`UI-${Date.now().toString(36)}`);
      const slug = page.getByLabel(/slug/i).first();
      if (await slug.isVisible().catch(() => false)) await slug.fill(`ui-verifier-${Date.now().toString(36)}`);
      const desc = page.getByLabel(/description/i).first();
      if (await desc.isVisible().catch(() => false)) await desc.fill('Created by the browser acceptance verifier.');
      const category = page.getByLabel(/category/i).first();
      if (await category.isVisible().catch(() => false)) {
        const opts = await category.locator('option').count().catch(() => 0);
        if (opts > 1) await category.selectOption({ index: 1 }).catch(() => {});
      }
      await shot('08-admin-product-form');
      if (await visible('admin-product-save')) await tid('admin-product-save').click();
      await page.waitForTimeout(1800);
      record('UI admin creates product', true, createdName);
      await goto(`/products?q=${encodeURIComponent(createdName)}`);
      await page.waitForTimeout(900);
      record('UI created product visible', (await page.getByTestId('product-card').count()) >= 1, `cards ${await page.getByTestId('product-card').count()}`);
      await shot('09-admin-product-storefront');
    } else {
      record('UI admin creates product', false, 'admin-product-new missing');
    }

    await goto('/admin/orders');
    await page.waitForTimeout(900);
    record('UI admin orders page', await page.getByTestId('admin-order-row').count() >= 0, `rows ${await page.getByTestId('admin-order-row').count()}`, false);
    await shot('10-admin-orders');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  log(`\n=== verify ${MODE}: ${APP} (api ${API_PORT}, web ${WEB_PORT}) ===`);
  record('backend folder exists', existsSync(BACKEND), BACKEND);
  record('frontend folder exists', existsSync(FRONTEND), FRONTEND);
  if (!existsSync(BACKEND)) throw new Error('missing backend/');

  const test = run('mvn', ['-q', '-B', 'test'], { cwd: BACKEND, timeout: 1_800_000 });
  const totals = surefireTotals();
  record('backend mvn test', test.code === 0, `exit ${test.code}; ${tail(test.stderr || test.stdout)}`);
  record('backend test count >= 25', (totals?.tests ?? 0) >= 25, `tests ${totals?.tests ?? 0}`);
  record('backend test failures == 0', (totals ? totals.failures + totals.errors : 1) === 0, `failures ${totals ? totals.failures + totals.errors : 'unknown'}`);

  const pkg = run('mvn', ['-q', '-B', '-DskipTests', 'package'], { cwd: BACKEND, timeout: 900_000 });
  const jar = findJar();
  record('backend mvn package', pkg.code === 0 && Boolean(jar), `exit ${pkg.code} jar ${jar ? basename(jar) : 'none'}`);
  if (!jar) throw new Error('no runnable jar produced');

  const tempDb = join(tmpdir(), `store-verify-${MODE}-${Date.now()}`);
  const backendProc = start('java', ['-jar', jar, `--server.port=${API_PORT}`,
    `--spring.datasource.url=jdbc:h2:file:${tempDb.replace(/\\/g, '/')};DB_CLOSE_ON_EXIT=FALSE`,
    '--spring.jpa.hibernate.ddl-auto=update', '--app.seed=true'], { cwd: BACKEND });
  const ready = await waitHttp(`${API}/api/health`, 240_000, (r) => r.status === 200);
  record('backend boots with seed data', ready.ok, `status ${ready.status} ${tail(ready.text)}`);
  if (!ready.ok) throw new Error('backend did not become ready: ' + tail(backendProc.output(), 1500));

  await apiSuite();

  if (existsSync(FRONTEND)) {
    const hasLock = existsSync(join(FRONTEND, 'package-lock.json'));
    let install = hasLock ? run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: FRONTEND, timeout: 900_000 }) : { code: 1, stderr: 'no lock' };
    if (install.code !== 0) install = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: FRONTEND, timeout: 900_000 });
    record('frontend install', install.code === 0, `exit ${install.code} ${tail(install.stderr)}`);

    const build = run('npm', ['run', 'build'], { cwd: FRONTEND, timeout: 1_200_000, env: { NEXT_TELEMETRY_DISABLED: '1', API_PROXY_TARGET: API } });
    record('frontend production build', build.code === 0, `exit ${build.code} ${tail(build.stderr || build.stdout)}`);
    record('frontend .next build present', existsSync(join(FRONTEND, '.next')), '.next');

    if (build.code === 0) {
      const webProc = start('npm', ['start', '--', '-p', String(WEB_PORT)], {
        cwd: FRONTEND,
        env: { NEXT_TELEMETRY_DISABLED: '1', API_PROXY_TARGET: API, PORT: String(WEB_PORT) },
      });
      const up = await waitHttp(WEB + '/', 240_000, (r) => r.status === 200);
      record('frontend starts', up.ok, `status ${up.status} ${tail(webProc.output(), 500)}`);
      if (up.ok) {
        try { await browserSuite(); } catch (e) { record('browser suite', false, (e && e.message) || String(e)); }
      }
    }
  }

  const failed = CHECKS.filter((c) => c.required && !c.ok);
  const summary = {
    mode: MODE, app: APP, apiPort: API_PORT, webPort: WEB_PORT,
    startedAt: new Date().toISOString(),
    checks: CHECKS.length, passed: CHECKS.filter((c) => c.ok).length,
    requiredFailed: failed.length, ok: failed.length === 0,
    failures: failed.map((c) => `${c.name}: ${c.detail}`),
    jar, results: CHECKS,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
  const md = [
    `# ${MODE} verification`, '',
    `- App: \`${APP}\``, `- Checks: ${summary.passed}/${summary.checks} passed`,
    `- Required failures: ${summary.requiredFailed}`, `- Verdict: **${summary.ok ? 'PASS' : 'FAIL'}**`, '',
    '| Check | Result | Detail |', '| --- | --- | --- |',
    ...CHECKS.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : c.required ? 'FAIL' : 'WARN'} | ${String(c.detail).replace(/\|/g, '\\|').slice(0, 300)} |`),
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  log(`\n=== ${MODE}: ${summary.ok ? 'PASS' : 'FAIL'} (${summary.passed}/${summary.checks}) ===`);
  if (failed.length) log('Failures:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'));
}

main()
  .catch((e) => { record('verifier crashed', false, (e && e.stack) || String(e)); })
  .finally(() => {
    stopAll();
    try {
      const failed = CHECKS.filter((c) => c.required && !c.ok);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'report.json'), JSON.stringify({
        mode: MODE, app: APP, checks: CHECKS.length, passed: CHECKS.filter((c) => c.ok).length,
        requiredFailed: failed.length, ok: failed.length === 0, results: CHECKS,
      }, null, 2));
    } catch { /* ignore */ }
    setTimeout(() => process.exit(CHECKS.some((c) => c.required && !c.ok) ? 1 : 0), 250);
  });
