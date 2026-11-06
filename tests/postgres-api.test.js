import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { createNetlifyApp } from '../server/netlify-app.js';
import { createTestPostgresPool } from './helpers/postgres-pool.js';

const origin = 'https://hisab.netlify.test';
const inviteCode = 'postgres-local-owner-setup-code';
const env = { DATABASE_URL: 'postgresql://postgres.test:local-test-password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', ADMIN_INVITE_CODE: inviteCode };
const owner = { name: 'Test Owner', businessName: 'Test Services', phone: '9000000001', password: 'owner-password-for-tests' };
const worker = { name: 'Worker One', phone: '9000000011', contract: 'SANJYOT', whatsappConsent: false };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const options = { timeout: 60000 };
const passwordMode = 'client-pbkdf2-sha256-600000';
const cache = new Map();
function proof(password, salt) {
  const key = `${salt}:${password}`;
  if (!cache.has(key)) cache.set(key, pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'));
  return cache.get(key);
}

async function fixture(t, { roles = false } = {}) {
  const { db, pool } = createTestPostgresPool();
  t.after(() => db.close());
  if (roles) await pool.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  let app = createNetlifyApp({ env, pool });
  let cookie = '', csrf = '', salt = randomBytes(16).toString('hex');
  const f = {
    db, pool,
    get cookie() { return cookie; },
    get csrf() { return csrf; },
    get salt() { return salt; },
    restart() { app = createNetlifyApp({ env, pool }); },
    async request(path, { method = 'GET', body, headers = {}, authenticated = true, csrfToken = csrf, ip = '192.0.2.10' } = {}) {
      const response = await app(new Request(origin + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated && cookie ? { Cookie: cookie } : {}),
          ...(authenticated && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }), { ip });
      const text = await response.text();
      const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
      return { status: response.status, headers: response.headers, data };
    },
    useSession(response) {
      cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
      csrf = response.data.csrfToken || '';
      salt = response.data.passwordSalt || salt;
    },
    setupBody(extra = {}) {
      const { password, ...profile } = owner;
      return { ...profile, inviteCode, clientSalt: salt, passwordProof: proof(password, salt), ...extra };
    },
    async setup(extra = {}) {
      const response = await f.request('/api/setup', { method: 'POST', body: f.setupBody(extra), authenticated: false });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      f.useSession(response);
      return response;
    },
    async login(password = owner.password, extra = {}) {
      return f.request('/api/login', { method: 'POST', body: { phone: owner.phone, passwordProof: proof(password, salt) }, authenticated: false, ...extra });
    },
    async addWorker(extra = {}) {
      const response = await f.request('/api/workers', { method: 'POST', body: { ...worker, ...extra } });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      return response.data.worker;
    },
    advance(workerId, extra = {}, headers = {}) {
      return f.request('/api/advances', { method: 'POST', body: { workerId, amount: '1000.25', date: today(), method: 'cash', note: '', ...extra }, headers });
    },
  };
  return f;
}

test('Netlify/PostgreSQL initializes once, registers one owner, and retains records after a cold start', options, async t => {
  const f = await fixture(t);
  const first = await f.request('/api/session');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data, { authenticated: false, setupRequired: true, needsInviteCode: true, passwordMode, passwordSalt: null });
  assert.equal((await f.request('/api/setup', { method: 'POST', body: f.setupBody({ inviteCode: 'incorrect' }) })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode } })).status, 400, 'Raw-password fallback must remain disabled.');
  const setupBody = f.setupBody();
  const registrations = await Promise.all([0, 1].map(() => f.request('/api/setup', { method: 'POST', body: setupBody, authenticated: false })));
  assert.deepEqual(registrations.map(result => result.status).sort(), [201, 409]);
  const setup = registrations.find(result => result.status === 201);
  f.useSession(setup);
  assert.equal(setup.data.passwordSalt, setupBody.clientSalt);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setup.headers.get('set-cookie').includes(flag));
  const stored = (await f.pool.query('SELECT password_hash FROM hisab.owner')).rows[0].password_hash;
  assert.ok(!stored.includes(owner.password));
  assert.ok(!stored.includes(setupBody.passwordProof));
  const w = await f.addWorker();
  assert.equal((await f.advance(w.id)).status, 201);
  f.restart();
  const dashboard = await f.request('/api/dashboard');
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.data));
  assert.equal(dashboard.data.workers.length, 1);
  assert.equal(dashboard.data.advances[0].amountPaise, 100025);
  assert.equal((await f.request('/.netlify/functions/api/session')).data.authenticated, true, 'The Netlify rewrite must preserve the API route.');
  assert.deepEqual((await f.request('/api/health')).data, { ok: true });
});

