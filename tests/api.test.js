import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { createApp } from '../server/app.js';
import { todayInIndia } from '../server/domain.js';

const owner = { name: 'Test Owner', businessName: 'Test Services', phone: '9000000001', password: 'a-test-password-123' };
const worker = { name: 'Worker One', phone: '9000000011', contract: 'SANJYOT', whatsappConsent: false };
const whatsappEnv = {
  PUBLIC_BASE_URL: 'https://hisab.example', WHATSAPP_ACCESS_TOKEN: 'test-token-not-a-real-credential',
  WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_TEMPLATE_NAME: 'advance_entry',
  WHATSAPP_APP_SECRET: 'test-signature-secret', WHATSAPP_VERIFY_TOKEN: 'test-verification-value',
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hisab-api-'));
  const dbPath = join(directory, 'test.sqlite');
  let app;
  let base;
  let cookie = '';
  let csrf = '';
  async function start() {
    app = createApp({ dbPath, env: options.env || {}, fetchImpl: options.fetchImpl });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const api = {
    get db() { return app.db; },
    get cookie() { return cookie; },
    get csrf() { return csrf; },
    get base() { return base; },
    async request(path, { method = 'GET', body, headers = {}, authenticated = true, csrfToken = csrf } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(authenticated && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const content = await response.text();
      const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content;
      return { status: response.status, data, headers: response.headers };
    },
    async setup(extra = {}) {
      const r = await api.request('/api/setup', { method: 'POST', body: { ...owner, ...extra }, authenticated: false });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      cookie = r.headers.get('set-cookie').split(';')[0]; csrf = r.data.csrfToken;
      return r;
    },
    async addWorker(extra = {}) {
      const r = await api.request('/api/workers', { method: 'POST', body: { ...worker, ...extra } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.worker;
    },
    async addAdvance(workerId, extra = {}, headers = {}) {
      return api.request('/api/advances', { method: 'POST', body: { workerId, amount: '1000.25', date: todayInIndia(), method: 'cash', note: '', ...extra }, headers });
    },
    async restart() { await app.close(); await start(); },
    async raw(path, init = {}) { return fetch(base + path, init); },
  };
  return api;
}

test('owner setup is one-time, stores hashed credentials, and login/logout controls access', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/session')).data, { authenticated: false, setupRequired: true, needsInviteCode: false });
  const setup = await f.setup();
  assert.match(setup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(setup.headers.get('set-cookie'), /SameSite=Strict/);
  const stored = f.db.prepare('SELECT * FROM owner').get();
  assert.notEqual(stored.password_hash, owner.password);
  assert.equal(stored.phone, '919000000001');
  assert.equal((await f.request('/api/setup', { method: 'POST', body: owner })).status, 409);
  assert.equal((await f.request('/api/dashboard')).status, 200);
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/dashboard')).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { phone: owner.phone, password: 'wrong' }, authenticated: false })).status, 401);
  const login = await f.request('/api/login', { method: 'POST', body: owner, authenticated: false });
  assert.equal(login.status, 200);
  assert.equal(login.data.profile.phone, '919000000001');
});

test('bootstrap invite protects owner registration and enforces password requirements', async t => {
  const f = await fixture(t, { env: { ADMIN_INVITE_CODE: 'test-setup-code' } });
  assert.equal((await f.request('/api/session')).data.needsInviteCode, true);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: owner })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode: 'test-setup-code', password: 'short' } })).status, 400);
  await f.setup({ inviteCode: 'test-setup-code' });
});

test('production refuses unclaimed owner setup without a bootstrap code', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hisab-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let unsecured;
  try {
    assert.throws(() => {
      unsecured = createApp({ dbPath: join(directory, 'unclaimed.sqlite'), env: { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://hisab.example' } });
    }, /ADMIN_INVITE_CODE/);
  } finally { unsecured?.db.close(); }
  const secured = createApp({ dbPath: join(directory, 'guarded.sqlite'), env: { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://hisab.example', ADMIN_INVITE_CODE: 'test-invite-code' } });
  secured.db.close();
});

test('existing owner can restart in production after bootstrap code is removed', async t => {
  const env = {};
  const f = await fixture(t, { env });
  await f.setup();
  env.NODE_ENV = 'production';
  env.PUBLIC_BASE_URL = 'https://hisab.example';
  await f.restart();
  const session = await f.request('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.setupRequired, false);
  assert.equal(session.data.needsInviteCode, false);
  assert.equal(session.data.profile.businessName, owner.businessName);
});

test('anonymous, cross-origin and missing-CSRF writes are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker })).status, 401);
  await f.setup();
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, csrfToken: '' })).status, 403);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workers').get().n, 0);
});

test('worker phone normalization, unique numbers, contract validation and consent persist', async t => {
  const f = await fixture(t); await f.setup();
  const w = await f.addWorker({ phone: '+91 (90000) 00011', whatsappConsent: true });
  assert.equal(w.phone, '919000000011');
  assert.equal(w.whatsappConsent, true);
  assert.match(w.shareToken, /^[a-f0-9]{64}$/);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker })).status, 409);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: { ...worker, phone: '9000000012', contract: 'unknown' } })).status, 400);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: { ...worker, phone: 'invalid' } })).status, 400);
  const update = await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, name: 'Updated Worker', contract: 'TECHNOEDGE', whatsappConsent: false } });
  assert.equal(update.status, 200);
  assert.equal(update.data.worker.contract, 'TECHNOEDGE');
  assert.equal(update.data.worker.whatsappConsent, false);
});

