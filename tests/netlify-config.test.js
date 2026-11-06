import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetlifyApp, netlifyDatabaseConfig } from '../server/netlify-app.js';

const valid = { DATABASE_URL: 'postgresql://postgres.example:private-test-password@aws-0-test.pooler.supabase.com:6543/postgres', ADMIN_INVITE_CODE: 'private-owner-setup-code' };

test('Netlify parses URI passwords without allowing query parameters to disable TLS verification', () => {
  const config = netlifyDatabaseConfig({ ...valid, DATABASE_URL: valid.DATABASE_URL.replace('private-test-password', 'secret%40word%3Aone%2Ftwo') + '?sslmode=disable' });
  assert.equal(config.password, 'secret@word:one/two');
  assert.equal(config.port, 6543);
  assert.equal(config.user, 'postgres.example');
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.max, 2);
  assert.ok(config.connectionTimeoutMillis <= 10000);
});

test('Netlify rejects missing settings and password placeholders without revealing values', async () => {
  for (const env of [{}, { ...valid, DATABASE_URL: '' }, { ...valid, DATABASE_URL: 'https://example.test/password-secret' }, { ...valid, DATABASE_URL: valid.DATABASE_URL.replace('private-test-password', '[YOUR-PASSWORD]') }, { ...valid, ADMIN_INVITE_CODE: 'short' }]) {
    let contacts = 0;
    const app = createNetlifyApp({ env, pool: { connect() { contacts++; throw new Error('Must not connect.'); } } });
    const response = await app(new Request('https://hisab.test/api/session'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const text = await response.text();
    for (const secret of ['private-test-password', 'password-secret', 'private-owner-setup-code']) assert.ok(!text.includes(secret));
    assert.equal(contacts, 0);
  }
});

test('Netlify returns safe database failures and retries a transient initialization failure', async () => {
  let attempts = 0;
  const app = createNetlifyApp({ env: valid, pool: { async connect() { attempts++; throw new Error('Connection failed with secret password private-test-password'); } } });
  for (let i=0;i<2;i++) {
    const response = await app(new Request('https://hisab.test/api/session'));
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private-test-password'));
  }
  assert.equal(attempts, 2);
});
