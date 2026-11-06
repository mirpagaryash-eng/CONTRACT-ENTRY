import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import httpApi from './http-api.js';
import { createPostgresStore } from './postgres-store.js';

const migrationLock = 461295713;
const schemaVersion = 1;
export class ConfigurationError extends Error {}

class DatabaseStartupError extends Error {
  constructor(stage, cause) { super('Database startup failed.', { cause }); this.stage = stage; }
}

// Never expose a driver's message, URL, username, stack, detail or hint. Only
// these fixed diagnostics cross the public API boundary.
export function describeDatabaseError(error, stage = error?.stage) {
  const seen = new Set(); const pending = [error]; const errors = [];
  while (pending.length && seen.size < 24) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); errors.push(item);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 12));
  }
  const codes = new Set(errors.map(item => item.code).filter(code => typeof code === 'string'));
  const has = (...values) => values.some(value => codes.has(value));
  const matches = pattern => errors.some(item => typeof item.message === 'string' && pattern.test(item.message.slice(0, 2048)));
  let code, message;
  if (has('28P01', '28000')) {
    code = 'DB_AUTH'; message = 'Database sign-in failed. Update DATABASE_URL with the current Supabase database password, then redeploy. The app setup code is a separate value.';
  } else if (has('XX000') && matches(/tenant or user not found/i)) {
    code = 'DB_ENDPOINT'; message = 'Supabase rejected the database username or server. Check the Transaction pooler details in DATABASE_URL, then redeploy.';
  } else if (has('SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID')) {
    code = 'DB_TLS'; message = 'The database TLS certificate could not be verified. Check the provider certificate and DATABASE_CA_CERT setting; certificate verification must stay enabled.';
  } else if (has('ENOTFOUND', 'EAI_AGAIN')) {
    code = 'DB_DNS'; message = 'The database server address could not be found. Check the Transaction pooler hostname in DATABASE_URL.';
  } else if (has('ETIMEDOUT', '57014') || matches(/^(?:query read timeout|timeout exceeded when trying to connect|connection terminated due to connection timeout)$/i)) {
    code = 'DB_TIMEOUT'; message = 'The database connection or setup timed out. Check that the Supabase project is running, then try again.';
  } else if (has('ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', '08001', '08006', '57P01', '57P02', '57P03')) {
    code = 'DB_NETWORK'; message = 'The database server could not be reached. Check that the Supabase project is running and DATABASE_URL uses the Transaction pooler.';
  } else if (has('42501')) {
    code = 'DB_PERMISSION'; message = 'The database connected, but setup is not permitted. Use the owner-level Supabase PostgreSQL connection for initialization.';
  } else if (stage === 'schema' && has('ENOENT')) {
    code = 'DB_SCHEMA_FILE'; message = 'The deployment is missing its database setup file. Redeploy the latest repository version.';
  } else if (stage === 'schema') {
    code = 'DB_SCHEMA'; message = 'The database connected, but automatic setup failed. The deployment needs its setup code checked before retrying.';
    const sqlCode = ['42601', '42P01', '42703', '42704', '42P07', '42710', '0A000', '3F000', '23514', '25P02', '55000', '53300', '53400', 'XX000'].find(value => codes.has(value));
    if (sqlCode) message += ` PostgreSQL diagnostic: ${sqlCode}.`;
  } else {
    code = 'DB_UNAVAILABLE'; message = 'The database connection failed. Check the hosting settings and Supabase project status.';
  }
  return { code, message: `${message} (${code})` };
}

