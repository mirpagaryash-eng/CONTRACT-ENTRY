import { randomBytes, createHash, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const token = () => randomBytes(32).toString('hex');
export const hashToken = (value) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const todayInIndia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const money = (paise) => 'INR ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const displayDate = (date) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(date + 'T00:00:00+05:30'));

export function textField(value, label, max = 80, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new HttpError(400, `${label} must ${optional ? '' : 'not be empty and '}contain at most ${max} characters.`);
  return value.trim();
}
export function normalizePhone(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid mobile number.');
  const stripped = value.trim().replace(/[\s()-]/g, '');
  const number = /^\d{10}$/.test(stripped) ? '91' + stripped : stripped.replace(/^\+/, '');
  if (!/^[1-9]\d{7,14}$/.test(number)) throw new HttpError(400, 'Enter a 10-digit Indian mobile number or an international number with its country code.');
  return number;
}
export function workerInput(body) {
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
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new HttpError(400, 'Use a password with 10 to 128 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, hex] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
