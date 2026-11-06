import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test.use({ launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] } });
const inviteCode = 'cloudflare-ui-local-setup-code';
const originalPassword = 'Cloudflare-test-owner-password';
const changedPassword = 'Cloudflare-updated-owner-password';
let mf;
let server;
let base;
let outboundRequests = 0;

// Preserve complete multiline CREATE TRIGGER statements in the deployed schema.
function schemaStatements(source) {
  const result = []; let statement = ''; let trigger = false;
  for (const line of source.split('\n')) {
    if (!line.trim() || /^\s*--/.test(line)) continue;
    statement += line + '\n';
    if (/^\s*CREATE TRIGGER\b/i.test(line)) trigger = true;
    if (trigger ? /^\s*END;\s*$/.test(line) : /;\s*$/.test(line)) { result.push(statement.trim()); statement = ''; trigger = false; }
  }
  if (statement.trim()) throw new Error('Incomplete Cloudflare schema statement.');
  return result;
}

test.beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'hisab-cloudflare-ui',
    modules: [
      { type: 'ESModule', path: fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url)) },
      { type: 'ESModule', path: fileURLToPath(new URL('../server/http-api.js', import.meta.url)) },
    ],
    compatibilityDate: '2026-11-01', d1Databases: ['DB'],
    bindings: { ADMIN_INVITE_CODE: inviteCode },
    outboundService: () => { outboundRequests++; return new Response('External messaging is disabled in UI tests.', { status: 502 }); },
  }));
  const db = await mf.getD1Database('DB');
  for (const statement of schemaStatements(await readFile(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'))) await db.prepare(statement).run();
  const dist = resolve('dist');
  // Browser -> same-origin HTTP bridge -> actual workerd/D1 API. Static assets
  // are the production Vite build; no mocked authentication or application data.
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await mf.dispatchFetch(base + req.url, { method: req.method, headers: req.headers, ...(!['GET','HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
        const bytes = Buffer.from(await response.arrayBuffer());
        response.headers.forEach((value, key) => { if (!['content-length','transfer-encoding'].includes(key)) res.setHeader(key, value); });
        res.writeHead(response.status); res.end(bytes); return;
      }
      let path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://local.test').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
      try { if (!(await stat(path)).isFile()) path = resolve(dist, 'index.html'); }
      catch { path = resolve(dist, 'index.html'); }
      res.writeHead(200, { 'Content-Type': ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(path));
    } catch (error) { res.writeHead(500, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  await mf?.dispose();
});

test('Cloudflare Free owner and worker UI uses browser password proofs and records advances', async ({ page, browser }) => {
  test.setTimeout(60000);
  const errors = [];
  const externalRequests = [];
  const authRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(setup|login|password)$/.test(request.url()) && request.method() === 'POST') authRequests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  const denyExternal = async route => { if (new URL(route.request().url()).origin === base) return route.continue(); externalRequests.push(route.request().url()); return route.abort(); };
  await page.route(/^https?:/, denyExternal);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.getByLabel('Your name', { exact: false }).fill('Yash');
  await page.getByLabel('Business name', { exact: false }).fill('Sai Services');
  await page.getByLabel('Your mobile number', { exact: false }).fill('+12025550100');
  await page.getByLabel('Choose a password', { exact: false }).fill(originalPassword);
  await page.getByLabel('Setup code', { exact: false }).fill(inviteCode);
  await page.getByRole('button', { name: 'Create my register' }).click();
  await expect(page.getByRole('heading', { name: 'Your register, at a glance.' })).toBeVisible();
  const registration = authRequests.find(request => request.path === '/api/setup').body;
  expect(registration).not.toHaveProperty('password');
  expect(registration.clientSalt).toMatch(/^[a-f\d]{32}$/);
  expect(registration.passwordProof).toBe(pbkdf2Sync(originalPassword, Buffer.from(registration.clientSalt, 'hex'), 600000, 32, 'sha256').toString('hex'));

  await page.getByRole('button', { name: 'Add worker', exact: true }).click();
  await page.getByLabel('Worker’s name').fill('Abhay');
  await page.getByLabel('WhatsApp number').fill('+12025550101');
  await page.getByRole('button', { name: 'Add worker', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Record advance', exact: true }).first().click();
  await page.getByLabel('Advance amount in rupees').fill('1250.75');
  await page.getByLabel('Note', { exact: false }).fill('Abhay personal advance');
  await page.getByRole('button', { name: 'Save advance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Advance saved' })).toBeVisible();
  // Validate the prepared URL without opening WhatsApp or submitting a message.
  await expect(page.getByRole('link', { name: 'Open WhatsApp', exact: true })).toHaveAttribute('href', /^https:\/\/wa\.me\/12025550101\?text=/);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const session = await (await page.request.get(base + '/api/session')).json();
  const dashboard = await (await page.request.get(base + '/api/dashboard')).json();
  expect(session.passwordMode).toBe('client-pbkdf2-sha256-600000');
  expect(session.passwordSalt).toBe(registration.clientSalt);
  const abhay = dashboard.workers[0];
  const other = await (await page.request.post(base + '/api/workers', { headers: { 'X-CSRF-Token': session.csrfToken }, data: { name:'Ravi', phone:'+12025550102', contract:'TECHNOEDGE', whatsappConsent:false } })).json();
  expect(other.worker.id).toBeTruthy();
  const otherAdvance = await page.request.post(base + '/api/advances', { headers: { 'X-CSRF-Token': session.csrfToken }, data: { workerId:other.worker.id, amount:'3000',date:dashboard.today,method:'online',note:'Private Ravi entry' } });
  expect(otherAdvance.status()).toBe(201);

  const workerContext = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
  const workerPage = await workerContext.newPage();
  await workerPage.route(/^https?:/, denyExternal);
  await workerPage.goto(`${base}/w/${abhay.shareToken}`);
  await expect(workerPage.getByRole('heading', { name:'Hello, Abhay.' })).toBeVisible();
  await expect(workerPage.getByText('₹1,250.75').first()).toBeVisible();
  await expect(workerPage.getByText('Private Ravi entry')).toHaveCount(0);
  await expect(workerPage.getByRole('button', { name:/edit|save|record/i })).toHaveCount(0);
  expect((await workerPage.request.get(base + '/api/dashboard')).status()).toBe(401);
  const privateData = await (await workerPage.request.get(`${base}/api/worker/${abhay.shareToken}`)).json();
  expect(privateData.advances).toHaveLength(1);
  expect(privateData.worker).not.toHaveProperty('phone');
  expect(privateData.worker).not.toHaveProperty('shareToken');
  await workerContext.close();

  await page.getByRole('button', { name:'Sign out', exact:true }).click();
  await expect(page.getByRole('heading', { name:'Sign in to Hisab' })).toBeVisible();
  await page.getByLabel('Your mobile number', { exact:false }).fill('+12025550100');
  await page.getByLabel(/^Password/).fill(originalPassword);
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page.getByRole('heading', { name:'Your register, at a glance.' })).toBeVisible();
  const login = authRequests.find(request => request.path === '/api/login').body;
  expect(login).not.toHaveProperty('password');
  expect(login.passwordProof).toBe(registration.passwordProof);
  await page.getByRole('button', { name:'Settings', exact:true }).click();
  await page.getByLabel('Current password', { exact:false }).fill(originalPassword);
  await page.getByLabel('New password', { exact:false }).fill(changedPassword);
  await page.getByRole('button', { name:'Change password', exact:true }).click();
  await expect(page.getByText('Password changed. Other signed-in sessions have been signed out.')).toBeVisible();
  const changed = authRequests.find(request => request.path === '/api/password').body;
  expect(changed).not.toHaveProperty('currentPassword');
  expect(changed).not.toHaveProperty('newPassword');
  expect(changed.currentPasswordProof).toBe(registration.passwordProof);
  expect(changed.newClientSalt).not.toBe(registration.clientSalt);
  expect(changed.newPasswordProof).toBe(pbkdf2Sync(changedPassword, Buffer.from(changed.newClientSalt, 'hex'), 600000, 32, 'sha256').toString('hex'));
  await page.getByRole('button', { name:'Sign out', exact:true }).click();
  await expect(page.getByRole('heading', { name:'Sign in to Hisab' })).toBeVisible();
  await page.getByLabel('Your mobile number', { exact:false }).fill('+12025550100');
  await page.getByLabel(/^Password/).fill(changedPassword);
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page.getByRole('heading', { name:'Your register, at a glance.' })).toBeVisible();
  expect(authRequests.filter(request => request.path === '/api/login').at(-1).body.passwordProof).toBe(changed.newPasswordProof);

  const mobileContext = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true, storageState:await page.context().storageState() });
  const mobile = await mobileContext.newPage();
  await mobile.route(/^https?:/, denyExternal);
  await mobile.goto(base);
  await mobile.getByRole('button', { name:'Record advance', exact:true }).first().tap();
  await mobile.getByRole('dialog').locator('select[name="workerId"]').selectOption(abhay.id);
  await mobile.getByLabel('Advance amount in rupees').fill('200');
  await mobile.getByRole('button', { name:'Save advance', exact:true }).tap();
  await expect(mobile.getByRole('heading', { name:'Advance saved' })).toBeVisible();
  await mobile.getByRole('button', { name:'Close dialog' }).tap();
  await expect(mobile.locator('.mobile-message-button').first()).toBeVisible();
  expect(await mobile.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const smallText = await mobile.evaluate(()=>[...document.querySelectorAll('body *')].filter(element=>{
    if (['SCRIPT','STYLE','SVG','PATH'].includes(element.tagName) || ![...element.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim())) return false;
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&parseFloat(style.fontSize)<16;
  }).map(element=>({tag:element.tagName,className:element.className,size:getComputedStyle(element).fontSize})));
  expect(smallText).toEqual([]);
  const artifactDir = process.env.ARTIFACT_DIR || 'test-results/screenshots';
  await mkdir(artifactDir,{recursive:true});
  await mobile.screenshot({path:resolve(artifactDir,'hisab-cloudflare-mobile.png'),fullPage:true,animations:'disabled'});
  await mobileContext.close();
  expect(JSON.stringify(authRequests)).not.toContain(originalPassword);
  expect(JSON.stringify(authRequests)).not.toContain(changedPassword);
  expect(externalRequests).toEqual([]);
  expect(outboundRequests).toBe(0);
  expect(errors).toEqual([]);
});