test('Netlify/PostgreSQL enforces owner writes, bound values, phone uniqueness, and database role privacy', options, async t => {
  const f = await fixture(t, { roles: true });
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker })).status, 401);
  await f.setup();
  for (const request of [{ csrfToken: '' }, { csrfToken: 'wrong' }, { headers: { Origin: 'https://attacker.test' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) {
    assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, ...request })).status, 403);
  }
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const name = "O'Neil ?; DROP TABLE workers; --";
  const w = await f.addWorker({ name });
  assert.equal(w.name, name);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker })).status, 409);
  for (const extra of [{ amount: '1.001' }, { amount: '-1' }, { date: '2026-02-30' }, { date: '2099-01-01' }, { method: 'cheque' }]) assert.equal((await f.advance(w.id, extra)).status, 400);
  const note = "=HYPERLINK(\"bad\") ? ' --";
  assert.equal((await f.advance(w.id, { note })).status, 201);
  const dashboard = await f.request('/api/dashboard');
  assert.equal(dashboard.data.workers[0].name, name);
  assert.equal(dashboard.data.advances[0].note, note);
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  assert.equal(dashboard.headers.get('referrer-policy'), 'no-referrer');
  const exported = await f.request('/api/export.csv');
  assert.equal(exported.status, 200);
  assert.ok(exported.data.includes('"\'=HYPERLINK('));
  assert.equal((await f.request('/api/export.csv', { authenticated: false })).status, 401);
  const tables = await f.pool.query("SELECT relname,relrowsecurity FROM pg_catalog.pg_class WHERE relnamespace='hisab'::regnamespace AND relkind='r'");
  for (const name of ['owner', 'sessions', 'workers', 'advances', 'audit', 'rate_limits']) assert.equal(tables.rows.find(row => row.relname === name)?.relrowsecurity, true, `${name} enables RLS`);
  for (const role of ['anon', 'authenticated']) {
    const lease = await f.pool.connect();
    try {
      await lease.query(`SET ROLE ${role}`);
      await assert.rejects(lease.query('SELECT * FROM hisab.workers'), error => error.code === '42501');
    } finally { await lease.query('RESET ROLE'); lease.release(); }
  }
});

test('Netlify/PostgreSQL keeps retries, concurrent corrections, cancellation, totals and audit consistent', options, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const clientRequestId = randomUUID();
  const saved = await f.advance(w.id, { clientRequestId });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const a = saved.data.advance;
  const retried = await f.advance(w.id, {}, { 'Idempotency-Key': clientRequestId });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.advance.id, a.id);
  assert.equal((await f.advance(w.id, { amount: '1' }, { 'Idempotency-Key': clientRequestId })).status, 409);
  assert.equal((await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, contract: 'TECHNOEDGE' } })).status, 200);
  const correction = { amount: '1234.56', date: today(), method: 'online', note: 'Corrected', revision: a.revision };
  const corrections = await Promise.all([0, 1].map(() => f.request(`/api/advances/${a.id}`, { method: 'PATCH', body: correction })));
  assert.deepEqual(corrections.map(result => result.status).sort(), [200, 409], JSON.stringify(corrections));
  const corrected = corrections.find(result => result.status === 200).data.advance;
  assert.equal(corrected.amountPaise, 123456);
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.contract, 'SANJYOT');
  assert.equal((await f.request(`/api/advances/${a.id}`, { method: 'PATCH', body: correction })).status, 409);
  const next = await f.advance(w.id, { amount: '2000.50' });
  assert.equal(next.status, 201, JSON.stringify(next.data));
  assert.equal(next.data.advance.contract, 'TECHNOEDGE');
  const reason = "Wrong date, owner corrected O'Neil's entry";
  const voided = await f.request(`/api/advances/${a.id}/void`, { method: 'POST', body: { revision: 2, reason } });
  assert.equal(voided.status, 200, JSON.stringify(voided.data));
  assert.equal(voided.data.advance.voided, true);
  assert.equal((await f.request(`/api/advances/${a.id}/void`, { method: 'POST', body: { revision: 3, reason } })).status, 409);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.advances.length, 2);
  assert.equal(dashboard.workers[0].totalPaise, 200050);
  assert.equal(dashboard.workers[0].monthTotalPaise, 200050);
  assert.equal(typeof dashboard.revision, 'number');
  const audit = await f.request('/api/audit');
  assert.equal(audit.status, 200, JSON.stringify(audit.data));
  for (const action of ['create', 'update', 'void']) assert.equal(audit.data.events.filter(event => event.entityId === a.id && event.action === action).length, 1, action);
  const workerView = (await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).data;
  assert.equal(workerView.totalPaise, 200050);
  assert.equal(workerView.advances.find(entry => entry.id === a.id).voidReason, reason);
  assert.equal(workerView.advances.length, 2);
});

