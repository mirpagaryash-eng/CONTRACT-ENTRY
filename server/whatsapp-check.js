// Read-only sender lookup. This never sends messages or changes the Meta account.
function normalizeNumber(value) {
  if (typeof value !== 'string' || !/^[+\d\s()-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  const normalized = digits.length === 10 && !value.trim().startsWith('+') ? '91' + digits : digits;
  return /^[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function automaticConfiguration(env) {
  let httpsOrigin = false;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    httpsOrigin = url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { /* A public origin has not been configured. */ }
  const missing = [];
  if (!env.WHATSAPP_ACCESS_TOKEN?.trim()) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID || '')) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!httpsOrigin) missing.push('PUBLIC_BASE_URL');
  if (!env.WHATSAPP_TEMPLATE_NAME?.trim()) missing.push('WHATSAPP_TEMPLATE_NAME');
  return { automaticConfigured: missing.length === 0, automaticMissing: missing };
}

export async function checkWhatsAppSender(env = {}, fetchImpl = globalThis.fetch) {
  const base = { numberVerified: false, automaticReady: false, templateApprovalVerified: false, deliveryVerified: false, ...automaticConfiguration(env) };
  const missing = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter(name => !env[name]?.trim());
  const failure = (kind, error, extra = {}) => ({ ...base, ok: false, kind, error, missing: [], ...extra });
  if (missing.length) return failure('configuration', 'Add the missing connection settings securely before checking the sender.', { missing });
  if (!/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID)) return failure('configuration', 'WHATSAPP_PHONE_NUMBER_ID must be the numeric sender ID from Meta, not the mobile number.');
  const version = env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if (!/^v\d+\.\d+$/.test(version)) return failure('configuration', 'WHATSAPP_GRAPH_VERSION must use a version such as v23.0.');
  const expected = env.WHATSAPP_EXPECTED_NUMBER ? normalizeNumber(env.WHATSAPP_EXPECTED_NUMBER) : null;
  if (env.WHATSAPP_EXPECTED_NUMBER && !expected) return failure('configuration', 'WHATSAPP_EXPECTED_NUMBER must be a mobile number with its country code.');
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name`, {
      method: 'GET', headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    if (!response.ok) {
      const code = Number(body?.error?.code);
      return failure('provider', Number.isFinite(code)
        ? `Meta rejected the sender lookup (code ${code}). Check the access token, sender ID and account permissions.`
        : 'Meta rejected the sender lookup. Check the access token, sender ID and account permissions.');
    }
    const number = normalizeNumber(body?.display_phone_number);
    if (!number || String(body?.id) !== env.WHATSAPP_PHONE_NUMBER_ID) return failure('provider', 'Meta did not return the requested sender with a valid display number.');
    if (expected && number !== expected) return failure('sender_mismatch', 'This connection belongs to a different sender number. Check the sender ID before enabling automatic messages.', { expectedNumberMatches: false });
    return {
      ...base, ok: true, numberVerified: true, expectedNumberMatches: expected ? true : null,
      senderMasked: `…${number.slice(-4)}`, missing: [],
      message: 'Sender lookup succeeded. Template approval and message delivery have not been checked.',
    };
  } catch (error) {
    return failure('network', ['TimeoutError', 'AbortError'].includes(error?.name)
      ? 'Meta sender lookup timed out. No message was sent.'
      : 'Meta sender lookup could not complete. Check the network connection and configured access. No message was sent.');
  }
}
