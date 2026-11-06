import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://hisab.test';
const inviteCode = 'local-workers-test-setup-code';
const owner = { name: 'Test Owner', businessName: 'Test Services', phone: '9000000001', password: 'owner-password-for-tests' };
const worker = { name: 'Worker One', phone: '9000000011', contract: 'SANJYOT', whatsappConsent: false };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const testOptions = { timeout: 45_000 };
const passwordMode = 'client-pbkdf2-sha256-600000';
const proofCache = new Map();
function passwordProof(password, salt) {
  const key = salt + ':' + password;
  if (!proofCache.has(key)) proofCache.set(key, pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'));
  return proofCache.get(key);
}

// D1's exec() separates queries on newlines. Keep each trigger (including its
// internal semicolons) together when loading the actual deployment schema.
function schemaStatements(source) {
  const statements = [];
  let statement = '';
  let trigger = false;
  for (const line of source.split('\n')) {
    if (!line.trim() || /^\s*--/.test(line)) continue;
    statement += line + '\n';
    if (/^\s*CREATE TRIGGER\b/i.test(line)) trigger = true;
    if (trigger ? /^\s*END;\s*$/.test(line) : /;\s*$/.test(line)) {
      statements.push(statement.trim());
      statement = '';
      trigger = false;
    }
  }
  assert.equal(statement.trim(), '', 'All deployment SQL statements must be complete.');
  return statements;
}

async function fixture(t, { bindings = {} } = {}) {
  let outboundRequests = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'hisab-test',
    modules: true,
    scriptPath: fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url)),
    compatibilityDate: '2026-11-01',
    d1Databases: ['DB'],
    bindings: { ADMIN_INVITE_CODE: inviteCode, ...bindings },
    // Never contact real providers from an integration test.
    outboundService: () => {
      outboundRequests++;
      return new Response('External requests disabled in tests.', { status: 502 });
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const schema = await readFile(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');
  for (const statement of schemaStatements(schema)) await db.prepare(statement).run();
  let cookie = '';
  let csrf = '';
  let passwordSalt = randomBytes(16).toString('hex');
  const api = {
    get cookie() { return cookie; },
    get csrf() { return csrf; },
    get passwordSalt() { return passwordSalt; },
    get outboundRequests() { return outboundRequests; },
    async request(path, { method = 'GET', body, headers = {}, authenticated = true, csrfToken = csrf } = {}) {
      const response = await mf.dispatchFetch(origin + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated && cookie ? { Cookie: cookie } : {}),
          ...(authenticated && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const content = await response.text();
      const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content;
      return { status: response.status, data, headers: response.headers };
    },
    useSession(response) {
      cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
      csrf = response.data.csrfToken || '';
      passwordSalt = response.data.passwordSalt || passwordSalt;
    },
    async setup(extra = {}) {
      const { password, ...profile } = owner;
      const response = await api.request('/api/setup', { method: 'POST', body: { ...profile, inviteCode, passwordProof: passwordProof(password, passwordSalt), clientSalt: passwordSalt, ...extra }, authenticated: false });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      api.useSession(response);
      return response;
    },
    async login(password = owner.password) {
      return api.request('/api/login', { method: 'POST', body: { phone: owner.phone, passwordProof: passwordProof(password, passwordSalt) }, authenticated: false });
    },
    async addWorker(extra = {}) {
      const response = await api.request('/api/workers', { method: 'POST', body: { ...worker, ...extra } });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      return response.data.worker;
    },
    async addAdvance(workerId, extra = {}, headers = {}) {
      return api.request('/api/advances', { method: 'POST', body: { workerId, amount: '1000.25', date: today(), method: 'cash', note: '', ...extra }, headers });
    },
  };
  return api;
}

test('Cloudflare owner setup requires its secret, accepts one owner and controls sessions', testOptions, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/session')).data, { authenticated: false, setupRequired: true, needsInviteCode: true, passwordMode, passwordSalt: null });
  assert.equal((await f.request('/api/setup', { method: 'POST', body: owner })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode } })).status, 400, 'Plaintext-only authentication must be rejected.');
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode, clientSalt: f.passwordSalt, passwordProof: 'invalid' } })).status, 400);
  const { password, ...profile } = owner;
  const setupBody = { ...profile, inviteCode, passwordProof: passwordProof(password, f.passwordSalt), clientSalt: f.passwordSalt };
  const registrations = await Promise.all([0, 1].map(() => f.request('/api/setup', { method: 'POST', body: setupBody, authenticated: false })));
  assert.deepEqual(registrations.map(response => response.status).sort(), [201, 409], 'Concurrent setup must create exactly one owner.');
  const setup = registrations.find(response => response.status === 201);
  f.useSession(setup);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setup.headers.get('set-cookie').includes(flag), flag);
  assert.equal(setup.data.profile.phone, '919000000001');
  assert.equal(setup.data.passwordMode, passwordMode);
  assert.equal(setup.data.passwordSalt, f.passwordSalt);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode } })).status, 409);
  assert.equal((await f.request('/api/dashboard')).status, 200);
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/dashboard')).status, 401);
  assert.equal((await f.login('incorrect-password')).status, 401);
  const login = await f.login();
  assert.equal(login.status, 200, JSON.stringify(login.data));
  f.useSession(login);
  assert.equal((await f.request('/api/session')).data.authenticated, true);
});

