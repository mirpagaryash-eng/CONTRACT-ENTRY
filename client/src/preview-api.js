// This adapter is included only in the downloadable interactive preview build.
// The production application continues to use its authenticated server API.
export * from './api.js';
import { money, todayIndia } from './api.js';

export const isInteractivePreview = true;
export const workerPageUrl = token => `${window.location.href.split('#')[0]}#worker=${encodeURIComponent(token)}`;
const storageKey = 'hisab.interactive-preview.v1';
let current;
let persistent = true;
let storageWarning = '';
let installed = false;
const iso = () => new Date().toISOString();
const uuid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function initialState() {
  const fixture = window.__HISAB_PREVIEW_FIXTURE__ || {};
  return {
    version: 1,
    profile: { name: 'Owner', businessName: 'Sai Services', phone: '12025550100', ...fixture.profile },
    workers: (fixture.workers || [{ name: 'Abhay', phone: '12025550101', contract: 'SANJYOT' }]).map(worker => ({ id: uuid(), name: worker.name, phone: worker.phone || '', contract: worker.contract || 'SANJYOT', shareToken: uuid(), whatsappConsent: false, createdAt: iso() })),
    advances: [], events: [],
  };
}
function changed() { window.dispatchEvent(new Event('hisab-preview-change')); }
function save(next) {
  try { localStorage.setItem(storageKey, JSON.stringify(next)); persistent = true; storageWarning = ''; }
  catch { persistent = false; storageWarning = 'Browser storage is unavailable. Changes will last only until this tab closes.'; }
  current = next; changed();
}
function load() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) { current = initialState(); save(current); return; }
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !parsed.profile || !Array.isArray(parsed.workers) || !Array.isArray(parsed.advances) || !Array.isArray(parsed.events)) throw new Error('Invalid saved preview');
    current = parsed;
  } catch {
    current = initialState(); persistent = false;
    storageWarning = 'Saved preview data could not be read. Use Reset preview to start fresh.';
  }
}
export function previewSnapshot() { if (!current) load(); return { workers: current.workers.map(worker => ({ id: worker.id, name: worker.name, shareToken: worker.shareToken })), persistent, storageWarning }; }
export function resetPreview() { save(initialState()); }
export function previewSession() { return { authenticated: true, setupRequired: false, csrfToken: 'local-preview', profile: current.profile }; }
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function text(value, label, max = 80) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`Enter ${label} (up to ${max} characters).`); return value.trim(); }
function phone(value) {
  const number = String(value || '').trim().replace(/[\s()-]/g, '').replace(/^\+/, '');
  const normalized = /^\d{10}$/.test(number) ? `91${number}` : number;
  if (!/^[1-9]\d{7,14}$/.test(normalized)) fail('Enter a 10-digit Indian number or an international number with country code.');
  return normalized;
}
function workerInput(body) { if (!['SANJYOT', 'TECHNOEDGE'].includes(body.contract)) fail('Choose a contract.'); return { name: text(body.name, 'a worker name'), phone: phone(body.phone), contract: body.contract, whatsappConsent: !!body.whatsappConsent }; }
function advanceInput(body) {
  const amount = String(body.amount || '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount)) fail('Enter a positive amount with up to two decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const amountPaise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!amountPaise || amountPaise > 1000000000) fail('Enter an amount between ₹0.01 and ₹1,00,00,000.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') || !Number.isFinite(Date.parse(`${body.date}T12:00:00`)) || new Date(`${body.date}T12:00:00Z`).toISOString().slice(0,10) !== body.date || body.date > todayIndia()) fail('Choose a valid date on or before today.');
  if (!['cash', 'online'].includes(body.method)) fail('Choose Cash or Online.');
  if (String(body.note || '').length > 500) fail('Keep the note under 500 characters.');
  return { amountPaise, date: body.date, method: body.method, note: String(body.note || '').trim() };
}
const worker = id => current.workers.find(w => w.id === id) || fail('Worker not found.', 404);
const advance = id => current.advances.find(a => a.id === id) || fail('Advance not found.', 404);
function totals(workerId) { const entries = current.advances.filter(a => a.workerId === workerId && !a.voided); return { totalPaise: entries.reduce((s,a) => s+a.amountPaise,0), monthTotalPaise: entries.filter(a => a.date.startsWith(todayIndia().slice(0,7))).reduce((s,a) => s+a.amountPaise,0), advanceCount: entries.length }; }
const workerJson = w => ({ ...w, ...totals(w.id) });
const advanceJson = a => { const w = worker(a.workerId); return { ...a, workerName: w.name, workerPhone: w.phone, contract: a.contract || w.contract, notificationStatus: 'not_requested', notificationError: null }; };
function audit(next, action, entityType, entityId, summary) { next.events.unshift({ id: uuid(), action, entityType, entityId, summary, createdAt: iso() }); }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function csvCell(value) { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }

