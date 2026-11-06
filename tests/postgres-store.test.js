import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { compilePostgresStatement, createPostgresStore } from '../server/postgres-store.js';

let database;
let store;
let pool;
const releases = [];

before(async () => {
  database = new PGlite();
  await database.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  const query = async (text, values) => {
    const result = await database.query(text, values);
    return { ...result, rowCount: result.affectedRows };
  };
  pool = { query, async connect() { return { query, release() { releases.push(true); } }; } };
  store = createPostgresStore(pool);
});
after(async () => { await database?.close(); });

function insertWorker(id, phone, name = 'Test Worker') {
  return store.prepare('INSERT INTO workers(id,name,phone,contract,share_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, name, phone, 'SANJYOT', id.padEnd(64, '0'), '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
}

test('PostgreSQL SQL translation preserves quoted text and comments while binding actual placeholders', () => {
  const compiled = compilePostgresStatement("SELECT '?' AS \"?\", $$? FROM workers$$ AS a, E'can\\'t ?' AS b FROM /* ? /* nested */ */ workers WHERE name=? -- ?\n AND phone=?;");
  assert.equal(compiled.parameters, 2);
  assert.equal(compiled.text, "SELECT '?' AS \"?\", $$? FROM workers$$ AS a, E'can\\'t ?' AS b FROM /* ? /* nested */ */ hisab.workers WHERE name=$1 -- ?\n AND phone=$2;");
  assert.equal(compilePostgresStatement('SELECT * FROM "workers" JOIN hisab.owner ON owner.id=1').text, 'SELECT * FROM hisab."workers" JOIN hisab.owner ON owner.id=1');
  assert.equal(compilePostgresStatement('UPDATE workers SET name=? WHERE id=?').text, 'UPDATE hisab.workers SET name=$1 WHERE id=$2');
  for (const sql of ["SELECT 'unclosed", 'SELECT /* unclosed', 'SELECT $tag$unclosed', 'SELECT 1; DELETE FROM workers', 'SELECT $1']) {
    assert.throws(() => compilePostgresStatement(sql), TypeError, sql);
  }
});

test('PostgreSQL statements isolate app tables from public and never interpolate worker input', async () => {
  await database.exec('CREATE TABLE public.workers (id TEXT PRIMARY KEY, name TEXT); INSERT INTO public.workers VALUES(\'shadow\',\'Wrong database table\');');
  const hostile = "Mallory'); DROP TABLE hisab.owner; -- ?";
  const result = await insertWorker('bound-worker', '919000000031', hostile).run();
  assert.equal(result.meta.changes, 1);
  assert.equal((await store.prepare('SELECT * FROM workers WHERE id=?').bind('bound-worker').first()).name, hostile);
  assert.equal(await store.prepare('SELECT COUNT(*) AS count FROM owner').first('count'), 0);
  assert.equal(await store.prepare('SELECT * FROM workers WHERE id=?').bind('shadow').first(), null);
  assert.equal((await database.query('SELECT name FROM public.workers')).rows[0].name, 'Wrong database table');
  assert.throws(() => store.prepare('SELECT ?').bind(), /bindings/i);
  assert.throws(() => store.prepare('SELECT ?').bind(undefined), /bindings/i);
  await assert.rejects(store.prepare('SELECT ?').first(), /bindings/i);
});

test('PostgreSQL batch rolls back earlier changes and trigger audit when a later mutation fails', async () => {
  const audits = await store.prepare('SELECT COUNT(*) AS count FROM audit').first('count');
  const released = releases.length;
  await assert.rejects(store.batch([
    insertWorker('rolled-back-worker', '919000000032'),
    store.prepare('INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)').bind('rolled-back-session', 'csrf', 1_999_999_999_999),
    insertWorker('duplicate-worker', '919000000031'),
  ]), /UNIQUE constraint failed: workers\.phone/);
  assert.equal(releases.length, released + 1);
  assert.equal(await store.prepare('SELECT * FROM workers WHERE id=?').bind('rolled-back-worker').first(), null);
  assert.equal(await store.prepare('SELECT * FROM sessions WHERE token_hash=?').bind('rolled-back-session').first(), null);
  assert.equal(await store.prepare('SELECT COUNT(*) AS count FROM audit').first('count'), audits);
  const successful = await store.batch([
    store.prepare('INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)').bind('committed-session', 'csrf', 1_999_999_999_999),
    store.prepare('UPDATE sessions SET csrf=? WHERE token_hash=?').bind('changed', 'committed-session'),
  ]);
  assert.deepEqual(successful.map(result => result.meta.changes), [1, 1]);
  assert.equal(await store.prepare('SELECT csrf FROM sessions WHERE token_hash=?').bind('committed-session').first('csrf'), 'changed');
  await assert.rejects(store.batch([createPostgresStore(pool).prepare('SELECT 1')]), /prepared by this database/);
});

test('PostgreSQL int8 sums and timestamps stay exact without converting phone strings', async () => {
  const row = await store.prepare('SELECT ?::bigint AS "exactValue", ?::text AS phone').bind(Number.MAX_SAFE_INTEGER, '0919000000031').first();
  assert.equal(row.exactValue, Number.MAX_SAFE_INTEGER);
  assert.equal(row.phone, '0919000000031');
  assert.equal(typeof await store.prepare('SELECT COUNT(*) AS count FROM workers').first('count'), 'number');
  assert.equal(await store.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').bind('committed-session').first('expires_at'), 1_999_999_999_999);
  await assert.rejects(store.prepare('SELECT 9223372036854775807::bigint AS value').first(), /exact range/);
  await assert.rejects(store.prepare('SELECT (-9223372036854775807)::bigint AS value').first(), /exact range/);
});

test('PostgreSQL preserves the API rate-limit upsert semantics', async () => {
  const statement = store.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count');
  assert.equal((await statement.bind('login-attempt', 2000, 1000, 1000).first()).count, 1);
  assert.equal((await statement.bind('login-attempt', 2500, 1500, 1500).first()).count, 2);
  assert.equal((await statement.bind('login-attempt', 4000, 3000, 3000).first()).count, 1);
});