test('Cloudflare registration fails closed when its setup secret is missing', testOptions, async t => {
  const f = await fixture(t, { bindings: { ADMIN_INVITE_CODE: '' } });
  const response = await f.request('/api/setup', { method: 'POST', body: { ...owner, inviteCode } });
  assert.equal(response.status, 503);
  assert.match(response.data.error, /setup code|ADMIN_INVITE_CODE/i);
  assert.equal((await f.request('/api/session')).data.setupRequired, true);
});

test('Cloudflare rejects anonymous, cross-origin, missing-CSRF and non-JSON writes', testOptions, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker })).status, 401);
  await f.setup();
  for (const options of [{ csrfToken: '' }, { csrfToken: 'incorrect' }, { headers: { Origin: 'https://attacker.test' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) {
    assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, ...options })).status, 403);
  }
  assert.equal((await f.request('/api/workers', { method: 'POST', body: worker, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const dashboard = await f.request('/api/dashboard');
  assert.deepEqual(dashboard.data.workers, []);
  assert.match(dashboard.headers.get('cache-control'), /no-store/);
  assert.equal(dashboard.headers.get('referrer-policy'), 'no-referrer');
});

test('Cloudflare normalizes worker phones, prevents duplicates and validates contracts', testOptions, async t => {
  const f = await fixture(t); await f.setup();
  const w = await f.addWorker({ phone: '+91 (90000) 00011', whatsappConsent: true });
  assert.equal(w.phone, '919000000011');
  assert.equal(w.whatsappConsent, true);
  assert.match(w.shareToken, /^[a-f\d]{64}$/);
  for (const [extra, status] of [[{}, 409], [{ phone: 'invalid' }, 400], [{ phone: '9000000012', contract: 'Unknown' }, 400], [{ phone: '9000000012', whatsappConsent: 'yes' }, 400]]) {
    assert.equal((await f.request('/api/workers', { method: 'POST', body: { ...worker, ...extra } })).status, status);
  }
  const update = await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, name: 'Updated Worker', contract: 'TECHNOEDGE' } });
  assert.equal(update.status, 200);
  assert.equal(update.data.worker.contract, 'TECHNOEDGE');
  assert.equal(update.data.worker.whatsappConsent, false);
});

