import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = 'https://api.cloudflare.com/client/v4';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function tokenValue(value) {
  let token = value.trim();
  const unquote = text => text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) ? text.slice(1,-1).trim() : text;
  token = unquote(token);
  token = token.replace(/^Bearer\s+/i,'').trim();
  return unquote(token);
}

/** Pure preflight: no filesystem access, remote calls, or secret output. */
export function validateDeploymentEnvironment(env) {
  const required = ['CLOUDFLARE_API_TOKEN', 'ADMIN_INVITE_CODE'];
  const missing = required.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) fail(`Missing required environment settings: ${missing.join(', ')}. Enter them in secure environment settings; do not send values in chat.`, 2);
  if (env.CLOUDFLARE_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)) fail('CLOUDFLARE_ACCOUNT_ID must contain exactly 32 hexadecimal characters.', 2);
  if (/[\r\n\0]/.test(env.CLOUDFLARE_API_TOKEN)) fail('CLOUDFLARE_API_TOKEN must be a single-line value.', 2);
  const token = tokenValue(env.CLOUDFLARE_API_TOKEN);
  if (!token) fail('CLOUDFLARE_API_TOKEN must contain the token value copied from Cloudflare.',2);
  if (env.ADMIN_INVITE_CODE.trim().length < 16 || /[\r\n\0]/.test(env.ADMIN_INVITE_CODE)) fail('ADMIN_INVITE_CODE must be a single-line private code with at least 16 characters.', 2);
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID || null, token, inviteCode: env.ADMIN_INVITE_CODE };
}

function redact(text, credentials) {
  let result = String(text || '');
  for (const value of [credentials.token, credentials.inviteCode]) result = result.split(value).join('[redacted]');
  return result;
}