function databaseCertificates(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ConfigurationError('DATABASE_CA_CERT must contain the provider public certificate in PEM format.');
  const pem = value.trim().replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n');
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  try {
    if (!certificates.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch { throw new ConfigurationError('DATABASE_CA_CERT must contain only valid provider public PEM certificates, never a private key.'); }
  return [...getCACertificates('default'), ...certificates];
}

/** Parse private server settings without logging them or weakening TLS. */
export function netlifyDatabaseConfig(env) {
  if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim())
    throw new ConfigurationError('Set DATABASE_URL in the Netlify environment settings, then deploy again.');
  let url;
  try { url = new URL(env.DATABASE_URL.trim()); }
  catch { throw new ConfigurationError('DATABASE_URL must be the complete Supabase Transaction pooler connection URI.'); }
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new ConfigurationError('The database connection URI contains invalid URL escaping. Copy the URI from Supabase Connect.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hostname === 'hidden' || !user || user === 'hidden' || !password || !database || url.hash || /[\r\n\0]/.test(env.DATABASE_URL) || /\[YOUR[-_]PASSWORD\]/i.test(password))
    throw new ConfigurationError('Use the complete Supabase Transaction pooler URI and replace its password placeholder. Keep it private.');
  if (typeof env.ADMIN_INVITE_CODE !== 'string' || env.ADMIN_INVITE_CODE.trim().length < 16 || /[\r\n\0]/.test(env.ADMIN_INVITE_CODE))
    throw new ConfigurationError('Set ADMIN_INVITE_CODE to a private setup code with at least 16 characters in Netlify, then deploy again.');
  // Parse fields ourselves: pg connection-string SSL parameters can override
  // an explicit ssl object. Certificate and hostname verification stay enabled
  // even if a copied URI contains sslmode=require or sslmode=disable.
  const certificates = databaseCertificates(env.DATABASE_CA_CERT);
  return {
    host: url.hostname, port: Number(url.port || 5432), user, password, database,
    ssl: { rejectUnauthorized: true, ...(certificates ? { ca: certificates } : {}) },
    max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
    query_timeout: 20000, allowExitOnIdle: true,
    application_name: 'hisab-netlify',
  };
}

export async function initializePostgres(pool, schemaSql) {
  let client;
  try { client = await pool.connect(); }
  catch (error) { throw new DatabaseStartupError('connection', error); }
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    // Transaction-scoped, including on Supabase's shared transaction pooler.
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
    const exists = await client.query("SELECT to_regclass('hisab.state') AS relation");
    let version = null;
    if (exists.rows[0]?.relation) {
      const result = await client.query('SELECT schema_version FROM hisab.state WHERE id=1');
      version = result.rows[0]?.schema_version ?? null;
    }
    if (version !== null && version !== schemaVersion)
      throw new Error('The database schema version is not supported by this deployment.');
    if (version === null) {
      const source = schemaSql ?? await readFile(resolve(process.cwd(), 'supabase/schema.sql'), 'utf8');
      await client.query(source);
    }
    await client.query('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve original failure. */ }
    }
    throw new DatabaseStartupError('schema', error);
  } finally { client.release(); }
}

function unavailable(message, request, code) {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...(new URL(request.url).protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    },
  });
}

/** One instance per warm Netlify function. No money or messages in setup. */
export function createNetlifyApp({ env = process.env, pool: suppliedPool, schemaSql } = {}) {
  let pool = suppliedPool;
  let ready = null;
  let store;
  const prepare = () => {
    if (!ready) ready = (async () => {
      const config = netlifyDatabaseConfig(env);
      if (!pool) {
        pool = new pg.Pool(config);
        // Driver messages can include secrets; do not log idle-client errors.
        pool.on('error', () => {});
      }
      await initializePostgres(pool, schemaSql);
      store = createPostgresStore(pool);
    })().catch(error => { ready = null; throw error; });
    return ready;
  };
  return async (request, context = {}) => {
    try { await prepare(); }
    catch (error) {
      if (error instanceof ConfigurationError) return unavailable(error.message, request);
      const diagnostic = describeDatabaseError(error);
      return unavailable(diagnostic.message, request, diagnostic.code);
    }
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
    const headers = new Headers(request.headers);
    // Trust only provider context for rate limits, never a client CF header.
    headers.delete('CF-Connecting-IP');
    headers.set('CF-Connecting-IP', typeof context.ip === 'string' && isIP(context.ip) ? context.ip : 'local');
    const forwarded = new Request(url, { ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { duplex: 'half' } : {}), method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, signal: request.signal });
    return httpApi.fetch(forwarded, { DB: store, ADMIN_INVITE_CODE: env.ADMIN_INVITE_CODE });
  };
}