test('Cloudflare stores exact paise and deduplicates retried advance requests', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const clientRequestId = randomUUID();
  const first = await f.addAdvance(w.id, { clientRequestId });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.advance.amountPaise, 100025);
  assert.equal(first.data.notification.status, 'not_requested');
  const repeated = await f.addAdvance(w.id, {}, { 'Idempotency-Key': clientRequestId });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.advance.id, first.data.advance.id);
  assert.equal((await f.addAdvance(w.id, { amount: '999' }, { 'Idempotency-Key': clientRequestId })).status, 409);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.advances.length, 1);
  assert.equal(dashboard.workers[0].totalPaise, 100025);
  assert.equal(dashboard.workers[0].monthTotalPaise, 100025);
  assert.equal((await f.request('/api/audit')).data.events.filter(e => e.entityId === first.data.advance.id && e.action === 'create').length, 1);
});

test('Cloudflare rejects invalid money, payment methods and calendar dates without saving', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  for (const amount of ['0', '-1', '1.001', '1e3', 'NaN', '10000000.01', 100]) assert.equal((await f.addAdvance(w.id, { amount })).status, 400, String(amount));
  for (const date of ['2026-02-30', '2099-01-01', 'not-a-date', '1999-12-31']) assert.equal((await f.addAdvance(w.id, { date })).status, 400, date);
  assert.equal((await f.addAdvance(w.id, { method: 'cheque' })).status, 400);
  assert.equal((await f.addAdvance(w.id, { note: 'x'.repeat(501) })).status, 400);
  assert.deepEqual((await f.request('/api/dashboard')).data.advances, []);
});

test('Cloudflare preserves contract snapshots and rejects stale edits or moving an entry', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const other = await f.addWorker({ name: 'Worker Two', phone: '9000000012' });
  const original = await f.addAdvance(w.id);
  assert.equal(original.status, 201, JSON.stringify(original.data));
  const id = original.data.advance.id;
  assert.equal((await f.request(`/api/workers/${w.id}`, { method: 'PATCH', body: { ...worker, contract: 'TECHNOEDGE' } })).status, 200);
  const body = { amount: '1234.56', date: today(), method: 'online', note: 'Amount corrected', revision: original.data.advance.revision };
  const corrections = await Promise.all([0, 1].map(() => f.request(`/api/advances/${id}`, { method: 'PATCH', body })));
  assert.deepEqual(corrections.map(response => response.status).sort(), [200, 409], 'Only one concurrent correction with the same revision may succeed.');
  const corrected = corrections.find(response => response.status === 200);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.advance.amountPaise, 123456);
  assert.equal(corrected.data.advance.contract, 'SANJYOT');
  assert.equal(corrected.data.advance.revision, 2);
  assert.equal((await f.request(`/api/advances/${id}`, { method: 'PATCH', body })).status, 409);
  assert.equal((await f.request(`/api/advances/${id}`, { method: 'PATCH', body: { ...body, revision: 2, workerId: other.id } })).status, 400);
  const next = await f.addAdvance(w.id, { amount: '2000.50' });
  assert.equal(next.status, 201);
  assert.equal(next.data.advance.contract, 'TECHNOEDGE');
  const csv = (await f.request('/api/export.csv')).data;
  assert.ok(csv.split('\r\n').find(row => row.includes('"1234.56"')).includes('"SANJYOT"'));
  assert.ok(csv.split('\r\n').find(row => row.includes('"2000.50"')).includes('"TECHNOEDGE"'));
  assert.equal((await f.request('/api/audit')).data.events.filter(e => e.entityId === id && e.action === 'update').length, 1);
});

