// Same-origin Workers + D1 API. No paid services or automatic message submission.
const encoder = new TextEncoder();
const SESSION_MS = 12 * 60 * 60 * 1000;
const PASSWORD_MODE = 'client-pbkdf2-sha256-600000';
const whatsapp = Object.freeze({ configured: false, templateName: null, webhookReady: false, manualOnly: true });
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) || [], n => parseInt(n, 16));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
function sameBytes(a, b) {
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}
export const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const money = paise => 'INR ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const displayDate = date => new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
}).format(new Date(date + 'T00:00:00+05:30'));
function textField(value, label, max = 80, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new HttpError(400, `${label} must ${optional ? '' : 'not be empty and '}contain at most ${max} characters.`);
  return value.trim();
}
function normalizePhone(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid mobile number.');
  const stripped = value.trim().replace(/[\s()-]/g, '');
  const number = /^\d{10}$/.test(stripped) ? '91' + stripped : stripped.replace(/^\+/, '');
  if (!/^[1-9]\d{7,14}$/.test(number)) throw new HttpError(400, 'Enter a 10-digit Indian mobile number or an international number with its country code.');
  return number;
}
function workerInput(body) {
  const name = textField(body.name, 'Worker name');
  const phone = normalizePhone(body.phone);
  if (!['SANJYOT', 'TECHNOEDGE'].includes(body.contract)) throw new HttpError(400, 'Choose SANJYOT or TECHNOEDGE.');
  if (body.whatsappConsent !== undefined && typeof body.whatsappConsent !== 'boolean') throw new HttpError(400, 'WhatsApp consent must be yes or no.');
  return { name, phone, contract: body.contract, consent: body.whatsappConsent ? 1 : 0 };
}
export function advanceInput(body, today = todayInIndia()) {
  if (typeof body.amount !== 'string' || !/^\d{1,8}(\.\d{1,2})?$/.test(body.amount.trim())) throw new HttpError(400, 'Enter an amount with up to two decimal places.');
  const [rupees, decimals = ''] = body.amount.trim().split('.');
  const amountPaise = Number(rupees) * 100 + Number(decimals.padEnd(2, '0'));
  if (amountPaise <= 0 || amountPaise > 1_000_000_000) throw new HttpError(400, 'Amount must be greater than zero and at most INR 1,00,00,000.');
  const date = body.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || date < '2000-01-01' || date > today)
    throw new HttpError(400, 'Choose a valid date, today or earlier.');
  if (!['cash', 'online'].includes(body.method)) throw new HttpError(400, 'Choose Cash or Online.');
  return { amountPaise, date, method: body.method, note: textField(body.note ?? '', 'Note', 500, true) };
}
function passwordProof(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) throw new HttpError(400, 'A valid password proof is required. Refresh the app and try again.');
  return unhex(value);
}
function clientSalt(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{32}$/i.test(value)) throw new HttpError(400, 'A valid password salt is required. Refresh the app and try again.');
  return value.toLowerCase();
}
async function saltedProofHash(proof, salt) {
  const bytes = new Uint8Array(salt.length + proof.length);
  bytes.set(salt); bytes.set(proof, salt.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
// The browser performs PBKDF2-SHA256 with 600,000 iterations. The proof is a
// password-equivalent TLS credential; it is never persisted or sent elsewhere.
// The DB stores only a separately salted digest, so a DB-only password guess
// still requires the client's full PBKDF2 work. This avoids synchronous KDF work
// exceeding the Workers Free CPU allowance. No raw-password fallback exists.
async function proofHash(value) {
  const proof = passwordProof(value); const salt = crypto.getRandomValues(new Uint8Array(16));
  return `proof-sha256:${hex(salt)}:${hex(await saltedProofHash(proof, salt))}`;
}
async function proofMatches(value, stored) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value) || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts[0] !== 'proof-sha256' || !/^[a-f\d]{32}$/.test(parts[1] || '') || !/^[a-f\d]{64}$/.test(parts[2] || '')) return false;
  return sameBytes(await saltedProofHash(unhex(value), unhex(parts[1])), unhex(parts[2]));
}
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function secureResponse(response, request, privateResponse = false) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (privateResponse) { headers.set('Cache-Control', 'no-store'); headers.set('Pragma', 'no-cache'); }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Use JSON for this request.');
  if (Number(request.headers.get('Content-Length')) > 65536) throw new HttpError(413, 'This request is too large.');
  const reader = request.body?.getReader();
  let length = 0; const chunks = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); throw new HttpError(413, 'This request is too large.'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object.');
  return body;
}
function checkOrigin(request) {
  const supplied = request.headers.get('Origin');
  if (supplied && supplied !== new URL(request.url).origin) throw new HttpError(403, 'This request came from a different website.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
}
const profile = owner => owner ? { name: owner.name, businessName: owner.business_name, phone: owner.phone } : null;
const changeCount = result => Number(result.meta?.changes || 0);
const unchanged = () => ({ status: 'not_requested' });

function composeMessage(owner, worker, advance, origin) {
  const workerUrl = `${origin}/w/${worker.share_token}`;
  const message = advance.voided
    ? `${owner.business_name}\n\nHi ${worker.name},\nAdvance entry CANCELLED: ${money(advance.amount_paise)}\nOriginal date: ${displayDate(advance.date)}\nReason: ${advance.void_reason}\n\nThis entry is excluded from your advance total. View your updated private history:\n${workerUrl}\n\nPlease contact ${owner.name} if any detail needs correction.`
    : `${owner.business_name}\n\nHi ${worker.name},\n${advance.revision > 1 ? 'Updated advance entry' : 'Advance recorded'}: ${money(advance.amount_paise)}\nDate: ${displayDate(advance.date)}\nPayment method: ${advance.method === 'cash' ? 'Cash' : 'Online'}${advance.note ? `\nNote: ${advance.note}` : ''}\n\nView your private advance history:\n${workerUrl}\n\nThis records an advance; it does not transfer money. Please contact ${owner.name} if any detail needs correction.`;
  return { message, url: `https://wa.me/${worker.phone}?text=${encodeURIComponent(message)}` };
}

async function api(request, env) {
  const db = env.DB;
  if (!db) throw new HttpError(503, 'The shared database has not been connected yet.');
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  const stmt = (sql, ...values) => db.prepare(sql).bind(...values);
  const first = (sql, ...values) => stmt(sql, ...values).first();
  const all = async (sql, ...values) => (await stmt(sql, ...values).all()).results;
  const owner = () => first('SELECT * FROM owner WHERE id=1');
  const auditRevision = async () => (await first('SELECT COALESCE(MAX(rowid),0) AS revision FROM audit')).revision;
  const workerById = async id => {
    const worker = typeof id === 'string' ? await first('SELECT * FROM workers WHERE id=?', id) : null;
    if (!worker) throw new HttpError(404, 'Worker not found.'); return worker;
  };
  const advanceById = async id => {
    const advance = await first('SELECT * FROM advances WHERE id=?', id);
    if (!advance) throw new HttpError(404, 'Advance not found.'); return advance;
  };
  const workerJson = async (worker, totals = null) => {
    const sums = totals || await first('SELECT COALESCE(SUM(amount_paise),0) AS total,COALESCE(SUM(CASE WHEN substr(date,1,7)=? THEN amount_paise ELSE 0 END),0) AS month,COUNT(*) AS count FROM advances WHERE worker_id=? AND voided=0', todayInIndia().slice(0, 7), worker.id);
    return { id: worker.id, name: worker.name, phone: worker.phone, contract: worker.contract, shareToken: worker.share_token, whatsappConsent: !!worker.whatsapp_consent, createdAt: worker.created_at, totalPaise: sums.total, monthTotalPaise: sums.month, advanceCount: sums.count };
  };
  const advanceJson = async (advance, joinedWorker = null) => {
    const worker = joinedWorker || await workerById(advance.worker_id);
    return { id: advance.id, workerId: advance.worker_id, amountPaise: advance.amount_paise, date: advance.date, method: advance.method, note: advance.note, createdAt: advance.created_at, updatedAt: advance.updated_at, revision: advance.revision, workerName: worker.name, workerPhone: worker.phone, contract: advance.contract, voided: !!advance.voided, voidReason: advance.void_reason, voidedAt: advance.voided_at, notificationStatus: 'not_requested', notificationError: null };
  };
  const session = async () => {
    const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)hisab_session=([a-f\d]{64})(?:;|$)/);
    return match ? first('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', await hash(match[1]), Date.now()) : null;
  };
  const sessionCookie = (value, expired = false) => `hisab_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${expired ? 0 : 43200}${url.protocol === 'https:' ? '; Secure' : ''}`;
  const sessionResponse = async (status, expectedHash) => {
    const value = token(); const csrf = token(); const timestamp = Date.now();
    const results = await db.batch([
      stmt('DELETE FROM sessions WHERE expires_at<=?', timestamp),
      stmt('INSERT INTO sessions(token_hash,csrf,expires_at) SELECT ?,?,? FROM owner WHERE id=1 AND password_hash=?', await hash(value), csrf, timestamp + SESSION_MS, expectedHash),
    ]);
    if (!changeCount(results[1])) throw new HttpError(409, 'The password changed in another session. Please sign in again.');
    const account = await owner();
    return json(status, { authenticated: true, setupRequired: false, csrfToken: csrf, profile: profile(account), passwordMode: PASSWORD_MODE, passwordSalt: account.client_salt }, { 'Set-Cookie': sessionCookie(value) });
  };
  const limit = async (key, maximum = 10) => {
    const timestamp = Date.now();
    const id = await hash(`${key}:${request.headers.get('CF-Connecting-IP') || 'local'}`);
    await stmt('DELETE FROM rate_limits WHERE expires_at<=?', timestamp).run();
    const result = await first('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count', id, timestamp + 15 * 60 * 1000, timestamp, timestamp);
    if (result.count > maximum) throw new HttpError(429, 'Too many attempts. Please try again in 15 minutes.');
  };

  if (path === '/api/health' && method === 'GET') return json(200, { ok: true });
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) checkOrigin(request);
  if (path === '/api/session' && method === 'GET') {
    const [current, account] = await Promise.all([session(), owner()]);
    return json(200, { authenticated: !!current, setupRequired: !account, needsInviteCode: true, passwordMode: PASSWORD_MODE, passwordSalt: account?.client_salt || null, ...(current ? { csrfToken: current.csrf, profile: profile(account) } : {}) });
  }
  if (path === '/api/setup' && method === 'POST') {
    await limit('setup');
    if (await owner()) throw new HttpError(409, 'The owner account is already set up. Please sign in.');
    if (typeof env.ADMIN_INVITE_CODE !== 'string' || !env.ADMIN_INVITE_CODE.trim()) throw new HttpError(503, 'The owner setup code has not been configured. Set the ADMIN_INVITE_CODE secret before opening registration.');
    const body = await jsonBody(request);
    if (!sameBytes(unhex(await hash(typeof body.inviteCode === 'string' ? body.inviteCode : '')), unhex(await hash(env.ADMIN_INVITE_CODE)))) throw new HttpError(403, 'The setup code is incorrect.');
    const name = textField(body.name, 'Your name'); const business = textField(body.businessName, 'Business name'); const phone = normalizePhone(body.phone);
    const salt = clientSalt(body.clientSalt); const password = await proofHash(body.passwordProof); const timestamp = now();
    const result = await stmt('INSERT INTO owner(id,name,business_name,phone,password_hash,client_salt,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', name, business, phone, password, salt, timestamp, timestamp).run();
    if (!changeCount(result)) throw new HttpError(409, 'The owner account is already set up. Please sign in.');
    return sessionResponse(201, password);
  }
  if (path === '/api/login' && method === 'POST') {
    await limit('login'); const body = await jsonBody(request); const account = await owner();
    let phone = ''; try { phone = normalizePhone(body.phone); } catch { /* Use the same credential error. */ }
    const matches = account ? await proofMatches(body.passwordProof, account.password_hash) : false;
    const current = await owner();
    if (!account || !matches || account.phone !== phone || !current || current.password_hash !== account.password_hash || current.phone !== phone) throw new HttpError(401, 'The mobile number or password is incorrect.');
    return sessionResponse(200, account.password_hash);
  }
  const publicWorker = path.match(/^\/api\/worker\/([a-f\d]{64})$/);
  if (publicWorker && method === 'GET') {
    const worker = await first('SELECT w.*,o.business_name AS business_name,o.updated_at AS business_updated_at FROM workers w JOIN owner o ON o.id=1 WHERE w.share_token=?', publicWorker[1]);
    if (!worker) throw new HttpError(404, 'This private link is invalid or has been replaced. Ask the owner for a new link.');
    const today = todayInIndia();
    // Each worker has a private counter: unrelated workers' entries must not
    // disclose activity or force a history scan. The public day handles rollover.
    const revision = await hash(JSON.stringify([worker.id, worker.revision, worker.business_updated_at, worker.business_name, today]));
    if (url.searchParams.get('revision') === revision) return json(200, { unchanged: true, revision, pollIntervalMs: 60000 });
    const [sums, entries] = await Promise.all([
      workerJson(worker), all('SELECT * FROM advances WHERE worker_id=? ORDER BY date DESC,created_at DESC', worker.id),
    ]);
    const advances = entries.map(a => ({ id: a.id, amountPaise: a.amount_paise, date: a.date, method: a.method, note: a.note, contract: a.contract, voided: !!a.voided, voidReason: a.void_reason, voidedAt: a.voided_at, updatedAt: a.updated_at, revision: a.revision }));
    return json(200, { businessName: worker.business_name, worker: { name: worker.name, contract: worker.contract }, advances, totalPaise: sums.totalPaise, monthTotalPaise: sums.monthTotalPaise, today, revision, pollIntervalMs: 60000 });
  }

  const currentSession = await session();
  if (!currentSession) throw new HttpError(401, 'Please sign in to continue.');
  if (!['GET', 'HEAD'].includes(method) && request.headers.get('X-CSRF-Token') !== currentSession.csrf) throw new HttpError(403, 'Your session has changed. Refresh this page and try again.');
  if (path === '/api/logout' && method === 'POST') {
    await jsonBody(request); await stmt('DELETE FROM sessions WHERE token_hash=?', currentSession.token_hash).run();
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', true) });
  }
  if (path === '/api/revision' && method === 'GET') return json(200, { revision: await auditRevision() });
  if (path === '/api/dashboard' && method === 'GET') {
    // Aggregate and join in SQL: a long history must not exhaust D1 Free's
    // per-invocation query limit with one lookup per worker or advance.
    // Capture the revision first. A concurrent later mutation then makes the
    // next cheap poll refresh again instead of marking stale data as current.
    const revision = await auditRevision();
    const [account, workers, advances] = await Promise.all([
      owner(),
      all('SELECT w.*,COALESCE(SUM(a.amount_paise),0) AS total,COALESCE(SUM(CASE WHEN substr(a.date,1,7)=? THEN a.amount_paise ELSE 0 END),0) AS month,COUNT(a.id) AS count FROM workers w LEFT JOIN advances a ON a.worker_id=w.id AND a.voided=0 GROUP BY w.id ORDER BY w.name COLLATE NOCASE', todayInIndia().slice(0, 7)),
      all('SELECT a.*,w.name AS worker_name,w.phone AS worker_phone FROM advances a JOIN workers w ON w.id=a.worker_id ORDER BY a.date DESC,a.created_at DESC'),
    ]);
    return json(200, { profile: profile(account), workers: await Promise.all(workers.map(worker => workerJson(worker, worker))), advances: await Promise.all(advances.map(advance => advanceJson(advance, { name: advance.worker_name, phone: advance.worker_phone }))), today: todayInIndia(), revision, notificationMode: 'manual', whatsapp });
  }
  if (path === '/api/audit' && method === 'GET') return json(200, { events: await all('SELECT id,action,entity_type AS entityType,entity_id AS entityId,summary,created_at AS createdAt FROM audit ORDER BY rowid DESC LIMIT 500') });
  if (path === '/api/profile' && method === 'PATCH') {
    const body = await jsonBody(request); const name = textField(body.name, 'Your name'); const business = textField(body.businessName, 'Business name'); const phone = normalizePhone(body.phone);
    await stmt('UPDATE owner SET name=?,business_name=?,phone=?,updated_at=? WHERE id=1', name, business, phone, now()).run();
    return json(200, { profile: profile(await owner()) });
  }
  if (path === '/api/password' && method === 'POST') {
    await limit('password'); const body = await jsonBody(request); const previous = (await owner()).password_hash;
    if (!await proofMatches(body.currentPasswordProof, previous)) throw new HttpError(403, 'The current password is incorrect.');
    const salt = clientSalt(body.newClientSalt); const password = await proofHash(body.newPasswordProof);
    const result = await stmt('UPDATE owner SET password_hash=?,client_salt=?,updated_at=? WHERE id=1 AND password_hash=?', password, salt, now(), previous).run();
    if (!changeCount(result)) throw new HttpError(409, 'The password changed in another session. Please sign in again.');
    return sessionResponse(200, password);
  }
  if (path === '/api/workers' && method === 'POST') {
    const worker = workerInput(await jsonBody(request)); const id = crypto.randomUUID(); const timestamp = now();
    await stmt('INSERT INTO workers(id,name,phone,contract,share_token,whatsapp_consent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, worker.name, worker.phone, worker.contract, token(), worker.consent, timestamp, timestamp).run();
    return json(201, { worker: await workerJson(await workerById(id)) });
  }
  const workerPath = path.match(/^\/api\/workers\/([a-f\d-]{36})$/);
  if (workerPath && method === 'PATCH') {
    const previous = await workerById(workerPath[1]); const worker = workerInput(await jsonBody(request));
    await stmt('UPDATE workers SET name=?,phone=?,contract=?,whatsapp_consent=?,updated_at=? WHERE id=?', worker.name, worker.phone, worker.contract, worker.consent, now(), previous.id).run();
    return json(200, { worker: await workerJson(await workerById(previous.id)) });
  }
  const rotatePath = path.match(/^\/api\/workers\/([a-f\d-]{36})\/rotate-link$/);
  if (rotatePath && method === 'POST') {
    const worker = await workerById(rotatePath[1]); await jsonBody(request);
    await stmt('UPDATE workers SET share_token=?,updated_at=? WHERE id=?', token(), now(), worker.id).run();
    return json(200, { worker: await workerJson(await workerById(worker.id)) });
  }
  if (path === '/api/advances' && method === 'POST') {
    const body = await jsonBody(request); const worker = await workerById(body.workerId); const advance = advanceInput(body);
    const key = request.headers.get('Idempotency-Key') || body.clientRequestId || null;
    if (key && (typeof key !== 'string' || !/^[a-z\d-]{16,80}$/i.test(key))) throw new HttpError(400, 'Invalid request identifier.');
    const id = crypto.randomUUID(); const timestamp = now();
    const result = await stmt('INSERT INTO advances(id,worker_id,amount_paise,date,method,note,revision,request_key,created_at,updated_at,contract) SELECT ?,id,?,?,?,?,1,?,?,?,contract FROM workers WHERE id=? ON CONFLICT(request_key) DO NOTHING', id, advance.amountPaise, advance.date, advance.method, advance.note, key, timestamp, timestamp, worker.id).run();
    const entry = changeCount(result) ? await advanceById(id) : await first('SELECT * FROM advances WHERE request_key=?', key);
    if (!entry || entry.worker_id !== worker.id || entry.amount_paise !== advance.amountPaise || entry.date !== advance.date || entry.method !== advance.method || entry.note !== advance.note) throw new HttpError(409, 'This request identifier was already used for a different entry.');
    return json(changeCount(result) ? 201 : 200, { advance: await advanceJson(entry), notification: unchanged() });
  }
  const advancePath = path.match(/^\/api\/advances\/([a-f\d-]{36})$/);
  if (advancePath && method === 'PATCH') {
    const body = await jsonBody(request); const previous = await advanceById(advancePath[1]); const advance = advanceInput(body);
    if (previous.voided) throw new HttpError(409, 'This entry was cancelled and cannot be edited. Record a new advance if needed.');
    if (body.workerId && body.workerId !== previous.worker_id) throw new HttpError(400, 'An existing entry cannot be moved to a different worker.');
    if (!Number.isInteger(body.revision) || body.revision !== previous.revision) throw new HttpError(409, 'This entry changed in another window. Refresh it before editing.');
    const result = await stmt('UPDATE advances SET amount_paise=?,date=?,method=?,note=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND voided=0', advance.amountPaise, advance.date, advance.method, advance.note, now(), previous.id, body.revision).run();
    if (!changeCount(result)) throw new HttpError(409, 'This entry changed in another window. Refresh it before editing.');
    return json(200, { advance: await advanceJson(await advanceById(previous.id)), notification: unchanged() });
  }
  const voidPath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/void$/);
  if (voidPath && method === 'POST') {
    const body = await jsonBody(request); const previous = await advanceById(voidPath[1]);
    if (previous.voided) throw new HttpError(409, 'This entry has already been cancelled.');
    if (!Number.isInteger(body.revision) || body.revision !== previous.revision) throw new HttpError(409, 'This entry changed in another window. Refresh it before cancelling.');
    const reason = textField(body.reason, 'Cancellation reason', 300); const timestamp = now();
    const result = await stmt('UPDATE advances SET voided=1,void_reason=?,voided_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND voided=0', reason, timestamp, timestamp, previous.id, body.revision).run();
    if (!changeCount(result)) throw new HttpError(409, 'This entry changed in another window. Refresh it before cancelling.');
    return json(200, { advance: await advanceJson(await advanceById(previous.id)), notification: unchanged(), warning: 'Entry cancelled. Open WhatsApp to notify the worker about this correction.' });
  }
  const messagePath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/message$/);
  if (messagePath && method === 'GET') {
    const advance = await advanceById(messagePath[1]);
    return json(200, composeMessage(await owner(), await workerById(advance.worker_id), advance, url.origin));
  }
  const notifyPath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/notify$/);
  if (notifyPath && method === 'POST') {
    const advance = await advanceById(notifyPath[1]); await jsonBody(request);
    throw new HttpError(409, advance.voided ? 'This entry was cancelled. Use Open WhatsApp to send its cancellation message.' : 'Use Open WhatsApp to send the prepared message for free. Automatic WhatsApp delivery is not enabled in this version.');
  }
  if (path === '/api/export.csv' && method === 'GET') {
    const rows = [['Worker', 'Phone', 'Contract', 'Date', 'Advance (INR)', 'Method', 'Note', 'Revision', 'Status', 'Cancellation reason']];
    const entries = await all('SELECT a.*,w.name,w.phone FROM advances a JOIN workers w ON w.id=a.worker_id ORDER BY a.date DESC,a.created_at DESC');
    for (const advance of entries) rows.push([advance.name, advance.phone, advance.contract, advance.date, (advance.amount_paise / 100).toFixed(2), advance.method, advance.note, advance.revision, advance.voided ? 'Cancelled' : 'Active', advance.void_reason || '']);
    return new Response('\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hisab-advances.csv"' } });
  }
  throw new HttpError(404, 'This page was not found.');
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const privateResponse = path.startsWith('/api/') || path.startsWith('/w/');
    try {
      if (path.startsWith('/api/')) return secureResponse(await api(request, env), request, true);
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
      if (!env.ASSETS) throw new HttpError(503, 'The app frontend has not been built yet.');
      return secureResponse(await env.ASSETS.fetch(request), request, privateResponse);
    } catch (error) {
      const duplicatePhone = /UNIQUE constraint failed: workers\.phone/.test(String(error?.message));
      const status = error instanceof HttpError ? error.status : duplicatePhone ? 409 : 500;
      const message = error instanceof HttpError ? error.message : duplicatePhone ? 'This mobile number already belongs to another worker.' : 'Something went wrong. Your changes may not have been saved; refresh before trying again.';
      return secureResponse(json(status, { error: message }), request, true);
    }
  },
};
