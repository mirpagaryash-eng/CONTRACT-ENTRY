import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { now, money, displayDate, HttpError } from './domain.js';

export function messagingConfig(env) {
  const configured = !!(env.WHATSAPP_ACCESS_TOKEN && /^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID || '') && env.WHATSAPP_TEMPLATE_NAME && /^https:\/\//.test(env.PUBLIC_BASE_URL || ''));
  return { configured, templateName: env.WHATSAPP_TEMPLATE_NAME || null, webhookReady: !!(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN) };
}

export function composeMessage(profile, worker, advance, baseUrl) {
  const workerUrl = `${baseUrl}/w/${worker.share_token}`;
  if (advance.voided) {
    const message = `${profile.business_name}\n\nHi ${worker.name},\nAdvance entry CANCELLED: ${money(advance.amount_paise)}\nOriginal date: ${displayDate(advance.date)}\nReason: ${advance.void_reason}\n\nThis entry is excluded from your advance total. View your updated private history:\n${workerUrl}\n\nPlease contact ${profile.name} if any detail needs correction.`;
    return { message, url:`https://wa.me/${worker.phone}?text=${encodeURIComponent(message)}` };
  }
  const message = `${profile.business_name}\n\nHi ${worker.name},\n${advance.revision > 1 ? 'Updated advance entry' : 'Advance recorded'}: ${money(advance.amount_paise)}\nDate: ${displayDate(advance.date)}\nPayment method: ${advance.method === 'cash' ? 'Cash' : 'Online'}${advance.note ? `\nNote: ${advance.note}` : ''}\n\nView your private advance history:\n${workerUrl}\n\nThis records an advance; it does not transfer money. Please contact ${profile.name} if any detail needs correction.`;
  return { message, url: `https://wa.me/${worker.phone}?text=${encodeURIComponent(message)}` };
}

// Provider submission is intentionally separate from the transaction saving the advance.
// A network/provider failure must never erase the owner's financial record.
export async function notifyAdvance({ db, env, fetchImpl, advanceId, baseUrl, automatic = false }) {
  const advance = db.prepare('SELECT * FROM advances WHERE id=?').get(advanceId);
  if (advance.voided) throw new HttpError(409, 'This entry was cancelled. Use Open WhatsApp to send its cancellation message.');
  const worker = db.prepare('SELECT * FROM workers WHERE id=?').get(advance.worker_id);
  if (!messagingConfig(env).configured) {
    if (automatic) return { status: 'not_requested' };
    throw new HttpError(409, 'Automatic WhatsApp is not connected. Use Open WhatsApp to send the prepared message.');
  }
  if (!worker.whatsapp_consent) {
    if (automatic) return { status: 'not_requested' };
    throw new HttpError(409, 'Record the worker’s agreement to WhatsApp updates before sending automatically.');
  }
  // Synchronous claim before awaiting fetch prevents double-clicks/concurrent sends.
  const latest = db.prepare('SELECT * FROM notifications WHERE advance_id=? AND revision=? ORDER BY rowid DESC LIMIT 1').get(advanceId, advance.revision);
  if (latest && ['pending', 'accepted', 'delivered', 'read'].includes(latest.status)) {
    if (automatic) return { status: latest.status };
    throw new HttpError(409, 'A notification for this entry is already pending or sent.');
  }
  const id = randomUUID();
  db.prepare('INSERT INTO notifications(id,advance_id,revision,recipient,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, advanceId, advance.revision, worker.phone, 'pending', now(), now());
  try {
    const version = env.WHATSAPP_GRAPH_VERSION || 'v23.0';
    if (!/^v\d+\.\d+$/.test(version)) throw new Error('Invalid configured Graph API version.');
    const response = await fetchImpl(`https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: worker.phone, type: 'template',
        template: {
          name: env.WHATSAPP_TEMPLATE_NAME, language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en' },
          components: [{ type: 'body', parameters: [worker.name, money(advance.amount_paise), displayDate(advance.date), advance.method === 'cash' ? 'Cash' : 'Online', `${baseUrl}/w/${worker.share_token}`].map(text => ({ type: 'text', text })) }],
        },
      }), signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    if (!response.ok || typeof body.messages?.[0]?.id !== 'string') {
      // Avoid echoing provider error text: it can contain tokens, phone numbers or other secrets.
      const code = Number(body.error?.code);
      throw new Error(Number.isFinite(code) ? `WhatsApp rejected this notification (code ${code}). Check your provider settings, template and recipient permission, then retry.` : 'WhatsApp could not accept this notification. Check the provider configuration, then retry.');
    }
    db.prepare('UPDATE notifications SET status=?,message_id=?,updated_at=? WHERE id=?').run('accepted', body.messages[0].id, now(), id);
    return { status: 'accepted' };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'WhatsApp timed out. Delivery is unconfirmed; check the provider before retrying.' : error.message?.startsWith('WhatsApp ') || error.message?.startsWith('Invalid configured') ? error.message : 'WhatsApp could not be reached. Your advance is saved; check the connection before retrying.';
    db.prepare('UPDATE notifications SET status=?,error=?,updated_at=? WHERE id=?').run('failed', reason, now(), id);
    return { status: 'failed', error: reason };
  }
}

export function verifyWebhook(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.slice(7), 'hex'));
}

export function applyWebhook(db, body) {
  const ranks = { pending: 0, accepted: 1, failed: 1, delivered: 2, read: 3 };
  for (const entry of body.entry || []) for (const change of entry.changes || []) for (const status of change.value?.statuses || []) {
    const value = ({ sent: 'accepted', delivered: 'delivered', read: 'read', failed: 'failed' })[status.status];
    if (!value) continue;
    const attempt = db.prepare('SELECT * FROM notifications WHERE message_id=?').get(status.id);
    if (!attempt || ranks[value] < ranks[attempt.status] || (attempt.status === 'failed' && value === 'accepted')) continue;
    const error = value === 'failed' ? 'WhatsApp reported delivery failed. Check the worker’s number and provider dashboard.' : null;
    db.prepare('UPDATE notifications SET status=?,error=?,updated_at=? WHERE id=?').run(value, error, now(), attempt.id);
  }
}
