import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { createNetlifyApp, describeDatabaseError, netlifyDatabaseConfig } from '../server/netlify-app.js';

const secret = 'synthetic-private-test-secret';
const privateHost = 'private-db.example.invalid';
const privateUri = `postgresql://private-user:${secret}@${privateHost}:6543/private-db`;
const env = { DATABASE_URL: privateUri, ADMIN_INVITE_CODE: 'synthetic-private-owner-code' };

function failure(code, message = `Driver rejected ${privateUri}; password=${secret}`) {
  return Object.assign(new Error(message), {
    code,
    detail: `Private driver detail ${secret}`,
    hint: `Private driver hint ${privateHost}`,
    stack: `private-driver-stack ${privateUri}`,
  });
}

function assertSafe(value) {
  const serialized = JSON.stringify(value);
  for (const privateValue of [secret, privateHost, privateUri, 'private-user', 'private-driver-stack', env.ADMIN_INVITE_CODE])
    assert.ok(!serialized.includes(privateValue), 'A public startup diagnostic must not include driver details or private settings.');
}

function failurePool(error, stage) {
  let released = 0;
  let rollbacks = 0;
  return {
    get released() { return released; },
    get rollbacks() { return rollbacks; },
    async connect() {
      if (stage === 'connection') throw error;
      return {
        async query(sql) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'ROLLBACK') { rollbacks++; return { rows: [] }; }
          throw error;
        },
        release() { released++; },
      };
    },
  };
}

test('Database diagnostics identify authentication, endpoint and DNS failures without returning provider details', () => {
  const cases = [
    [failure('28P01'), 'DB_AUTH'],
    [failure('XX000', `Tenant or user not found: ${privateUri}`), 'DB_ENDPOINT'],
    [failure('ENOTFOUND'), 'DB_DNS'],
  ];
  for (const [error, code] of cases) {
    const diagnostic = describeDatabaseError(error, 'connection');
    assert.equal(diagnostic.code, code);
    assert.equal(typeof diagnostic.message, 'string');
    assert.ok(diagnostic.message.length > 10);
    assertSafe(diagnostic);
  }
});

test('Database diagnostics distinguish TLS trust, network and timeout failures', () => {
  const cases = [
    [failure('SELF_SIGNED_CERT_IN_CHAIN'), 'DB_TLS'],
    [failure('ERR_TLS_CERT_ALTNAME_INVALID'), 'DB_TLS'],
    [failure('ECONNREFUSED'), 'DB_NETWORK'],
    [failure('ETIMEDOUT'), 'DB_TIMEOUT'],
    [new AggregateError([failure('ENETUNREACH')], `Connection attempts failed for ${privateUri}`), 'DB_NETWORK'],
  ];
  for (const [error, code] of cases) {
    const diagnostic = describeDatabaseError(error, 'connection');
    assert.equal(diagnostic.code, code);
    assertSafe(diagnostic);
    if (code === 'DB_TLS') assert.doesNotMatch(diagnostic.message, /rejectUnauthorized\s*[:=]\s*false|disable\s+(?:certificate\s+)?verification/i);
  }
});

test('Database diagnostics identify schema permissions, missing deployment files and SQL failures', () => {
  for (const [error, code] of [[failure('42501'), 'DB_PERMISSION'], [failure('ENOENT'), 'DB_SCHEMA_FILE'], [failure('42601'), 'DB_SCHEMA']]) {
    const diagnostic = describeDatabaseError(error, 'schema');
    assert.equal(diagnostic.code, code);
    assertSafe(diagnostic);
  }
  const unknownSchema = describeDatabaseError(failure('UNKNOWN'), 'schema');
  assert.equal(unknownSchema.code, 'DB_SCHEMA', 'The initialization stage must distinguish an unrecognized schema failure from a connection failure.');
  assertSafe(unknownSchema);
});

test('Unknown database errors cannot reflect arbitrary error codes, messages, causes or stacks', () => {
  const error = failure(secret);
  error.cause = error;
  const diagnostic = describeDatabaseError(error, 'connection');
  assert.equal(diagnostic.code, 'DB_UNAVAILABLE');
  assertSafe(diagnostic);
  assertSafe(describeDatabaseError({ message: privateUri, detail: secret }, 'connection'));
});

test('Netlify startup responds with safe actionable diagnostics while connection failures remain retryable', async () => {
  const cases = [
    [failure('28P01'), 'DB_AUTH'],
    [failure('ENOTFOUND'), 'DB_DNS'],
    [failure('SELF_SIGNED_CERT_IN_CHAIN'), 'DB_TLS'],
    [failure('XX000', `Tenant or user not found: ${privateUri}`), 'DB_ENDPOINT'],
    [new AggregateError([failure('ENETUNREACH')], privateUri), 'DB_NETWORK'],
    [failure('UNKNOWN'), 'DB_UNAVAILABLE'],
  ];
  for (const [error, code] of cases) {
    let attempts = 0;
    const app = createNetlifyApp({ env, pool: { async connect() { attempts++; throw error; } } });
    for (let i=0; i<2; i++) {
      const response = await app(new Request('https://hisab.test/api/session'));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = await response.json();
      assert.equal(body.code, code);
      assert.equal(typeof body.error, 'string');
      assertSafe(body);
      assertSafe([...response.headers]);
    }
    assert.equal(attempts, 2);
  }
});

test('Netlify distinguishes migration failures after connecting and releases the failed transaction', async () => {
  for (const [error, code] of [[failure('42501'), 'DB_PERMISSION'], [failure('ENOENT'), 'DB_SCHEMA_FILE'], [failure('42601'), 'DB_SCHEMA']]) {
    const pool = failurePool(error, 'schema');
    const app = createNetlifyApp({ env, pool });
    const response = await app(new Request('https://hisab.test/api/health'));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, code);
    assertSafe(body);
    assert.equal(pool.released, 1);
    assert.equal(pool.rollbacks, 1);
  }
});

test('A supplied database CA extends trusted roots while keeping certificate verification enabled', () => {
  const certificate = rootCertificates[0];
  for (const value of [certificate, certificate.replaceAll('\n', '\\n')]) {
    const config = netlifyDatabaseConfig({ ...env, DATABASE_CA_CERT: value });
    assert.equal(config.ssl.rejectUnauthorized, true);
    const trusted = Array.isArray(config.ssl.ca) ? config.ssl.ca.join('\n') : config.ssl.ca;
    assert.equal(typeof trusted, 'string');
    assert.ok(trusted.includes(certificate.trim()), 'The supplied PEM must be normalized and trusted.');
    assert.ok(trusted.includes(rootCertificates[1].trim()), 'Other existing public roots must stay trusted.');
  }
});

test('Invalid database CA settings fail before connection without revealing certificate input or private-key text', async () => {
  const invalidValues = [
    `not-a-certificate-${secret}`,
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    `-----BEGIN CERTIFICATE-----\n${secret}\n-----END CERTIFICATE-----`,
  ];
  for (const DATABASE_CA_CERT of invalidValues) {
    assert.throws(() => netlifyDatabaseConfig({ ...env, DATABASE_CA_CERT }));
    let attempts = 0;
    const app = createNetlifyApp({ env: { ...env, DATABASE_CA_CERT }, pool: { async connect() { attempts++; throw failure('SHOULD_NOT_CONNECT'); } } });
    const response = await app(new Request('https://hisab.test/api/session'));
    assert.equal(response.status, 503);
    const body = await response.json();
    assertSafe(body);
    assert.ok(!JSON.stringify(body).includes('BEGIN PRIVATE KEY'));
    assert.equal(attempts, 0);
  }
});