function command(commandName, args, { env, credentials, input } = {}) {
  const result = spawnSync(commandName, args, {
    cwd: repositoryRoot,
    env: { ...env, CLOUDFLARE_API_TOKEN: credentials.token, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Capture before printing, so credentials split across output chunks are redacted.
  if (result.stdout) process.stdout.write(redact(result.stdout, credentials));
  if (result.stderr) process.stderr.write(redact(result.stderr, credentials));
  if (result.error || result.status !== 0) fail('A local build or Wrangler command failed. Existing database contents were retained. Correct the reported configuration/access problem, then rerun the deployment.');
}

async function cloudflareRequest(credentials, path, options = {}, operation = 'Cloudflare request') {
  let response;
  try {
    response = await fetch(`${apiRoot}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`${operation} could not reach api.cloudflare.com. Check the configured HTTPS proxy, network allowlist and Cloudflare access, then retry.`);
  }
  let body;
  try { body = await response.json(); } catch { fail(`${operation} returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok || body.success !== true) {
    const codes = Array.isArray(body.errors) ? body.errors.map((error) => Number(error.code)).filter(Number.isFinite) : [];
    if (codes.includes(6003)) fail('Cloudflare rejected the authentication header (6003). Update repository secret CLOUDFLARE_API_TOKEN with only the token value copied from Cloudflare’s token-created screen. A token name, example command or Global API Key is not the custom API token value. No plan upgrade or billing operation was requested.');
    const error = new Error(`${operation} failed (HTTP ${response.status}${codes.length ? `; Cloudflare codes ${codes.join(', ')}` : ''}). Check account-scoped Workers Scripts Edit, D1 Edit and, if required, Account Settings Read permissions. No plan upgrade or billing operation was requested.`);
    error.exitCode = 1; error.apiCodes = codes; throw error;
  }
  return body;
}

export async function resolveDeploymentAccount(credentials) {
  if (credentials.accountId) return credentials.accountId;
  const body = await cloudflareRequest(credentials, '/accounts?per_page=50&page=1', {}, 'Finding the authorised Cloudflare account');
  if (!Array.isArray(body.result) || body.result.length !== 1 || Number(body.result_info?.total_count || body.result.length) !== 1 || !/^[0-9a-f]{32}$/i.test(body.result[0]?.id || '')) {
    fail('The token does not identify exactly one accessible account. Set CLOUDFLARE_ACCOUNT_ID to the intended Account ID, or scope the token to only that account. No cloud resources were changed.');
  }
  return body.result[0].id;
}

export async function accountSubdomain(credentials, env = {}) {
  let body;
  try {
    body = await cloudflareRequest(credentials, `/accounts/${credentials.accountId}/workers/subdomain`, {}, 'Reading the workers.dev subdomain');
  } catch (error) {
    if (!error.apiCodes?.includes(10007)) throw error;
    if (env.HISAB_INITIALIZE_WORKERS_SUBDOMAIN !== 'true') fail('Complete the account’s free Workers setup in Cloudflare, or explicitly enable HISAB_INITIALIZE_WORKERS_SUBDOMAIN for this deployment. Existing subdomains are never replaced.');
    const suffix = createHash('sha256').update(credentials.accountId).digest('hex').slice(0, 12);
    body = await cloudflareRequest(credentials, `/accounts/${credentials.accountId}/workers/subdomain`, {
      method:'PUT', body:JSON.stringify({subdomain:`hisab-${suffix}`}),
    }, 'Registering the free workers.dev subdomain');
  }
  const subdomain = body.result?.subdomain;
  if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain)) {
    fail('Cloudflare did not return a valid workers.dev subdomain. Check the account’s Workers setup; no existing subdomain was replaced.');
  }
  return subdomain.toLowerCase();
}

async function reuseOrCreateDatabase(credentials, databaseName) {
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await cloudflareRequest(credentials, `/accounts/${credentials.accountId}/d1/database?per_page=100&page=${page}`, {}, 'Listing D1 databases');
    if (!Array.isArray(body.result)) fail('Cloudflare returned an unexpected D1 database list. No database was created or removed.');
    matches.push(...body.result.filter((database) => database.name === databaseName));
    const pages = Number(body.result_info?.total_pages);
    if ((Number.isFinite(pages) && page >= pages) || body.result.length < 100) break;
    if (page === 100) fail('The D1 database listing could not be completed. No replacement database was created.');
  }
  if (matches.length > 1) fail('More than one D1 database has the configured exact name. Resolve the ambiguity in Cloudflare before deploying; existing data has not been changed.');
  const database = matches[0] || (await cloudflareRequest(credentials, `/accounts/${credentials.accountId}/d1/database`, {
    method: 'POST', body: JSON.stringify({ name: databaseName }),
  }, 'Creating the D1 database')).result;
  const databaseId = database?.uuid || database?.id;
  if (typeof databaseId !== 'string' || !uuidPattern.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)) fail('Cloudflare did not return a valid D1 database identifier. Any created database was retained; inspect the account before retrying.');
  return databaseId;
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function deployFree(env = process.env, { preflightOnly = false } = {}) {
  const credentials = validateDeploymentEnvironment(env);
  if (preflightOnly) {
    console.log('Preflight passed: required settings are present. No network requests were made and no app was deployed.');
    return;
  }
  // The checked-in .jsonc is deliberately also valid JSON. Its settings remain
  // intact; only account/binding IDs and paths change in an ignored local copy.
  const base = JSON.parse(await readFile(resolve(repositoryRoot, 'wrangler.jsonc'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(base.name || '') || base.workers_dev !== true) fail('wrangler.jsonc needs a valid Worker name and workers_dev: true.');
  const bindings = base.d1_databases;
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0].binding !== 'DB' || !bindings[0].database_name) fail('wrangler.jsonc must define exactly one D1 database bound as DB.');
  if (base.usage_model || base.r2_buckets?.length) fail('The free deployment does not enable a usage model or R2. Remove paid/add-on configuration before deploying.');
  console.log('Building the application before creating or changing Cloudflare resources.');
  command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { env, credentials });
  credentials.accountId = await resolveDeploymentAccount(credentials);
  const subdomain = await accountSubdomain(credentials, env);
  const databaseId = await reuseOrCreateDatabase(credentials, bindings[0].database_name);
  const configPath = resolve(repositoryRoot, '.data/wrangler.production.json');
  const absolutePath = (path) => isAbsolute(path) ? path : resolve(repositoryRoot, path);
  const production = {
    ...base,
    ...(typeof base.$schema === 'string' && !/^https?:\/\//.test(base.$schema) ? { $schema: absolutePath(base.$schema) } : {}),
    account_id: credentials.accountId,
    main: absolutePath(base.main),
    assets: { ...base.assets, directory: absolutePath(base.assets.directory) },
    d1_databases: [{ ...bindings[0], database_id: databaseId }],
  };
  await writePrivateJson(configPath, production);
  const wrangler = resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js');
  const runWrangler = (args, input) => command(process.execPath, ['--use-env-proxy', wrangler, ...args], { env, credentials, input });
  console.log('Applying the additive schema to the named D1 database. Existing records are retained.');
  runWrangler(['d1', 'execute', 'DB', '--remote', '--file', resolve(repositoryRoot, 'cloudflare/schema.sql'), '--config', configPath, '--yes']);
  console.log('Deploying the Worker and static assets. Owner setup stays blocked until its private code is installed.');
  runWrangler(['deploy', '--config', configPath]);
  console.log('Installing the owner setup code as a Worker secret.');
  runWrangler(['secret', 'put', 'ADMIN_INVITE_CODE', '--config', configPath], `${credentials.inviteCode}\n`);
  const baseUrl = `https://${base.name}.${subdomain}.workers.dev`;
  await writePrivateJson(resolve(repositoryRoot, '.data/deployment.json'), {
    workerName: base.name,
    databaseName: bindings[0].database_name,
    databaseId,
    baseUrl,
    deployedAt: new Date().toISOString(),
    verification: 'not_run',
  });
  console.log(`Deployment commands completed. App address: ${baseUrl}`);
  console.log('Live application checks have not run yet. Verify the owner/worker workflow over HTTPS before calling this deployment ready. No billing or plan-upgrade operation was requested.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--preflight')) {
    console.error('Only --preflight is supported. Configure credentials in secure environment settings, never command-line arguments.');
    process.exitCode = 2;
  } else {
    try { await deployFree(process.env, { preflightOnly: args.includes('--preflight') }); }
    catch (error) {
      // API response bodies and subprocess arguments may contain secrets. Only
      // our own diagnostic messages are surfaced; never print stack traces.
      const credentials = { token: process.env.CLOUDFLARE_API_TOKEN || '\0', inviteCode: process.env.ADMIN_INVITE_CODE || '\0' };
      const message = redact(error instanceof SyntaxError ? 'wrangler.jsonc must remain valid JSON for this deployment helper.' : error.message || 'Deployment failed.', credentials);
      if (process.env.GITHUB_ACTIONS === 'true') {
        const escaped = message.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
        console.error(`::error title=Deployment settings or access::${escaped}`);
      } else console.error(message);
      process.exitCode = error.exitCode || 1;
    }
  }
}
