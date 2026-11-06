import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import pg from 'pg';
import httpApi from './http-api.js';
import { createPostgresStore } from './postgres-store.js';

const migrationLock = 461295713;
const schemaVersion = 1;
export class ConfigurationError extends Error {}

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
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !user || !password || !database || url.hash || /[\r\n\0]/.test(env.DATABASE_URL) || /\[YOUR[-_]PASSWORD\]/i.test(password))
    throw new ConfigurationError('Use the complete Supabase Transaction pooler URI and replace its password placeholder. Keep it private.');
  if (typeof env.ADMIN_INVITE_CODE !== 'string' || env.ADMIN_INVITE_CODE.trim().length < 16 || /[\r\n\0]/.test(env.ADMIN_INVITE_CODE))
    throw new ConfigurationError('Set ADMIN_INVITE_CODE to a private setup code with at least 16 characters in Netlify, then deploy again.');
  // Parse fields ourselves: pg connection-string SSL parameters can override
  // an explicit ssl object. Certificate and hostname verification stay enabled
  // even if a copied URI contains sslmode=require or sslmode=disable.
  return {
    host: url.hostname, port: Number(url.port || 5432), user, password, database,
    ssl: { rejectUnauthorized: true },
    max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
    query_timeout: 20000, allowExitOnIdle: true,
    application_name: 'hisab-netlify',
  };
}

export async function initializePostgres(pool, schemaSql) {
  const client = await pool.connect();
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
    throw error;
  } finally { client.release(); }
}

function unavailable(message, request) {
  return new Response(JSON.stringify({ error: message }), {
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
      return unavailable(error instanceof ConfigurationError ? error.message : 'The shared database is unavailable. Ask the owner to check the Supabase project and Netlify DATABASE_URL setting, then try again.', request);
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