test('Netlify/PostgreSQL private worker views and polling disclose only that worker and rotate safely', options, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const other = await f.addWorker({ name: 'Other Private Worker', phone: '9000000012', contract: 'TECHNOEDGE' });
  assert.equal((await f.advance(w.id, { note: 'Own note' })).status, 201);
  const path = `/api/worker/${w.shareToken}`;
  const first = await f.request(path, { authenticated: false });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.revision, /^[a-f\d]{64}$/);
  assert.equal(first.data.advances.length, 1);
  const revisionPath = `${path}?revision=${first.data.revision}`;
  const unchanged = (await f.request(revisionPath, { authenticated: false })).data;
  assert.deepEqual(unchanged, { unchanged: true, revision: first.data.revision, pollIntervalMs: 60000 });
  assert.equal((await f.advance(other.id, { amount: '9000', note: 'Other worker secret' })).status, 201);
  assert.deepEqual((await f.request(revisionPath, { authenticated: false })).data, unchanged);
  const serialized = JSON.stringify(first.data);
  for (const value of ['Other Private Worker', 'Other worker secret', '919000000011', '919000000001', 'shareToken', 'csrfToken', 'password']) assert.ok(!serialized.includes(value), value);
  assert.equal((await f.request('/api/advances', { method: 'POST', body: { workerId: w.id, amount: '1' }, authenticated: false })).status, 401);
  const rotated = await f.request(`/api/workers/${w.id}/rotate-link`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.worker.shareToken, w.shareToken);
  assert.equal((await f.request(revisionPath, { authenticated: false })).status, 404);
  const current = await f.request(`/api/worker/${rotated.data.worker.shareToken}`, { authenticated: false });
  assert.equal(current.status, 200);
  assert.equal(current.data.advances.length, 1);
});

test('Netlify/PostgreSQL password changes revoke old sessions and trusted IPs control rate limits', options, async t => {
  const f = await fixture(t); await f.setup();
  const originalCookie = f.cookie;
  const second = await f.login();
  assert.equal(second.status, 200, JSON.stringify(second.data));
  const secondCookie = second.headers.get('set-cookie').split(';')[0];
  const password = 'replacement-owner-password';
  const salt = randomBytes(16).toString('hex');
  const changed = await f.request('/api/password', { method: 'POST', body: { currentPasswordProof: proof(owner.password, f.salt), newPasswordProof: proof(password, salt), newClientSalt: salt } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  for (const Cookie of [originalCookie, secondCookie]) assert.equal((await f.request('/api/dashboard', { authenticated: false, headers: { Cookie } })).status, 401);
  f.useSession(changed);
  assert.equal((await f.request('/api/dashboard')).status, 200);
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(password)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await f.login('incorrect-password', { ip: '192.0.2.20', headers: { 'CF-Connecting-IP': `198.51.100.${i + 1}` } })).status, 401);
  assert.equal((await f.login(password, { ip: '192.0.2.20', headers: { 'CF-Connecting-IP': '198.51.100.200' } })).status, 429, 'Client-supplied IP headers must not bypass the trusted context IP.');
  assert.equal((await f.login(password, { ip: '192.0.2.21' })).status, 200);
});

test('Netlify/PostgreSQL prepares WhatsApp text without provider submission or misleading sent status', options, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const saved = await f.advance(w.id);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const a = saved.data.advance;
  const response = await f.request(`/api/advances/${a.id}/message`);
  assert.equal(response.status, 200);
  const url = new URL(response.data.url);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/919000000011');
  assert.equal(url.searchParams.get('text'), response.data.message);
  assert.ok(response.data.message.includes(`${origin}/w/${w.shareToken}`));
  assert.equal(a.notificationStatus, 'not_requested');
  assert.equal((await f.request(`/api/advances/${a.id}/notify`, { method: 'POST', body: {} })).status, 409);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.notificationMode, 'manual');
  assert.equal(dashboard.whatsapp.configured, false);
  assert.equal(dashboard.whatsapp.manualOnly, true);
});
