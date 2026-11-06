import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWhatsAppSender } from '../server/whatsapp-check.js';

const settings = { WHATSAPP_ACCESS_TOKEN: 'synthetic-test-token', WHATSAPP_PHONE_NUMBER_ID: '123456789' };
const sender = { id: settings.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+1 (202) 555-0101', verified_name: 'Test Sender' };

test('sender check reports missing or invalid settings without a provider request', async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('Unexpected provider request'); };
  const missing = await checkWhatsAppSender({}, fetch);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  assert.equal((await checkWhatsAppSender({ ...settings, WHATSAPP_PHONE_NUMBER_ID: 'not-an-id' }, fetch)).kind, 'configuration');
  assert.equal((await checkWhatsAppSender({ ...settings, WHATSAPP_GRAPH_VERSION: '../messages' }, fetch)).kind, 'configuration');
  assert.equal((await checkWhatsAppSender({ ...settings, WHATSAPP_EXPECTED_NUMBER: 'invalid' }, fetch)).kind, 'configuration');
  assert.equal(calls, 0);
});

test('sender lookup is GET-only and does not assume template approval or delivery', async () => {
  const calls = [];
  const result = await checkWhatsAppSender(settings, async (url, init) => { calls.push({ url, init }); return Response.json(sender); });
  assert.equal(result.ok, true);
  assert.equal(result.numberVerified, true);
  assert.equal(result.senderMasked, '…0101');
  assert.equal(result.expectedNumberMatches, null);
  assert.equal(result.automaticConfigured, false);
  assert.equal(result.automaticReady, false);
  assert.equal(result.templateApprovalVerified, false);
  assert.equal(result.deliveryVerified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/123456789?fields=id,display_phone_number,verified_name');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${settings.WHATSAPP_ACCESS_TOKEN}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(result).includes(settings.WHATSAPP_ACCESS_TOKEN));
  assert.ok(!JSON.stringify(result).includes(sender.verified_name));
});

test('sender check normalizes the expected Indian number and keeps configuration distinct from verified readiness', async () => {
  const env = { ...settings, WHATSAPP_EXPECTED_NUMBER: '9000000011', PUBLIC_BASE_URL: 'https://hisab.example', WHATSAPP_TEMPLATE_NAME: 'advance_entry' };
  const result = await checkWhatsAppSender(env, async () => Response.json({ ...sender, display_phone_number: '+91 90000 00011' }));
  assert.equal(result.ok, true);
  assert.equal(result.expectedNumberMatches, true);
  assert.equal(result.automaticConfigured, true);
  assert.equal(result.automaticReady, false);
  assert.equal(result.templateApprovalVerified, false);
  const international = await checkWhatsAppSender({ ...settings, WHATSAPP_EXPECTED_NUMBER: '+6581234567' }, async () => Response.json({ ...sender, display_phone_number: '+65 8123 4567' }));
  assert.equal(international.expectedNumberMatches, true);
});

test('sender mismatch or unexpected account response prevents a successful check', async () => {
  const mismatch = await checkWhatsAppSender({ ...settings, WHATSAPP_EXPECTED_NUMBER: '+12025550102' }, async () => Response.json(sender));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.kind, 'sender_mismatch');
  assert.equal(mismatch.expectedNumberMatches, false);
  const wrongId = await checkWhatsAppSender(settings, async () => Response.json({ ...sender, id: '987654321' }));
  assert.equal(wrongId.ok, false);
  const absentNumber = await checkWhatsAppSender(settings, async () => Response.json({ id: sender.id }));
  assert.equal(absentNumber.ok, false);
});

test('provider, timeout and network errors return sanitized metadata', async () => {
  const provider = await checkWhatsAppSender(settings, async () => Response.json({ error: { code: 190, message: 'PRIVATE_RAW_ERROR ' + settings.WHATSAPP_ACCESS_TOKEN } }, { status: 401 }));
  assert.equal(provider.ok, false);
  assert.match(provider.error, /190/);
  assert.ok(!JSON.stringify(provider).includes('PRIVATE_RAW_ERROR'));
  assert.ok(!JSON.stringify(provider).includes(settings.WHATSAPP_ACCESS_TOKEN));
  const timeout = await checkWhatsAppSender(settings, async () => { throw new DOMException('secret raw timeout', 'TimeoutError'); });
  assert.match(timeout.error, /timed out/);
  const network = await checkWhatsAppSender(settings, async () => { throw new Error('secret raw connection details'); });
  assert.equal(network.kind, 'network');
  assert.ok(!JSON.stringify(network).includes('secret raw'));
});
