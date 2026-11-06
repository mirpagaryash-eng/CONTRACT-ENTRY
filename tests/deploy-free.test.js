import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accountSubdomain, deployFree, resolveDeploymentAccount, validateDeploymentEnvironment } from '../scripts/deploy-free.js';

const fixture = { CLOUDFLARE_API_TOKEN:'test-only-token', CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32), ADMIN_INVITE_CODE:'test-only-private-setup-code' };

test('GitHub failure annotations name missing settings without printing private values', () => {
  const result = spawnSync(process.execPath,['scripts/deploy-free.js','--preflight'],{
    cwd:new URL('..',import.meta.url), encoding:'utf8',
    env:{...process.env,GITHUB_ACTIONS:'true',CLOUDFLARE_API_TOKEN:fixture.CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID:'',ADMIN_INVITE_CODE:''},
  });
  assert.equal(result.status,2);
  assert.match(result.stderr,/::error title=Deployment settings or access::Missing required environment settings: ADMIN_INVITE_CODE/);
  assert.ok(!result.stderr.includes(fixture.CLOUDFLARE_API_TOKEN));
});

test('free deployment refuses missing settings before any network call', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected deployment request'); };
  try {
    await assert.rejects(deployFree({}), error => error.exitCode === 2 && error.message.includes('CLOUDFLARE_API_TOKEN'));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test('free deployment preflight rejects malformed settings without revealing their values', () => {
  for (const change of [{CLOUDFLARE_ACCOUNT_ID:'invalid-account-value'}, {CLOUDFLARE_API_TOKEN:'invalid\nsecret'}, {ADMIN_INVITE_CODE:'short-secret'}]) {
    assert.throws(() => validateDeploymentEnvironment({...fixture,...change}), error => {
      assert.equal(error.exitCode, 2);
      for (const value of Object.values(change)) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('free deployment preflight makes no external request and prints no credential values', async () => {
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  let calls = 0;
  const output = [];
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected deployment request'); };
  console.log = value => output.push(String(value));
  try {
    await deployFree(fixture, {preflightOnly:true});
    assert.equal(calls, 0);
    assert.match(output.join('\n'), /No network requests/);
    for (const value of Object.values(fixture)) assert.ok(!output.join('\n').includes(value));
  } finally { globalThis.fetch = previousFetch; console.log = previousLog; }
});

test('deployment accepts an omitted account ID and discovers only an unambiguous authorised account', async () => {
  const credentials = validateDeploymentEnvironment({...fixture,CLOUDFLARE_ACCOUNT_ID:''});
  assert.equal(credentials.accountId,null);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url,options) => {
    calls++; assert.equal(options.headers.Authorization,`Bearer ${fixture.CLOUDFLARE_API_TOKEN}`);
    assert.match(url,/\/accounts\?per_page=50&page=1$/);
    return Response.json({success:true,result:[{id:'a'.repeat(32)}],result_info:{total_count:1}});
  };
  try {
    assert.equal(await resolveDeploymentAccount(credentials),'a'.repeat(32));
    assert.equal(await resolveDeploymentAccount({...credentials,accountId:'b'.repeat(32)}),'b'.repeat(32));
    assert.equal(calls,1);
    globalThis.fetch = async () => Response.json({success:true,result:[{id:'a'.repeat(32)},{id:'b'.repeat(32)}],result_info:{total_count:2}});
    await assert.rejects(resolveDeploymentAccount(credentials),/exactly one accessible account/);
  } finally { globalThis.fetch = previous; }
});

test('deployment preserves an existing account subdomain even when initialisation is enabled', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url,options) => {
    calls++; assert.equal(options.method,undefined);
    return Response.json({success:true,result:{subdomain:'existing-account'}});
  };
  try {
    assert.equal(await accountSubdomain(validateDeploymentEnvironment(fixture),{HISAB_INITIALIZE_WORKERS_SUBDOMAIN:'true'}),'existing-account');
    assert.equal(calls,1);
  } finally { globalThis.fetch = previous; }
});

test('only an explicit missing-subdomain response and enabled initialisation can register a free subdomain', async () => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url,options) => {
    requests.push({url,method:options.method,body:options.body});
    if (options.method !== 'PUT') return Response.json({success:false,errors:[{code:10007,message:'Provider detail must not be echoed'}]},{status:404});
    const body = JSON.parse(options.body);
    assert.match(body.subdomain,/^hisab-[a-f\d]{12}$/);
    return Response.json({success:true,result:{subdomain:body.subdomain}});
  };
  try {
    await assert.rejects(accountSubdomain(validateDeploymentEnvironment(fixture)),/free Workers setup/);
    assert.equal(requests.length,1);
    const domain = await accountSubdomain(validateDeploymentEnvironment(fixture),{HISAB_INITIALIZE_WORKERS_SUBDOMAIN:'true'});
    assert.match(domain,/^hisab-[a-f\d]{12}$/);
    assert.equal(requests.filter(r=>r.method==='PUT').length,1);
    globalThis.fetch = async () => Response.json({success:false,errors:[{code:10000,message:'SECRET_PROVIDER_DETAIL'}]},{status:403});
    await assert.rejects(accountSubdomain(validateDeploymentEnvironment(fixture),{HISAB_INITIALIZE_WORKERS_SUBDOMAIN:'true'}),error=> !error.message.includes('SECRET_PROVIDER_DETAIL'));
  } finally { globalThis.fetch = previous; }
});
