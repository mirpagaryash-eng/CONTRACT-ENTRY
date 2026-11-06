import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { createNetlifyApp } from '../server/netlify-app.js';
import { createTestPostgresPool } from './helpers/postgres-pool.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test.use({ launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] }, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const inviteCode = 'netlify-ui-local-owner-setup-code';
const password = 'Netlify-browser-owner-password';
let db, pool, app, server, base;
const env = { DATABASE_URL: 'postgresql://postgres.test:local-test-password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', ADMIN_INVITE_CODE: inviteCode };

test.beforeAll(async () => {
  ({ db, pool } = createTestPostgresPool());
  app = createNetlifyApp({ env, pool });
  const dist = resolve('dist');
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await app(new Request(base + req.url, {
          method: req.method,
          headers: req.headers,
          ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
        }), { ip: '127.0.0.1' });
        response.headers.forEach((value, key) => { if (!['content-length', 'transfer-encoding'].includes(key)) res.setHeader(key, value); });
        res.writeHead(response.status);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, base).pathname));
      if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
      try { if (!(await stat(path)).isFile()) path = resolve(dist, 'index.html'); }
      catch { path = resolve(dist, 'index.html'); }
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(path));
    } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Local browser test bridge failed.' })); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  await db?.close();
});

test('Netlify/PostgreSQL mobile owner records an advance and another browser sees only its private worker history', async ({ page, browser }) => {
  test.setTimeout(60000);
  const errors = [], externalRequests = [], authRequests = [];
  const denyExternal = async route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/setup$/.test(request.url()) && request.method() === 'POST') authRequests.push(request.postDataJSON()); });
  await page.route(/^https?:/, denyExternal);
  await page.goto(base);
  await page.getByLabel('Your name', { exact: false }).fill('Test Owner');
  await page.getByLabel('Business name', { exact: false }).fill('Test Services');
  await page.getByLabel('Your mobile number', { exact: false }).fill('+12025550100');
  await page.getByLabel('Choose a password', { exact: false }).fill(password);
  await page.getByLabel('Setup code', { exact: false }).fill(inviteCode);
  await page.getByRole('button', { name: 'Create my register' }).tap();
  await expect(page.getByRole('heading', { name: 'Your register, at a glance.' })).toBeVisible();
  expect(authRequests).toHaveLength(1);
  expect(authRequests[0]).not.toHaveProperty('password');
  expect(authRequests[0].passwordProof).toBe(pbkdf2Sync(password, Buffer.from(authRequests[0].clientSalt, 'hex'), 600000, 32, 'sha256').toString('hex'));
  await page.getByRole('button', { name: 'Add worker', exact: true }).tap();
  await page.getByLabel('Worker’s name').fill('Test Worker');
  await page.getByLabel('WhatsApp number').fill('+12025550101');
  await page.getByRole('button', { name: 'Add worker', exact: true }).last().tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Record advance', exact: true }).first().tap();
  await page.getByLabel('Advance amount in rupees').fill('220.50');
  await page.getByLabel('Note', { exact: false }).fill('Own private worker entry');
  await page.getByRole('button', { name: 'Save advance', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Advance saved' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open WhatsApp', exact: true })).toHaveAttribute('href', /^https:\/\/wa\.me\/12025550101\?text=/);
  await page.getByRole('button', { name: 'Close dialog' }).tap();
  const session = await (await page.request.get(base + '/api/session')).json();
  const dashboard = await (await page.request.get(base + '/api/dashboard')).json();
  const ownWorker = dashboard.workers[0];
  expect(ownWorker.totalPaise).toBe(22050);
  const other = await (await page.request.post(base + '/api/workers', { headers: { 'X-CSRF-Token': session.csrfToken }, data: { name: 'Other Private Worker', phone: '+12025550102', contract: 'TECHNOEDGE', whatsappConsent: false } })).json();
  const savedOther = await page.request.post(base + '/api/advances', { headers: { 'X-CSRF-Token': session.csrfToken }, data: { workerId: other.worker.id, amount: '3000', date: dashboard.today, method: 'online', note: 'Secret other worker entry' } });
  expect(savedOther.status()).toBe(201);
  // The next request uses a new function instance and the same persistent DB.
  app = createNetlifyApp({ env, pool });
  const workerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const workerPage = await workerContext.newPage();
  workerPage.on('pageerror', error => errors.push(error.message));
  await workerPage.route(/^https?:/, denyExternal);
  await workerPage.goto(`${base}/w/${ownWorker.shareToken}`);
  await expect(workerPage.getByRole('heading', { name: 'Hello, Test.' })).toBeVisible();
  await expect(workerPage.getByText('₹220.50').first()).toBeVisible();
  await expect(workerPage.getByText('Own private worker entry')).toBeVisible();
  await expect(workerPage.getByText('Secret other worker entry')).toHaveCount(0);
  await expect(workerPage.getByRole('button', { name: /edit|save|record/i })).toHaveCount(0);
  expect((await workerPage.request.get(base + '/api/dashboard')).status()).toBe(401);
  for (const mobile of [page, workerPage]) {
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const smallText = await mobile.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(element.tagName) || ![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return false;
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && parseFloat(style.fontSize) < 16;
    }).map(element => ({ tag: element.tagName, className: element.className, size: getComputedStyle(element).fontSize })));
    expect(smallText).toEqual([]);
  }
  await workerContext.close();
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});