test('amounts use integer paise, repeated request keys cannot duplicate entries', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const headers = { 'Idempotency-Key': randomUUID() };
  const first = await f.addAdvance(w.id, {}, headers);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.advance.amountPaise, 100025);
  assert.equal(first.data.notification.status, 'not_requested');
  const repeated = await f.addAdvance(w.id, {}, headers);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.advance.id, first.data.advance.id);
  assert.equal((await f.addAdvance(w.id, { amount: '999' }, headers)).status, 409);
  const data = (await f.request('/api/dashboard')).data;
  assert.equal(data.advances.length, 1);
  assert.equal(data.workers[0].totalPaise, 100025);
  assert.equal(data.workers[0].monthTotalPaise, 100025);
});

test('moving a worker to another contract preserves historical entry and export contracts', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const first = await f.addAdvance(w.id);
  assert.equal(first.status, 201);
  const moved = await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, contract: 'TECHNOEDGE' } });
  assert.equal(moved.status, 200);
  const second = await f.addAdvance(w.id, { amount: '2000.50' });
  assert.equal(second.status, 201);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.workers[0].contract, 'TECHNOEDGE');
  assert.equal(dashboard.advances.find(a => a.id === first.data.advance.id).contract, 'SANJYOT');
  assert.equal(dashboard.advances.find(a => a.id === second.data.advance.id).contract, 'TECHNOEDGE');
  const csv = (await f.request('/api/export.csv')).data;
  assert.ok(csv.split('\r\n').find(row => row.includes('"1000.25"')).includes('"SANJYOT"'));
  assert.ok(csv.split('\r\n').find(row => row.includes('"2000.50"')).includes('"TECHNOEDGE"'));
});

test('invalid amounts, methods and calendar dates never create financial entries', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  for (const amount of ['0', '-1', '1.001', '1e3', 'NaN', '10000000.01', 100]) assert.equal((await f.addAdvance(w.id, { amount })).status, 400, String(amount));
  for (const date of ['2026-02-30', '2099-01-01', 'not-a-date', '1999-12-31']) assert.equal((await f.addAdvance(w.id, { date })).status, 400, date);
  assert.equal((await f.addAdvance(w.id, { method: 'cheque' })).status, 400);
  assert.equal((await f.addAdvance(w.id, { note: 'x'.repeat(501) })).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM advances').get().n, 0);
});

test('corrections require current revision, retain audit trail and cannot move workers', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker(); const w2 = await f.addWorker({ name: 'Worker Two', phone: '9000000012' });
  const original = (await f.addAdvance(w.id)).data.advance;
  const body = { amount: '1234.56', date: todayInIndia(), method: 'online', note: 'Corrected amount', revision: original.revision };
  const corrected = await f.request(`/api/advances/${original.id}`, { method: 'PATCH', body });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.advance.amountPaise, 123456);
  assert.equal(corrected.data.advance.revision, 2);
  assert.equal((await f.request(`/api/advances/${original.id}`, { method: 'PATCH', body })).status, 409);
  assert.equal((await f.request(`/api/advances/${original.id}`, { method: 'PATCH', body: { ...body, revision: 2, workerId: w2.id } })).status, 400);
  const events = (await f.request('/api/audit')).data.events;
  assert.ok(events.some(e => e.action === 'update' && e.entityId === original.id));
  const storedEvent = f.db.prepare('SELECT data FROM audit WHERE entity_id=? AND action=?').get(original.id, 'update');
  assert.equal(JSON.parse(storedEvent.data).before.amount_paise, 100025);
});