test('Cloudflare cancellation retains history and audit while removing advances from totals', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const saved = await f.addAdvance(w.id);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const a = saved.data.advance;
  const path = `/api/advances/${a.id}/void`;
  const body = { reason: 'Duplicate entry by mistake', revision: a.revision };
  assert.equal((await f.request(path, { method: 'POST', body: { ...body, reason: '' } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', body: { ...body, revision: 99 } })).status, 409);
  const result = await f.request(path, { method: 'POST', body });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.advance.voided, true);
  assert.equal(result.data.advance.voidReason, body.reason);
  assert.ok(result.data.advance.voidedAt);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.advances.length, 1);
  assert.equal(dashboard.workers[0].totalPaise, 0);
  assert.equal(dashboard.workers[0].monthTotalPaise, 0);
  const visible = await f.request(`/api/worker/${w.shareToken}`, { authenticated: false });
  assert.equal(visible.data.totalPaise, 0);
  assert.equal(visible.data.advances.length, 1);
  assert.equal(visible.data.advances[0].voided, true);
  assert.equal((await f.request(path, { method: 'POST', body: { ...body, revision: 2 } })).status, 409);
  assert.equal((await f.request(`/api/advances/${a.id}`, { method: 'PATCH', body: { amount: '1', date: today(), method: 'cash', note: '', revision: 2 } })).status, 409);
  assert.ok((await f.request('/api/audit')).data.events.some(e => e.entityId === a.id && e.action === 'void'));
  assert.match((await f.request(`/api/advances/${a.id}/message`)).data.message, /CANCELLED/);
});

test('Cloudflare worker links expose only their records, cannot edit and can be replaced', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const other = await f.addWorker({ name: 'Other Private Worker', phone: '9000000012', contract: 'TECHNOEDGE' });
  const own = await f.addAdvance(w.id, { note: 'Own record' });
  assert.equal(own.status, 201, JSON.stringify(own.data));
  assert.equal((await f.addAdvance(other.id, { amount: '9000', note: 'Other worker secret note' })).status, 201);
  const result = await f.request(`/api/worker/${w.shareToken}`, { authenticated: false });
  assert.equal(result.status, 200);
  assert.equal(result.data.advances.length, 1);
  assert.equal(result.data.advances[0].id, own.data.advance.id);
  assert.equal(result.data.totalPaise, 100025);
  const serialized = JSON.stringify(result.data);
  for (const value of ['Other Private Worker', 'Other worker secret note', '919000000011', '919000000001', 'csrfToken', 'shareToken', 'password']) assert.ok(!serialized.includes(value), value);
  assert.equal((await f.request(`/api/advances/${own.data.advance.id}`, { method: 'PATCH', body: { amount: '1' }, authenticated: false })).status, 401);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { method: 'POST', body: {}, authenticated: false })).status, 401);
  const rotated = await f.request(`/api/workers/${w.id}/rotate-link`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.worker.shareToken, w.shareToken);
  assert.equal((await f.request(`/api/worker/${w.shareToken}`, { authenticated: false })).status, 404);
  assert.equal((await f.request(`/api/worker/${rotated.data.worker.shareToken}`, { authenticated: false })).status, 200);
});

test('Cloudflare prepares free WhatsApp messages without submitting them to a provider', testOptions, async t => {
  const f = await fixture(t); await f.setup(); const w = await f.addWorker();
  const saved = await f.addAdvance(w.id);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const id = saved.data.advance.id;
  const prepared = await f.request(`/api/advances/${id}/message`);
  assert.equal(prepared.status, 200);
  const url = new URL(prepared.data.url);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/919000000011');
  assert.equal(url.searchParams.get('text'), prepared.data.message);
  assert.ok(prepared.data.message.includes(`${origin}/w/${w.shareToken}`));
  assert.match(prepared.data.message, /1,000\.25/);
  const notify = await f.request(`/api/advances/${id}/notify`, { method: 'POST', body: {} });
  assert.equal(notify.status, 409);
  assert.match(notify.data.error, /Open WhatsApp|free/i);
  const dashboard = (await f.request('/api/dashboard')).data;
  assert.equal(dashboard.notificationMode, 'manual');
  assert.equal(dashboard.whatsapp.configured, false);
  assert.equal(dashboard.advances[0].notificationStatus, 'not_requested');
  assert.equal(f.outboundRequests, 0);
});

