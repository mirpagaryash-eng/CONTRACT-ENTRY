import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { openStore, transaction } from './store.js';
import { HttpError, token, hashToken, now, todayInIndia, money, textField, normalizePhone, workerInput, advanceInput, passwordHash, passwordMatches, csvCell } from './domain.js';
import { composeMessage, messagingConfig, notifyAdvance, verifyWebhook, applyWebhook } from './messaging.js';

export function createApp({ dbPath = process.env.DB_PATH || '.data/hisab.sqlite', env = process.env, fetchImpl = globalThis.fetch, distPath = resolve('dist') } = {}) {
  const db = openStore(dbPath);
  const prod = env.NODE_ENV === 'production';
  if (env.PUBLIC_BASE_URL) {
    const configuredUrl = new URL(env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(configuredUrl.protocol) || configuredUrl.username || configuredUrl.password || configuredUrl.search || configuredUrl.hash || configuredUrl.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin without a path.');
    if (prod && configuredUrl.protocol !== 'https:') throw new Error('Production PUBLIC_BASE_URL must use HTTPS.');
  }
  if (prod && !db.prepare('SELECT id FROM owner WHERE id=1').get() && !env.ADMIN_INVITE_CODE) {
    db.close();
    throw new Error('Set ADMIN_INVITE_CODE before the first production startup to protect owner registration.');
  }
  // A previous process may have exited between the network request and its response.
  db.prepare("UPDATE notifications SET status='failed',error='Delivery unconfirmed after server restart. Check the provider before retrying.',updated_at=? WHERE status='pending'").run(now());
  const limits = new Map();
  function limit(req, key, max = 10) {
    const ip = env.TRUST_PROXY === 'true' ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
    const id = `${key}:${ip}`;
    const old = limits.get(id);
    const item = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + 15 * 60 * 1000 };
    item.count++; limits.set(id, item);
    if (limits.size > 2000) for (const [k,v] of limits) if (v.until < Date.now()) limits.delete(k);
    if (item.count > max) throw new HttpError(429, 'Too many attempts. Please try again in 15 minutes.');
  }
  const owner = () => db.prepare('SELECT * FROM owner WHERE id=1').get();
  const profile = (o = owner()) => o ? { name: o.name, businessName: o.business_name, phone: o.phone } : null;
  const audit = (action, type, id, summary, data = {}) => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(), action, type, id, summary, JSON.stringify(data), now());
  const workerById = (id) => {
    const w = typeof id === 'string' ? db.prepare('SELECT * FROM workers WHERE id=?').get(id) : null;
    if (!w) throw new HttpError(404, 'Worker not found.');
    return w;
  };
  const advanceById = (id) => {
    const a = db.prepare('SELECT * FROM advances WHERE id=?').get(id);
    if (!a) throw new HttpError(404, 'Advance not found.');
    return a;
  };
  function workerJson(w) {
    const totals = db.prepare('SELECT COALESCE(SUM(amount_paise),0) AS total,COALESCE(SUM(CASE WHEN substr(date,1,7)=? THEN amount_paise ELSE 0 END),0) AS month,COUNT(*) AS count FROM advances WHERE worker_id=? AND voided=0').get(todayInIndia().slice(0,7), w.id);
    return { id: w.id, name: w.name, phone: w.phone, contract: w.contract, shareToken: w.share_token, whatsappConsent: !!w.whatsapp_consent, createdAt: w.created_at, totalPaise: totals.total, monthTotalPaise: totals.month, advanceCount: totals.count };
  }
  function advanceJson(a) {
    const n = db.prepare('SELECT status,error FROM notifications WHERE advance_id=? AND revision=? ORDER BY rowid DESC LIMIT 1').get(a.id, a.revision);
    const w = workerById(a.worker_id);
    return { id: a.id, workerId: a.worker_id, amountPaise: a.amount_paise, date: a.date, method: a.method, note: a.note, createdAt: a.created_at, updatedAt: a.updated_at, revision: a.revision, workerName: w.name, workerPhone: w.phone, contract: a.contract, voided: !!a.voided, voidReason: a.void_reason, voidedAt: a.voided_at, notificationStatus: n?.status || 'not_requested', notificationError: n?.error || null };
  }
  function session(req) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)hisab_session=([a-f\d]{64})(?:;|$)/);
    if (!match) return null;
    return db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(match[1]), Date.now()) || null;
  }
  function startSession(res) {
    const value = token(); const csrf = token();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(value), csrf, Date.now() + 12 * 60 * 60 * 1000);
    res.setHeader('Set-Cookie', `hisab_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${prod ? '; Secure' : ''}`);
    return { authenticated: true, setupRequired: false, csrfToken: csrf, profile: profile() };
  }
  function requireSession(req, mutation = false) {
    const s = session(req);
    if (!s) throw new HttpError(401, 'Please sign in to continue.');
    if (mutation && req.headers['x-csrf-token'] !== s.csrf) throw new HttpError(403, 'Your session has changed. Refresh this page and try again.');
    return s;
  }
  function origin(req) {
    if (env.PUBLIC_BASE_URL) return new URL(env.PUBLIC_BASE_URL).origin;
    const forwardedProto = env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-proto'] || '').split(',')[0] : '';
    const protocol = forwardedProto === 'https' || req.socket.encrypted ? 'https' : 'http';
    const host = req.headers.host;
    if (!host || !/^[a-z\d.\-\[\]:]+$/i.test(host)) throw new HttpError(400, 'Invalid request host.');
    return `${protocol}://${host}`;
  }
  function checkOrigin(req) {
    const supplied = req.headers.origin;
    if (supplied && supplied !== origin(req)) throw new HttpError(403, 'This request came from a different website.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
  async function bodyBytes(req, max = 64 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'This request is too large.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function jsonBody(req) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use JSON for this request.');
    const bytes = await bodyBytes(req);
    let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new HttpError(400, 'Expected a JSON object.');
    return data;
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (prod) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://request.local');
      const path = url.pathname;
      const method = req.method;
      if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true });
      if (path === '/api/whatsapp/webhook') {
        if (method === 'GET') {
          if (!env.WHATSAPP_VERIFY_TOKEN || url.searchParams.get('hub.mode') !== 'subscribe' || url.searchParams.get('hub.verify_token') !== env.WHATSAPP_VERIFY_TOKEN) throw new HttpError(403, 'Webhook verification failed.');
          res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge') || '');
        }
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        const raw = await bodyBytes(req, 1024 * 1024);
        if (!verifyWebhook(raw, req.headers['x-hub-signature-256'], env.WHATSAPP_APP_SECRET)) throw new HttpError(403, 'Invalid webhook signature.');
        let value; try { value = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid webhook body.'); }
        applyWebhook(db, value); return json(res, 200, { ok: true });
      }
      if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) checkOrigin(req);
      if (path === '/api/session' && method === 'GET') {
        const s = session(req);
        const o = owner();
        return json(res, 200, { authenticated: !!s, setupRequired: !o, needsInviteCode: !!env.ADMIN_INVITE_CODE, ...(s ? { csrfToken: s.csrf, profile: profile(o) } : {}), ...(!o && env.HISAB_SETUP_HINTS ? { demoProfile: JSON.parse(env.HISAB_SETUP_HINTS) } : {}) });
      }
      if (path === '/api/setup' && method === 'POST') {
        limit(req, 'setup');
        if (owner()) throw new HttpError(409, 'The owner account is already set up. Please sign in.');
        const b = await jsonBody(req);
        if (env.ADMIN_INVITE_CODE) {
          const supplied = hashToken(typeof b.inviteCode === 'string' ? b.inviteCode : '');
          if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(hashToken(env.ADMIN_INVITE_CODE)))) throw new HttpError(403, 'The setup code is incorrect.');
        }
        const name = textField(b.name, 'Your name'); const business = textField(b.businessName, 'Business name'); const phone = normalizePhone(b.phone);
        const hash = await passwordHash(b.password);
        transaction(db, () => {
          if (owner()) throw new HttpError(409, 'The owner account is already set up. Please sign in.');
          db.prepare('INSERT INTO owner VALUES(1,?,?,?,?,?,?)').run(name, business, phone, hash, now(), now());
          audit('create', 'owner', '1', 'Owner account set up.');
        });
        return json(res, 201, startSession(res));
      }
      if (path === '/api/login' && method === 'POST') {
        limit(req, 'login'); const b = await jsonBody(req); const o = owner();
        let phone = ''; try { phone = normalizePhone(b.phone); } catch { /* Same response for all invalid credentials. */ }
        const matches = o ? await passwordMatches(b.password, o.password_hash) : false;
        const current = owner();
        if (!o || phone !== o.phone || !matches || current.password_hash !== o.password_hash || current.phone !== o.phone) throw new HttpError(401, 'The mobile number or password is incorrect.');
        return json(res, 200, startSession(res));
      }
      const publicWorker = path.match(/^\/api\/worker\/([a-f\d]{64})$/);
      if (publicWorker && method === 'GET') {
        const w = db.prepare('SELECT * FROM workers WHERE share_token=?').get(publicWorker[1]);
        if (!w) throw new HttpError(404, 'This private link is invalid or has been replaced. Ask the owner for a new link.');
        const sums = workerJson(w);
        const advances = db.prepare('SELECT * FROM advances WHERE worker_id=? ORDER BY date DESC,created_at DESC').all(w.id).map(a => ({ id: a.id, amountPaise: a.amount_paise, date: a.date, method: a.method, note: a.note, contract: a.contract, voided: !!a.voided, voidReason: a.void_reason, voidedAt: a.voided_at, updatedAt: a.updated_at, revision: a.revision }));
        return json(res, 200, { businessName: owner().business_name, worker: { name: w.name, contract: w.contract }, advances, totalPaise: sums.totalPaise, monthTotalPaise: sums.monthTotalPaise, today: todayInIndia() });
      }
      if (path.startsWith('/api/')) {
        const s = requireSession(req, !['GET', 'HEAD'].includes(method));
        if (path === '/api/logout' && method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
          res.setHeader('Set-Cookie', `hisab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${prod ? '; Secure' : ''}`);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/dashboard' && method === 'GET') {
          return json(res, 200, { profile: profile(), workers: db.prepare('SELECT * FROM workers ORDER BY name COLLATE NOCASE').all().map(workerJson), advances: db.prepare('SELECT * FROM advances ORDER BY date DESC,created_at DESC').all().map(advanceJson), today: todayInIndia(), notificationMode: messagingConfig(env).configured ? 'automatic' : 'manual', whatsapp: messagingConfig(env) });
        }
        if (path === '/api/audit' && method === 'GET') return json(res, 200, { events: db.prepare('SELECT id,action,entity_type AS entityType,entity_id AS entityId,summary,created_at AS createdAt FROM audit ORDER BY rowid DESC LIMIT 500').all() });
        if (path === '/api/profile' && method === 'PATCH') {
          const b = await jsonBody(req); const name = textField(b.name, 'Your name'); const business = textField(b.businessName, 'Business name'); const phone = normalizePhone(b.phone);
          transaction(db, () => { db.prepare('UPDATE owner SET name=?,business_name=?,phone=?,updated_at=? WHERE id=1').run(name, business, phone, now()); audit('update', 'owner', '1', 'Business profile updated.'); });
          return json(res, 200, { profile: profile() });
        }
        if (path === '/api/password' && method === 'POST') {
          limit(req, 'password'); const b = await jsonBody(req); const previous = owner().password_hash;
          if (!await passwordMatches(b.currentPassword, previous)) throw new HttpError(403, 'The current password is incorrect.');
          const hash = await passwordHash(b.newPassword);
          transaction(db, () => {
            if (owner().password_hash !== previous) throw new HttpError(409, 'The password changed in another session. Please sign in again.');
            db.prepare('UPDATE owner SET password_hash=?,updated_at=? WHERE id=1').run(hash, now());
            db.prepare('DELETE FROM sessions').run(); audit('update', 'owner', '1', 'Owner password changed. All previous sessions signed out.');
          });
          return json(res, 200, startSession(res));
        }
        if (path === '/api/workers' && method === 'POST') {
          const b = workerInput(await jsonBody(req)); const id = randomUUID();
          transaction(db, () => { db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run(id,b.name,b.phone,b.contract,token(),b.consent,now(),now()); audit('create','worker',id,`${b.name} added to ${b.contract}.`); });
          return json(res, 201, { worker: workerJson(workerById(id)) });
        }
        const workerPath = path.match(/^\/api\/workers\/([a-f\d-]{36})$/);
        if (workerPath && method === 'PATCH') {
          const prev = workerById(workerPath[1]); const b = workerInput(await jsonBody(req));
          transaction(db, () => { db.prepare('UPDATE workers SET name=?,phone=?,contract=?,whatsapp_consent=?,updated_at=? WHERE id=?').run(b.name,b.phone,b.contract,b.consent,now(),prev.id); audit('update','worker',prev.id,`${b.name}’s worker details updated.`,{ before: prev, after: b }); });
          return json(res, 200, { worker: workerJson(workerById(prev.id)) });
        }
        const rotatePath = path.match(/^\/api\/workers\/([a-f\d-]{36})\/rotate-link$/);
        if (rotatePath && method === 'POST') {
          const w = workerById(rotatePath[1]); await jsonBody(req);
          transaction(db, () => { db.prepare('UPDATE workers SET share_token=?,updated_at=? WHERE id=?').run(token(),now(),w.id); audit('rotate','worker',w.id,`${w.name}’s private link replaced. The old link no longer works.`); });
          return json(res, 200, { worker: workerJson(workerById(w.id)) });
        }
        if (path === '/api/advances' && method === 'POST') {
          const b = await jsonBody(req); const w = workerById(b.workerId); const a = advanceInput(b);
          const key = req.headers['idempotency-key'] || b.clientRequestId || null;
          if (key && (typeof key !== 'string' || !/^[a-z\d-]{16,80}$/i.test(key))) throw new HttpError(400, 'Invalid request identifier.');
          const existing = key ? db.prepare('SELECT * FROM advances WHERE request_key=?').get(key) : null;
          if (existing) {
            if (existing.worker_id !== w.id || existing.amount_paise !== a.amountPaise || existing.date !== a.date || existing.method !== a.method || existing.note !== a.note) throw new HttpError(409, 'This request identifier was already used for a different entry.');
            return json(res, 200, { advance: advanceJson(existing), notification: { status: advanceJson(existing).notificationStatus } });
          }
          const id = randomUUID();
          transaction(db, () => { db.prepare('INSERT INTO advances(id,worker_id,amount_paise,date,method,note,revision,request_key,created_at,updated_at,contract) VALUES(?,?,?,?,?,?,1,?,?,?,?)').run(id,w.id,a.amountPaise,a.date,a.method,a.note,key,now(),now(),w.contract); audit('create','advance',id,`${money(a.amountPaise)} advance recorded for ${w.name}.`,{ ...a, workerId: w.id, contract: w.contract }); });
          const notification = await notifyAdvance({ db, env, fetchImpl, advanceId: id, baseUrl: origin(req), automatic: true });
          return json(res, 201, { advance: advanceJson(advanceById(id)), notification });
        }
        const advancePath = path.match(/^\/api\/advances\/([a-f\d-]{36})$/);
        if (advancePath && method === 'PATCH') {
          const b = await jsonBody(req); const prev = advanceById(advancePath[1]); const a = advanceInput(b);
          if (prev.voided) throw new HttpError(409, 'This entry was cancelled and cannot be edited. Record a new advance if needed.');
          if (b.workerId && b.workerId !== prev.worker_id) throw new HttpError(400, 'An existing entry cannot be moved to a different worker.');
          if (!Number.isInteger(b.revision) || b.revision !== prev.revision) throw new HttpError(409, 'This entry changed in another window. Refresh it before editing.');
          const w = workerById(prev.worker_id);
          transaction(db, () => { db.prepare('UPDATE advances SET amount_paise=?,date=?,method=?,note=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(a.amountPaise,a.date,a.method,a.note,now(),prev.id,b.revision); audit('update','advance',prev.id,`${w.name}’s advance corrected from ${money(prev.amount_paise)} to ${money(a.amountPaise)}.`,{ before: prev, after: a }); });
          const notification = await notifyAdvance({ db, env, fetchImpl, advanceId: prev.id, baseUrl: origin(req), automatic: true });
          return json(res, 200, { advance: advanceJson(advanceById(prev.id)), notification });
        }
        const voidPath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/void$/);
        if (voidPath && method === 'POST') {
          const b = await jsonBody(req); const prev = advanceById(voidPath[1]);
          if (prev.voided) throw new HttpError(409, 'This entry has already been cancelled.');
          if (!Number.isInteger(b.revision) || b.revision !== prev.revision) throw new HttpError(409, 'This entry changed in another window. Refresh it before cancelling.');
          const reason = textField(b.reason, 'Cancellation reason', 300);
          const w = workerById(prev.worker_id);
          transaction(db, () => {
            db.prepare('UPDATE advances SET voided=1,void_reason=?,voided_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(reason,now(),now(),prev.id,b.revision);
            audit('void','advance',prev.id,`${money(prev.amount_paise)} advance for ${w.name} cancelled: ${reason}`,{ before: prev, reason });
          });
          return json(res, 200, { advance: advanceJson(advanceById(prev.id)), notification: { status:'not_requested' }, warning:'Entry cancelled. Open WhatsApp to notify the worker about this correction.' });
        }
        const messagePath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/message$/);
        if (messagePath && method === 'GET') {
          const a = advanceById(messagePath[1]); return json(res, 200, composeMessage(owner(),workerById(a.worker_id),a,origin(req)));
        }
        const notifyPath = path.match(/^\/api\/advances\/([a-f\d-]{36})\/notify$/);
        if (notifyPath && method === 'POST') {
          limit(req,'notify',100); advanceById(notifyPath[1]); await jsonBody(req);
          const notification = await notifyAdvance({ db, env, fetchImpl, advanceId: notifyPath[1], baseUrl: origin(req) });
          audit('notify','advance',notifyPath[1],`WhatsApp notification ${notification.status}.`);
          return json(res, notification.status === 'failed' ? 502 : 200, { ...notification, notification, advance: advanceJson(advanceById(notifyPath[1])), ...(notification.error ? { error: notification.error } : {}) });
        }
        if (path === '/api/export.csv' && method === 'GET') {
          const rows = [['Worker','Phone','Contract','Date','Advance (INR)','Method','Note','Revision','Status','Cancellation reason']];
          for (const a of db.prepare('SELECT a.*,w.name,w.phone FROM advances a JOIN workers w ON w.id=a.worker_id ORDER BY a.date DESC,a.created_at DESC').all()) rows.push([a.name,a.phone,a.contract,a.date,(a.amount_paise / 100).toFixed(2),a.method,a.note,a.revision,a.voided ? 'Cancelled' : 'Active',a.void_reason || '']);
          res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="hisab-advances.csv"' });
          return res.end('\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
        }
        throw new HttpError(404, 'This action is not available.');
      }
      if (!['GET','HEAD'].includes(method)) throw new HttpError(405, 'Method not allowed.');
      let file = resolve(distPath, '.' + decodeURIComponent(path));
      if (file !== distPath && !file.startsWith(distPath + sep)) throw new HttpError(404, 'Page not found.');
      try { if (!(await stat(file)).isFile()) file = resolve(distPath,'index.html'); }
      catch { file = resolve(distPath,'index.html'); }
      let content; try { content = await readFile(file); } catch { throw new HttpError(503, 'The app has not been built yet. Run npm run build, then refresh.'); }
      const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
      res.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream' });
      return res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      const duplicate = error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: workers.phone/.test(error.message);
      const status = duplicate ? 409 : error.status || 500;
      if (status === 500) console.error('Request failed:', error.code || error.name);
      if (!res.headersSent) json(res, status, { error: duplicate ? 'A worker with this mobile number already exists.' : status === 500 ? 'Something went wrong. Your saved entries are safe; please refresh and try again.' : error.message });
      else res.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return { server, db, close: () => new Promise((resolveClose) => { server.close(() => { db.close(); resolveClose(); }); server.closeIdleConnections(); }) };
}