test('voiding an advance keeps a visible audit record while removing it from totals', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const original = (await f.addAdvance(w.id)).data.advance;
  const path = `/api/advances/${original.id}/void`;
  const valid = { reason: 'Duplicate entry entered by mistake', revision: original.revision };
  assert.equal((await f.request(path, { method: 'POST', body: valid, authenticated: false })).status, 401);
  assert.equal((await f.request(path, { method: 'POST', body: { ...valid, reason: '' } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', body: { ...valid, reason: 'x'.repeat(301) } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', body: { ...valid, revision: 99 } })).status, 409);
  const cancelled = await f.request(path, { method: 'POST', body: valid });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.advance.voided, true);
  assert.equal(cancelled.data.advance.voidReason, valid.reason);
  assert.ok(cancelled.data.advance.voidedAt);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.advances.length, 1);
  assert.equal(dashboard.workers[0].totalPaise, 0);
  assert.equal(dashboard.workers[0].monthTotalPaise, 0);
  const visible = (await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).data;
  assert.equal(visible.totalPaise, 0);
  assert.equal(visible.monthTotalPaise, 0);
  assert.equal(visible.advances.length, 1);
  assert.equal(visible.advances[0].voided, true);
  assert.equal(visible.advances[0].voidReason, valid.reason);
  assert.equal((await f.request(path, { method: 'POST', body: { ...valid, revision: cancelled.data.advance.revision } })).status, 409);
  assert.equal((await f.request(`/api/advances/${original.id}`, { method: 'PATCH', body: { amount: '10', date: todayInIndia(), method: 'cash', note: '', revision: cancelled.data.advance.revision } })).status, 409);
  const notification = await f.request(`/api/advances/${original.id}/notify`, { method: 'POST', body: {} });
  assert.equal(notification.status, 409);
  assert.match(notification.data.error, /void|cancel/i);
  const message = await f.request(`/api/advances/${original.id}/message`);
  assert.equal(message.status, 200);
  assert.match(message.data.message, /cancelled|canceled|voided/i);
  assert.ok((await f.request('/api/audit')).data.events.some(e => e.entityId === original.id && e.action === 'void'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM advances').get().n, 1);
});

test('private worker views expose only own entries and never allow editing', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker(); const w2 = await f.addWorker({ name: 'Other Private Worker', phone: '9000000012', contract: 'TECHNOEDGE' });
  const a = (await f.addAdvance(w.id, { note: 'Own entry' })).data.advance;
  await f.addAdvance(w2.id, { amount: '9000', note: 'Other worker secret note' });
  const result = await f.request(`/api/worker/${w.shareToken}`, { authenticated: false });
  assert.equal(result.status, 200);
  assert.equal(result.data.advances.length, 1);
  assert.equal(result.data.advances[0].id, a.id);
  assert.equal(result.data.worker.name, worker.name);
  assert.equal(result.data.totalPaise, 100025);
  const serialized = JSON.stringify(result.data);
  for (const privateValue of ['Other Private Worker', 'Other worker secret note', '919000000011', '919000000001', 'csrfToken', 'shareToken', 'password']) assert.ok(!serialized.includes(privateValue), privateValue);
  assert.equal((await f.request(`/api/advances/${a.id}`, { method: 'PATCH', body: { amount: '1' }, authenticated: false })).status, 401);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { method: 'POST', body: {}, authenticated: false })).status, 401);
  const rotated = await f.request(`/api/workers/${w.id}/rotate-link`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.worker.shareToken, w.shareToken);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).status, 404);
  assert.equal((await f.request(`/api/worker/${rotated.data.worker.shareToken}`, { authenticated: false })).status, 200);
});

test('manual WhatsApp composes an encoded message and does not claim provider delivery', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; throw new Error('Unexpected provider request'); } });
  await f.setup(); const w = await f.addWorker(); const a = (await f.addAdvance(w.id)).data.advance;
  const prepared = await f.request(`/api/advances/${a.id}/message`);
  assert.equal(prepared.status, 200);
  assert.equal(new URL(prepared.data.url).hostname, 'wa.me');
  assert.equal(new URL(prepared.data.url).pathname, '/919000000011');
  assert.equal(new URL(prepared.data.url).searchParams.get('text'), prepared.data.message);
  assert.ok(prepared.data.message.includes(`/w/${w.shareToken}`));
  assert.match(prepared.data.message, /1,000\.25/);
  assert.equal((await f.request(`/api/advances/${a.id}/notify`, { method: 'POST', body: {} })).status, 409);
  assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test('CSV export preserves decimal values and neutralizes spreadsheet formulas', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker({ name: '=HYPERLINK("bad")' });
  await f.addAdvance(w.id, { note: '@SUM(1,2)' });
  const result = await f.request('/api/export.csv');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /text\/csv/);
  assert.ok(result.data.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(result.data.includes('"\'@SUM(1,2)"'));
  assert.ok(result.data.includes('"1000.25"'));
  assert.equal((await f.request('/api/export.csv', { authenticated: false })).status, 401);
});