async function route(path, method, body) {
  if (path === '/api/session') return json(previewSession());
  if (path === '/api/dashboard') return json({ profile: current.profile, workers: current.workers.map(workerJson), advances: current.advances.map(advanceJson), today: todayIndia(), notificationMode: 'manual', whatsapp: { configured: false, templateName: null, webhookReady: false } });
  if (path === '/api/audit') return json({ events: current.events });
  if (path === '/api/logout') fail('This preview has no sign-in. Use the Owner and Worker buttons above to switch views.');
  if (path === '/api/password') fail('This browser-only preview has no account password. The full application provides owner sign-in.');
  if (path === '/api/profile' && method === 'PATCH') {
    const next = structuredClone(current); next.profile = { name: text(body.name, 'your name'), businessName: text(body.businessName, 'a business name'), phone: phone(body.phone) };
    audit(next, 'update', 'owner', 'owner', 'Business details updated.'); save(next); return json({ profile: current.profile });
  }
  if (path === '/api/workers' && method === 'POST') {
    const values = workerInput(body); if (current.workers.some(w => w.phone === values.phone)) fail('A worker with this mobile number already exists.', 409);
    const next = structuredClone(current); const w = { id: uuid(), ...values, shareToken: uuid(), createdAt: iso() }; next.workers.push(w);
    audit(next, 'create', 'worker', w.id, `${w.name} added to ${w.contract}.`); save(next); return json({ worker: workerJson(w) }, 201);
  }
  const workerPath = path.match(/^\/api\/workers\/([^/]+)(\/rotate-link)?$/);
  if (workerPath) {
    const existing = worker(workerPath[1]); const next = structuredClone(current); const w = next.workers.find(w => w.id === existing.id);
    if (workerPath[2] && method === 'POST') { w.shareToken = uuid(); audit(next, 'update', 'worker', w.id, `${w.name}’s preview link replaced.`); }
    else if (method === 'PATCH') { const values = workerInput(body); if (next.workers.some(other => other.id !== w.id && other.phone === values.phone)) fail('A worker with this mobile number already exists.',409); Object.assign(w,values); audit(next, 'update', 'worker', w.id, `${w.name}’s details updated.`); }
    else fail('Action unavailable.',404);
    save(next); return json({ worker: workerJson(w) });
  }
  if (path === '/api/advances' && method === 'POST') {
    const w = worker(body.workerId); const values = advanceInput(body);
    if (body.clientRequestId) { const old = current.advances.find(a => a.clientRequestId === body.clientRequestId); if (old) { if (old.workerId !== w.id || Object.entries(values).some(([key,value])=>old[key]!==value)) fail('This entry was already saved with different details. Close the form and start a new entry.',409); return json({ advance: advanceJson(old), notification: { status: 'not_requested' } }); } }
    const next = structuredClone(current); const a = { id: uuid(), workerId: w.id, contract: w.contract, ...values, revision: 1, createdAt: iso(), updatedAt: iso(), voided: false, clientRequestId: body.clientRequestId };
    next.advances.unshift(a); audit(next, 'create', 'advance', a.id, `${money(a.amountPaise)} advance recorded for ${w.name}.`); save(next); return json({ advance: advanceJson(a), notification: { status: 'not_requested' } },201);
  }
  const advancePath = path.match(/^\/api\/advances\/([^/]+)(\/message|\/void|\/notify)?$/);
  if (advancePath) {
    const existing = advance(advancePath[1]); const w = worker(existing.workerId);
    if (advancePath[2] === '/message') {
      if (!w.phone) fail('Add this worker’s WhatsApp number first.');
      const message = existing.voided
        ? `${current.profile.businessName}: The advance entry of ${money(existing.amountPaise)} dated ${existing.date} for ${w.name} has been cancelled. Reason: ${existing.voidReason}. This correction has been recorded.`
        : `${current.profile.businessName}: Hi ${w.name}, an advance of ${money(existing.amountPaise)} has been recorded for you on ${existing.date}. Payment method: ${existing.method === 'cash' ? 'Cash' : 'Online'}.${existing.note ? ` Note: ${existing.note}` : ''}${existing.revision > 1 ? ' This is an updated entry.' : ''}`;
      return json({ message, url: `https://wa.me/${w.phone}?text=${encodeURIComponent(message)}` });
    }
    if (advancePath[2] === '/notify') fail('Automatic delivery is unavailable in this preview. Open WhatsApp and tap Send to send a message.');
    if (existing.voided) fail('This entry is already cancelled.',409);
    if (body.revision !== existing.revision) fail('This entry changed. Close this form and try again.',409);
    const next = structuredClone(current); const a = next.advances.find(a => a.id === existing.id);
    if (advancePath[2] === '/void' && method === 'POST') {
      const reason = text(body.reason, 'a cancellation reason',500); Object.assign(a,{ voided: true, voidReason: reason, voidedAt: iso(), updatedAt: iso(), revision: a.revision + 1 }); audit(next,'void','advance',a.id,`${w.name}’s ${money(a.amountPaise)} advance cancelled. Reason: ${reason}`);
    } else if (!advancePath[2] && method === 'PATCH') {
      if (body.workerId && body.workerId !== existing.workerId) fail('An entry cannot move to a different worker.'); Object.assign(a,advanceInput(body),{ updatedAt: iso(), revision: a.revision + 1 }); audit(next,'update','advance',a.id,`${w.name}’s advance corrected from ${money(existing.amountPaise)} to ${money(a.amountPaise)}.`);
    } else fail('Action unavailable.',404);
    save(next); return json({ advance: advanceJson(a), notification: { status: 'not_requested' } });
  }
  const workerView = path.match(/^\/api\/worker\/([^/]+)$/);
  if (workerView) {
    const w = current.workers.find(w => w.shareToken === decodeURIComponent(workerView[1])); if (!w) fail('This preview worker link is unavailable.',404);
    return json({ businessName: current.profile.businessName, worker: { name: w.name, contract: w.contract }, advances: current.advances.filter(a => a.workerId === w.id).map(a => ({ id:a.id,amountPaise:a.amountPaise,date:a.date,method:a.method,note:a.note,contract:a.contract,revision:a.revision,createdAt:a.createdAt,updatedAt:a.updatedAt,voided:a.voided,voidReason:a.voidReason,voidedAt:a.voidedAt })), ...totals(w.id), today:todayIndia() });
  }
  if (path === '/api/export.csv') {
    const rows = [['Worker','Phone','Contract','Date','Advance (INR)','Method','Note','Status','Cancellation reason'],...current.advances.map(a => [worker(a.workerId).name,worker(a.workerId).phone,a.contract,a.date,(a.amountPaise/100).toFixed(2),a.method,a.note,a.voided ? 'Cancelled' : 'Recorded',a.voidReason || ''])];
    return new Response('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8'}});
  }
  fail('This action is unavailable in the interactive preview.',404);
}

export function installPreviewApi() {
  if (installed) return; installed = true; load();
  if (globalThis.crypto && !crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:()=>{ const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join(''); }});
  window.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url,'http://preview.invalid').pathname;
    if (!path.startsWith('/api/')) return json({error:'This preview does not make external requests.'},400);
    try { const body = options.body ? JSON.parse(options.body) : {}; return await route(path,(options.method || 'GET').toUpperCase(),body); }
    catch (error) { return json({error:error.message || 'Please try again.'},error.status || 400); }
  };
  window.addEventListener('storage', event => { if (event.key === storageKey) { load(); changed(); } });
}
