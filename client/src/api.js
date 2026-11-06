const browserPasswordMode = 'client-pbkdf2-sha256-600000';
let passwordPolicy = null;
let passwordSalt = null;
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

function rememberPasswordPolicy(path, data) {
  if (path === '/session' || data.passwordMode) {
    passwordPolicy = data.passwordMode || null;
    passwordSalt = data.passwordSalt || null;
  }
}

async function passwordProof(password, salt) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new Error('Use a password with 10 to 128 characters.');
  if (!/^[a-f\d]{32}$/.test(salt || '')) throw new Error('Refresh this page to load the sign-in settings.');
  if (!globalThis.crypto?.subtle) throw new Error('Secure sign-in needs the app’s HTTPS address. Open that address in your browser.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(salt.match(/.{2}/g), item => parseInt(item, 16));
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes, iterations: 600000, hash: 'SHA-256' }, key, 256)));
}

async function authBody(path, body) {
  if (!body || passwordPolicy !== browserPasswordMode) return body;
  if (path === '/login') {
    // A password change in another browser may have replaced the public salt.
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load the sign-in settings. Please try again.');
    rememberPasswordPolicy('/session', await response.json());
  }
  const result = { ...body };
  if (path === '/setup') {
    result.clientSalt = hex(crypto.getRandomValues(new Uint8Array(16)));
    result.passwordProof = await passwordProof(body.password, result.clientSalt);
    delete result.password;
  } else if (path === '/login') {
    result.passwordProof = await passwordProof(body.password, passwordSalt);
    delete result.password;
  } else if (path === '/password') {
    result.currentPasswordProof = await passwordProof(body.currentPassword, passwordSalt);
    result.newClientSalt = hex(crypto.getRandomValues(new Uint8Array(16)));
    result.newPasswordProof = await passwordProof(body.newPassword, result.newClientSalt);
    delete result.currentPassword;
    delete result.newPassword;
  }
  return result;
}

export async function api(path, { method = 'GET', body, csrfToken, signal } = {}) {
  const preparedBody = await authBody(path, body);
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    ...(preparedBody !== undefined ? { body: JSON.stringify(preparedBody) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  rememberPasswordPolicy(path, data);
  return data;
}

export const money = (paise = 0) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
export const dateText = (value, options = {}) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...options });
export const timeText = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const todayIndia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
export const monthText = value => new Date(`${value}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
export const notifyLabel = status => ({ not_requested: 'Not sent', pending: 'Queued', accepted: 'Sent to WhatsApp', failed: 'Needs attention', delivered: 'Delivered', read: 'Read' }[status] || 'Not sent');
export const isInteractivePreview = false;
export const workerPageUrl = token => `${window.location.origin}/w/${encodeURIComponent(token)}`;

export async function copyText(value) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy is unavailable. Please select and copy the link.');
}