test('SQLite records, credentials and private links survive a server restart', async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker(); await f.addAdvance(w.id);
  await f.restart();
  const dashboard = await f.request('/api/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.workers.length, 1);
  assert.equal(dashboard.data.advances[0].amountPaise, 100025);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).data.totalPaise, 100025);
});

test('changing password invalidates earlier sessions and requires current credentials', async t => {
  const f = await fixture(t); await f.setup();
  assert.equal((await f.request('/api/password', { method: 'POST', body: { currentPassword: 'wrong', newPassword: 'a-new-password-123' } })).status, 403);
  const changed = await f.request('/api/password', { method: 'POST', body: { currentPassword: owner.password, newPassword: 'a-new-password-123' } });
  assert.equal(changed.status, 200);
  assert.equal((await f.request('/api/dashboard')).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: owner, authenticated: false })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { phone: owner.phone, password: 'a-new-password-123' }, authenticated: false })).status, 200);
});

test('automatic provider submission requires consent, uses approved template and is deduplicated', async t => {
  const calls = [];
  const f = await fixture(t, { env: whatsappEnv, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ messages: [{ id: 'wamid.test-accepted' }] }); } });
  await f.setup(); const w = await f.addWorker();
  const a = (await f.addAdvance(w.id)).data.advance;
  assert.equal(calls.length, 0);
  assert.equal((await f.request(`/api/advances/${a.id}/notify`, { method: 'POST', body: {} })).status, 409);
  const consent = await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, whatsappConsent: true } });
  assert.equal(consent.status, 200);
  const sent = await f.request(`/api/advances/${a.id}/notify`, { method: 'POST', body: {} });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.notification.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/123456789/messages');
  assert.equal(calls[0].body.to, '919000000011');
  assert.equal(calls[0].body.template.name, 'advance_entry');
  assert.equal(calls[0].body.template.components[0].parameters.length, 5);
  assert.equal(calls[0].body.template.components[0].parameters[4].text, `https://hisab.example/w/${w.shareToken}`);
  assert.equal((await f.request(`/api/advances/${a.id}/notify`, { method: 'POST', body: {} })).status, 409);
  assert.equal(calls.length, 1);
  assert.equal((await f.request('/api/dashboard')).data.advances[0].notificationStatus, 'accepted');
});

test('provider failure preserves financial record and never leaks provider error details', async t => {
  const f = await fixture(t, { env: whatsappEnv, fetchImpl: async () => Response.json({ error: { code: 131026, message: 'SECRET_PROVIDER_DETAIL' } }, { status: 400 }) });
  await f.setup(); const w = await f.addWorker({ whatsappConsent: true });
  const saved = await f.addAdvance(w.id);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.advance.amountPaise, 100025);
  assert.equal(saved.data.notification.status, 'failed');
  assert.ok(!JSON.stringify(saved.data).includes('SECRET_PROVIDER_DETAIL'));
  assert.equal((await f.request('/api/dashboard')).data.advances.length, 1);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).data.advances.length, 1);
});

test('signed webhook alone advances accepted to delivered/read without status regression', async t => {
  const f = await fixture(t, { env: whatsappEnv, fetchImpl: async () => Response.json({ messages: [{ id: 'wamid.webhook-test' }] }) });
  await f.setup(); const w = await f.addWorker({ whatsappConsent: true }); const a = (await f.addAdvance(w.id)).data.advance;
  assert.equal(a.notificationStatus, 'accepted');
  async function webhook(status, signed = true) {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.webhook-test', status }] } }] }] });
    const signature = 'sha256=' + createHmac('sha256', whatsappEnv.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    return f.raw('/api/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signed ? signature : 'sha256=' + '0'.repeat(64) }, body: raw });
  }
  assert.equal((await webhook('delivered', false)).status, 403);
  assert.equal((await f.request('/api/dashboard')).data.advances[0].notificationStatus, 'accepted');
  assert.equal((await webhook('delivered')).status, 200);
  assert.equal((await f.request('/api/dashboard')).data.advances[0].notificationStatus, 'delivered');
  assert.equal((await webhook('read')).status, 200);
  assert.equal((await webhook('sent')).status, 200);
  assert.equal((await webhook('failed')).status, 200);
  assert.equal((await f.request('/api/dashboard')).data.advances[0].notificationStatus, 'read');
  const verifyPath = '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verification-value&hub.challenge=challenge123';
  assert.equal((await f.request(verifyPath, { authenticated: false })).data, 'challenge123');
  assert.equal((await f.request(verifyPath.replace('test-verification-value', 'wrong'), { authenticated: false })).status, 403);
});