test('Cloudflare CSV export preserves decimals and neutralizes spreadsheet formulas', testOptions, async t => {
  const f = await fixture(t); await f.setup();
  const w = await f.addWorker({ name: '=HYPERLINK("bad")' });
  assert.equal((await f.addAdvance(w.id, { note: '@SUM(1,2)' })).status, 201);
  const exported = await f.request('/api/export.csv');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.ok(exported.data.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(exported.data.includes('"\'@SUM(1,2)"'));
  assert.ok(exported.data.includes('"1000.25"'));
  assert.equal((await f.request('/api/export.csv', { authenticated: false })).status, 401);
});

test('Cloudflare password changes revoke other owner sessions and require current credentials', testOptions, async t => {
  const f = await fixture(t); await f.setup();
  const originalCookie = f.cookie;
  const other = await f.login();
  assert.equal(other.status, 200);
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  const newPassword = 'another-owner-password-123';
  const newClientSalt = randomBytes(16).toString('hex');
  const body = { currentPasswordProof: passwordProof(owner.password, f.passwordSalt), newPasswordProof: passwordProof(newPassword, newClientSalt), newClientSalt };
  assert.equal((await f.request('/api/password', { method: 'POST', body: { ...body, currentPasswordProof: passwordProof('incorrect-password', f.passwordSalt) } })).status, 403);
  const changed = await f.request('/api/password', { method: 'POST', body });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.passwordSalt, newClientSalt);
  for (const Cookie of [originalCookie, otherCookie]) assert.equal((await f.request('/api/dashboard', { authenticated: false, headers: { Cookie } })).status, 401);
  f.useSession(changed);
  assert.equal((await f.request('/api/dashboard')).status, 200);
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(newPassword)).status, 200);
});

test('Cloudflare revision checks refresh changed records and keep unchanged worker polling private', testOptions, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/revision', { authenticated: false })).status, 401);
  await f.setup();
  const w = await f.addWorker();
  const other = await f.addWorker({ name: 'Other Private Worker', phone: '9000000012' });
  const created = await f.addAdvance(w.id);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const ownerRevision = await f.request('/api/revision');
  assert.equal(ownerRevision.status, 200);
  assert.equal(typeof ownerRevision.data.revision, 'number');
  assert.equal((await f.request('/api/dashboard')).data.revision, ownerRevision.data.revision);

  const path = `/api/worker/${w.shareToken}`;
  const full = await f.request(path, { authenticated: false });
  assert.equal(full.status, 200);
  assert.match(full.data.revision, /^[a-f\d]{64}$/);
  assert.equal(full.data.pollIntervalMs, 60000);
  const revisionPath = `${path}?revision=${full.data.revision}`;
  const unchanged = await f.request(revisionPath, { authenticated: false });
  assert.deepEqual(unchanged.data, { unchanged: true, revision: full.data.revision, pollIntervalMs: 60000 });
  assert.equal((await f.addAdvance(other.id, { note: 'Other worker secret note' })).status, 201);
  const unrelated = await f.request(revisionPath, { authenticated: false });
  assert.deepEqual(unrelated.data, unchanged.data);
  assert.ok(!JSON.stringify(unrelated.data).includes('Other worker'));
  assert.ok((await f.request('/api/revision')).data.revision > ownerRevision.data.revision);

  const edited = await f.request(`/api/advances/${created.data.advance.id}`, {
    method: 'PATCH', body: { amount: '1234.56', date: today(), method: 'cash', note: 'Corrected', revision: created.data.advance.revision },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const refreshed = await f.request(revisionPath, { authenticated: false });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.revision, full.data.revision);
  assert.equal(refreshed.data.unchanged, undefined);
  assert.equal(refreshed.data.advances.length, 1);
  assert.equal(refreshed.data.advances[0].amountPaise, 123456);
  assert.ok(!JSON.stringify(refreshed.data).includes('Other worker secret note'));
  const rotated = await f.request(`/api/workers/${w.id}/rotate-link`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.equal((await f.request(revisionPath, { authenticated: false })).status, 404);
});
